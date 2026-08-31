import fs from 'fs';
import path from 'path';
import { ConfigManager } from '../config/config.js';
import { PokeDatabase } from '../db/database.js';
import { resolvePokePaths } from '../config/paths.js';
import { resolvePokeInstallationPaths } from '../config/installation.js';
import { readDaemonPidFile, isLivePokeDaemon } from '../daemon/pid-file.js';
import { CompactionManager } from '../context/compaction-manager.js';

export async function runStatus(customHome?: string): Promise<void> {
  const paths = resolvePokePaths(customHome);
  const configManager = new ConfigManager(customHome);
  const db = new PokeDatabase(customHome);
  const compaction = new CompactionManager(db, configManager);

  const pidFile = path.join(paths.root, 'daemon.pid');
  let isRunning = false;
  let pid: number | null = null;

  if (fs.existsSync(pidFile)) {
    const record = readDaemonPidFile(pidFile);
    const { pokeBinPath } = resolvePokeInstallationPaths();
    if (record && isLivePokeDaemon(record, pokeBinPath)) {
      isRunning = true;
      pid = record.pid;
    }
  }

  const mainModel = configManager.getMainModel();
  const workerModel = configManager.getWorkerModel();
  const ownerPhone = configManager.getOwnerPhoneNumber();

  const sessionFiles = fs.existsSync(paths.whatsappDir)
    ? fs.readdirSync(paths.whatsappDir)
    : [];
  const whatsappState = sessionFiles.length > 0 ? (isRunning ? 'connected' : 'saved') : 'not authenticated';

  const runningJobs = db.getRunningWorkerJobs();
  const queuedJobs = db.getQueuedWorkerJobs();

  const automations = db.listAutomations();
  const enabledAutomations = automations.filter((a) => a.enabled);
  const nextDue = db.getNextDueAutomation();

  const lastErr = db.getLastOperationalError();
  const stats = compaction.getStats();

  console.log('\n========================================');
  console.log('             POKE STATUS                ');
  console.log('========================================\n');

  console.log(`Daemon Status:       ${isRunning ? `Running (PID: ${pid})` : 'Stopped'}`);
  console.log(`WhatsApp Gateway:    ${whatsappState}`);
  console.log(`Owner Phone:         ${ownerPhone || 'None configured'}`);
  console.log(`Timezone:            Asia/Karachi`);

  console.log('\n--- Model Configuration ---');
  if (mainModel) {
    console.log(`Main Agent Model:    ${mainModel.provider} / ${mainModel.model} (reasoning: ${mainModel.reasoningEffort || 'default'})`);
  } else {
    console.log(`Main Agent Model:    Not configured (run \`poke model\`)`);
  }

  if (workerModel) {
    console.log(`Worker Model:        ${workerModel.provider} / ${workerModel.model} (reasoning: ${workerModel.reasoningEffort || 'default'})`);
  } else {
    console.log(`Worker Model:        Using main agent model default`);
  }

  console.log('\n--- Context & Compaction ---');
  console.log(`Approximate Tokens:  ${stats.approximateTokens.toLocaleString()}`);
  console.log(`Active Threshold:    ${stats.activeThreshold.toLocaleString()} tokens`);
  console.log(`Idle Threshold:      ${stats.idleThreshold.toLocaleString()} tokens after 30m`);
  console.log(`Inactive Duration:   ${Math.round(stats.idleTimeMs / 1000 / 60)} minutes`);

  console.log('\n--- Asynchronous Workers ---');
  console.log(`Running Workers:     ${runningJobs.length} / 4`);
  console.log(`Queued Workers:      ${queuedJobs.length}`);

  console.log('\n--- Automations ---');
  console.log(`Active Automations:  ${enabledAutomations.length} / ${automations.length}`);
  if (nextDue && nextDue.next_run_at) {
    console.log(`Next Run Due:        ${new Date(nextDue.next_run_at).toISOString()} (${nextDue.name})`);
  } else {
    console.log(`Next Run Due:        None scheduled`);
  }

  if (lastErr) {
    console.log('\n--- Last Operational Error ---');
    console.log(`[${new Date(lastErr.created_at).toISOString()}] (${lastErr.source}) ${lastErr.message}`);
  }

  console.log('\n========================================\n');
  db.close();
}
