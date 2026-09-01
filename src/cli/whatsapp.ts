import { ConfigManager } from '../config/config.js';
import { resolvePokePaths } from '../config/paths.js';
import { WhatsAppPairingService } from '../gateway/pairing.js';
import { readGatewayRuntimeStatus, writeGatewayRuntimeStatus } from '../gateway/runtime-status.js';
import {
  getDaemonMaintenance,
  runInteractiveWhatsAppPairing,
  type DaemonMaintenance,
  type PairingCliDependencies,
} from './pairing.js';
import { CliCancelledError, createCliUi, type CliUi } from './ui.js';

export interface WhatsAppMenuDependencies {
  pairing?: PairingCliDependencies;
  daemon?: DaemonMaintenance;
}

function showConnectionStatus(customHome: string | undefined, config: ConfigManager, ui: CliUi): void {
  const status = readGatewayRuntimeStatus(resolvePokePaths(customHome).runtimeStatusFile);
  ui.note('WhatsApp connection status');
  ui.note(`State: ${status?.state || 'unknown (daemon has not reported status)'}`);
  ui.note(`Paired account: ${status?.pairedAccount || config.getWhatsAppAccount() || 'not paired'}`);
  ui.note(`Owner: ${config.getOwnerPhoneNumber() || 'not configured'}`);
  if (status?.lastConnectedAt) {
    ui.note(`Last connected: ${new Date(status.lastConnectedAt).toISOString()}`);
  }
  if (status?.reason) {
    ui.note(`Reason: ${status.reason}`);
  }
}

export async function runWhatsAppMenu(
  customHome?: string,
  ui: CliUi = createCliUi(),
  dependencies: WhatsAppMenuDependencies = {}
): Promise<void> {
  const config = new ConfigManager(customHome);
  const paths = resolvePokePaths(customHome);
  const daemon = dependencies.daemon || dependencies.pairing?.daemon || getDaemonMaintenance(customHome);
  const pairing = dependencies.pairing;

  try {
    const status = readGatewayRuntimeStatus(paths.runtimeStatusFile);
    ui.note('WhatsApp');
    ui.note(`Status: ${status?.state || 'unknown'}`);

    const action = await ui.select('Choose an action', [
      { value: 'reauthenticate', name: 'Re-authenticate' },
      { value: 'clear', name: 'Clear session' },
      { value: 'status', name: 'Show connection status' },
      { value: 'cancel', name: 'Cancel' },
    ]);

    if (action === 'reauthenticate') {
      await runInteractiveWhatsAppPairing(config, customHome, ui, { ...pairing, daemon });
      return;
    }

    if (action === 'clear') {
      if (!(await ui.confirm('Clear only WhatsApp session credentials? This cannot be undone.', false))) {
        ui.note('Session clearing cancelled.');
        return;
      }
      const wasRunning = await daemon.isRunning();
      if (wasRunning) {
        await ui.spinner('Stopping the daemon before clearing the session…', () => daemon.stop());
      }
      const service = pairing?.service || new WhatsAppPairingService(paths);
      await ui.spinner('Removing WhatsApp session credentials…', () => service.clearSession());
      config.setWhatsAppAccount(undefined);
      writeGatewayRuntimeStatus(paths.runtimeStatusFile, {
        state: 'disconnected',
        updatedAt: Date.now(),
        reason: 'WhatsApp session cleared.',
      });
      ui.success(
        `WhatsApp session cleared. Conversations, jobs, automations, and credentials were preserved.${
          wasRunning ? ' The daemon remains stopped; run `poke start` after re-pairing.' : ''
        }`
      );
      return;
    }

    if (action === 'status') {
      showConnectionStatus(customHome, config, ui);
      return;
    }

    ui.note('Cancelled.');
  } catch (error: unknown) {
    if (error instanceof CliCancelledError) {
      ui.warning('WhatsApp menu cancelled.');
      return;
    }
    throw error;
  }
}
