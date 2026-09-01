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

function readStatusDatabase(sqliteFile: string): StatusDatabaseSnapshot | null {
  return inspectReadOnlyDatabase(sqliteFile, (database) => {
    const state = (key: string) =>
      (database.prepare('SELECT value FROM state_kv WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
    const count = (query: string) =>
      Number((database.prepare(query).get() as { count?: number } | undefined)?.count || 0);
    const next = database
      .prepare('SELECT name, next_run_at FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at ASC LIMIT 1')
      .get() as { name?: string; next_run_at?: number } | undefined;
    const lastError = database
      .prepare('SELECT source, message, created_at FROM operational_errors ORDER BY created_at DESC LIMIT 1')
      .get() as { source?: string; message?: string; created_at?: number } | undefined;
    return {
      approximateTokens: Number(state('approximate_tokens') || 0),
      ...(Number.isFinite(Number(state('last_activity_time')))
        ? { lastActivityTime: Number(state('last_activity_time')) }
        : {}),
      agentBusy: state('main_agent_busy') === 'true',
      runningWorkers: count("SELECT COUNT(*) AS count FROM worker_jobs WHERE status = 'running'"),
      queuedWorkers: count("SELECT COUNT(*) AS count FROM worker_jobs WHERE status = 'queued'"),
      enabledAutomations: count('SELECT COUNT(*) AS count FROM automations WHERE enabled = 1'),
      totalAutomations: count('SELECT COUNT(*) AS count FROM automations'),
      ...(next?.name && typeof next.next_run_at === 'number'
        ? { nextAutomation: { name: next.name, nextRunAt: next.next_run_at } }
        : {}),
      ...(lastError?.source && lastError.message && typeof lastError.created_at === 'number'
        ? { lastError: { source: lastError.source, message: lastError.message, createdAt: lastError.created_at } }
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
  const database = readStatusDatabase(paths.sqliteFile);

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
