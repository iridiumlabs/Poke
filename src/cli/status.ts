import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager } from '../config/config.js';
import { resolvePokePaths } from '../config/paths.js';
import { ACTIVE_COMPACTION_TOKEN_THRESHOLD, IDLE_COMPACTION_TOKEN_THRESHOLD } from '../context/compaction-manager.js';
import { inspectReadOnlyDatabase } from '../db/readonly.js';
import { readDaemonPidFile, isLivePokeDaemon } from '../daemon/pid-file.js';
import { readGatewayRuntimeStatus } from '../gateway/runtime-status.js';
import { redactSecrets } from '../logger/logger.js';
import { resolvePokeInstallationPaths } from '../config/installation.js';

interface StatusDatabaseSnapshot {
  approximateTokens: number;
  lastActivityTime?: number;
  agentBusy: boolean;
  runningWorkers: number;
  queuedWorkers: number;
  enabledAutomations: number;
  totalAutomations: number;
  nextAutomation?: { name: string; nextRunAt: number };
  lastError?: { source: string; message: string; createdAt: number };
}

function parseFiniteTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  const time = new Date(num).getTime();
  return Number.isFinite(time) ? num : undefined;
}

async function readStatusDatabase(sqliteFile: string): Promise<StatusDatabaseSnapshot | null> {
  return await inspectReadOnlyDatabase(sqliteFile, (database) => {
    const state = (key: string) => {
      try {
        return (database.prepare('SELECT value FROM state_kv WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
      } catch {
        return undefined;
      }
    };
    const count = (query: string) => {
      try {
        return Number((database.prepare(query).get() as { count?: number } | undefined)?.count || 0);
      } catch {
        return 0;
      }
    };
    let next: { name?: string; next_run_at?: number } | undefined;
    try {
      next = database
        .prepare('SELECT name, next_run_at FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at ASC LIMIT 1')
        .get() as { name?: string; next_run_at?: number } | undefined;
    } catch {
      // Table missing or corrupt
    }
    let lastError: { source?: string; message?: string; created_at?: number } | undefined;
    try {
      lastError = database
        .prepare('SELECT source, message, created_at FROM operational_errors ORDER BY created_at DESC LIMIT 1')
        .get() as { source?: string; message?: string; created_at?: number } | undefined;
    } catch {
      // Table missing or corrupt
    }

    const lastActivityTime = parseFiniteTimestamp(state('last_activity_time'));
    const nextRunAt = parseFiniteTimestamp(next?.next_run_at);
    const lastErrorCreatedAt = parseFiniteTimestamp(lastError?.created_at);
    const approximateTokensValue = Number(state('approximate_tokens') || 0);

    return {
      approximateTokens: Number.isFinite(approximateTokensValue) ? approximateTokensValue : 0,
      ...(lastActivityTime !== undefined ? { lastActivityTime } : {}),
      agentBusy: state('main_agent_busy') === 'true',
      runningWorkers: count("SELECT COUNT(*) AS count FROM worker_jobs WHERE status = 'running'"),
      queuedWorkers: count("SELECT COUNT(*) AS count FROM worker_jobs WHERE status = 'queued'"),
      enabledAutomations: count('SELECT COUNT(*) AS count FROM automations WHERE enabled = 1'),
      totalAutomations: count('SELECT COUNT(*) AS count FROM automations'),
      ...(next?.name && nextRunAt !== undefined
        ? { nextAutomation: { name: next.name, nextRunAt } }
        : {}),
      ...(lastError?.source && lastError.message && lastErrorCreatedAt !== undefined
        ? { lastError: { source: lastError.source, message: lastError.message, createdAt: lastErrorCreatedAt } }
        : {}),
    };
  });
}

function describeModel(selection: ReturnType<ConfigManager['getMainModel']>): string {
  return selection
    ? `${selection.provider} / ${selection.model} (reasoning: ${selection.reasoningEffort || 'default'})`
    : 'Not configured';
}

export async function runStatus(customHome?: string): Promise<void> {
  const paths = resolvePokePaths(customHome);
  const config = new ConfigManager(customHome, { initialize: false });
  const pidFile = path.join(paths.root, 'daemon.pid');
  const pidRecord = fs.existsSync(pidFile) ? readDaemonPidFile(pidFile) : null;
  const isRunning = Boolean(
    pidRecord && isLivePokeDaemon(pidRecord, resolvePokeInstallationPaths().pokeBinPath)
  );
  const gateway = readGatewayRuntimeStatus(paths.runtimeStatusFile);
  const database = await readStatusDatabase(paths.sqliteFile);

  const mainModel = config.getMainModel();
  const workerModel = config.getWorkerModel();
  const stats = database || {
    approximateTokens: 0,
    agentBusy: false,
    runningWorkers: 0,
    queuedWorkers: 0,
    enabledAutomations: 0,
    totalAutomations: 0,
  };
  const gatewayStale = gateway && Date.now() - gateway.updatedAt > 90_000;
  const gatewayState = gateway
    ? `${gateway.state}${gatewayStale ? ' (stale heartbeat)' : ''}${gateway.reason ? `: ${redactSecrets(gateway.reason)}` : ''}`
    : isRunning
      ? 'connecting (awaiting gateway heartbeat)'
      : 'disconnected';

  console.log('\n========================================');
  console.log('             POKE STATUS                ');
  console.log('========================================\n');
  console.log(`Daemon Status:       ${isRunning ? `Running${pidRecord ? ` (PID: ${pidRecord.pid})` : ''}` : 'Stopped'}`);
  console.log(`WhatsApp Gateway:    ${gatewayState}`);
  console.log(`Paired Account:      ${gateway?.pairedAccount || config.getWhatsAppAccount() || 'Not paired'}`);
  console.log(`Owner Phone:         ${config.getOwnerPhoneNumber() || 'None configured'}`);
  console.log('Timezone:            Asia/Karachi');

  console.log('\n--- Model Configuration ---');
  console.log(`Main Agent Model:    ${describeModel(mainModel)}`);
  console.log(`Worker Model:        ${describeModel(workerModel)}`);

  console.log('\n--- Agent & Context ---');
  console.log(`Main Agent:          ${stats.agentBusy ? 'Active' : 'Idle'}`);
  console.log(`Approximate Tokens:  ${stats.approximateTokens.toLocaleString()}`);
  console.log(`Active Threshold:    ${ACTIVE_COMPACTION_TOKEN_THRESHOLD.toLocaleString()} tokens`);
  console.log(`Idle Threshold:      ${IDLE_COMPACTION_TOKEN_THRESHOLD.toLocaleString()} tokens after 30m`);
  if (stats.lastActivityTime) {
    console.log(`Last Activity:       ${new Date(stats.lastActivityTime).toISOString()}`);
  }

  console.log('\n--- Asynchronous Workers ---');
  console.log(`Running Workers:     ${stats.runningWorkers} / 4`);
  console.log(`Queued Workers:      ${stats.queuedWorkers}`);

  console.log('\n--- Automations ---');
  console.log(`Active Automations:  ${stats.enabledAutomations} / ${stats.totalAutomations}`);
  console.log(
    `Next Run Due:        ${stats.nextAutomation
      ? `${new Date(stats.nextAutomation.nextRunAt).toISOString()} (${stats.nextAutomation.name})`
      : 'None scheduled'}`
  );

  if (stats.lastError) {
    console.log('\n--- Last Operational Error ---');
    console.log(
      `[${new Date(stats.lastError.createdAt).toISOString()}] (${stats.lastError.source}) ${redactSecrets(stats.lastError.message)}`
    );
  }
  console.log('\n========================================\n');
}
