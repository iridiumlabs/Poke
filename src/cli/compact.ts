import { resolvePokePaths } from '../config/paths.js';
import { isDaemonRunning } from './lifecycle.js';
import { sendDaemonCommand } from '../daemon/ipc.js';

export async function runCompact(customHome?: string): Promise<void> {
  const paths = resolvePokePaths(customHome);

  if (!isDaemonRunning(customHome)) {
    console.error('Error: Poke daemon is not running. Start the daemon first with `poke start`.');
    process.exitCode = 1;
    return;
  }

  try {
    const response = await sendDaemonCommand(paths.socketFile, { command: 'compact' });
    if (response.busy) {
      console.error('Error: Main agent is currently busy processing a turn. Please try again after the current turn completes.');
      process.exitCode = 1;
      return;
    }

    if (response.success) {
      console.log('✓ Main conversation compacted successfully.');
      const beforeStr = response.beforeTokens !== undefined ? `~${response.beforeTokens.toLocaleString()}` : 'unknown';
      const afterStr = response.afterTokens !== undefined ? `~${response.afterTokens.toLocaleString()}` : 'unknown';
      console.log(`Context: ${beforeStr} → ${afterStr} tokens`);
      return;
    }

    console.error(`Error: Compaction failed: ${response.error || 'Unknown error'}`);
    process.exitCode = 1;
  } catch (err: any) {
    console.error(`Error: Failed to communicate with Poke daemon: ${err?.message || String(err)}`);
    process.exitCode = 1;
  }
}
