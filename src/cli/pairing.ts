import qrcode from 'qrcode-terminal';
import { ConfigManager } from '../config/config.js';
import { resolvePokePaths } from '../config/paths.js';
import {
  PairingCancelledError,
  WhatsAppPairingService,
  type PairingMethod,
} from '../gateway/pairing.js';
import { writeGatewayRuntimeStatus } from '../gateway/runtime-status.js';
import { redactSecrets } from '../logger/logger.js';
import { isDaemonRunning, runStart, runStop } from './lifecycle.js';
import { CliCancelledError, CliCommandFailedError, type CliUi } from './ui.js';

export interface DaemonMaintenance {
  isRunning(): Promise<boolean>;
  stop(): Promise<void>;
  start(): Promise<void>;
}

export interface PairingCliDependencies {
  service?: WhatsAppPairingService;
  daemon?: DaemonMaintenance;
  renderQr?: (value: string) => string;
}

function defaultDaemonMaintenance(customHome?: string): DaemonMaintenance {
  return {
    async isRunning() {
      return isDaemonRunning(customHome);
    },
    async stop() {
      await runStop(customHome);
    },
    async start() {
      await runStart({}, customHome);
    },
  };
}

function terminalQr(value: string): string {
  let rendered = '';
  qrcode.generate(value, { small: true }, (output) => {
    rendered = output;
  });
  return rendered;
}

export interface InteractivePairingResult {
  paired: boolean;
  pairedAccount?: string;
}

export async function runInteractiveWhatsAppPairing(
  config: ConfigManager,
  customHome: string | undefined,
  ui: CliUi,
  dependencies: PairingCliDependencies = {}
): Promise<InteractivePairingResult | undefined> {
  const service = dependencies.service || new WhatsAppPairingService(resolvePokePaths(customHome));
  const daemon = dependencies.daemon || defaultDaemonMaintenance(customHome);
  const renderer = dependencies.renderQr || terminalQr;

  try {
    const choice = await ui.select('Choose a WhatsApp pairing method', [
      { value: 'qr', name: 'QR code', description: 'Scan from WhatsApp on your phone' },
      { value: 'phone', name: 'Phone pairing code', description: 'Use an E.164 account number' },
    ]);
    let method: PairingMethod = { type: 'qr' };
    if (choice === 'phone') {
      const phoneNumber = await ui.text({
        message: 'WhatsApp account number in E.164 format',
        required: true,
      });
      method = { type: 'phone', phoneNumber };
    }

    const wasRunning = await daemon.isRunning();
    if (wasRunning) {
      await ui.spinner('Stopping the daemon before pairing…', () => daemon.stop());
    }

    try {
      const result = await ui.spinner('Waiting for WhatsApp pairing…', () =>
        service.pair({
          method,
          onStatus: (status) => ui.note(status),
          onPairingCode: (code) => ui.note(`Enter pairing code: ${code}`),
          onQr: (qr) => ui.note(renderer(qr)),
        })
      );
      if (result.pairedAccount) {
        config.setWhatsAppAccount(result.pairedAccount);
      }
      writeGatewayRuntimeStatus(resolvePokePaths(customHome).runtimeStatusFile, {
        state: 'disconnected',
        updatedAt: Date.now(),
        ...(result.pairedAccount ? { pairedAccount: result.pairedAccount } : {}),
        reason: 'WhatsApp session paired.',
      });
      ui.success(
        result.pairedAccount
          ? `WhatsApp paired as ${result.pairedAccount}.`
          : 'WhatsApp paired successfully.'
      );
      return { paired: true, pairedAccount: result.pairedAccount };
    } finally {
      // A failed/cancelled pairing keeps the old staged session untouched, so
      // a daemon that was running before maintenance can safely resume it.
      if (wasRunning) {
        await ui.spinner('Starting the daemon…', () => daemon.start());
      }
    }
  } catch (error: unknown) {
    if (error instanceof CliCancelledError || error instanceof PairingCancelledError) {
      ui.warning('WhatsApp pairing cancelled. The previous session was kept.');
      return undefined;
    }
    const message = `WhatsApp pairing failed: ${error instanceof Error ? redactSecrets(error.message) : 'Unknown error.'}`;
    ui.error(message);
    throw new CliCommandFailedError(message);
  }
}

export function getDaemonMaintenance(customHome?: string): DaemonMaintenance {
  return defaultDaemonMaintenance(customHome);
}
