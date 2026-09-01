import { ConfigManager } from '../config/config.js';
import type { ServiceCredentials } from '../config/types.js';
import { normalizeE164PhoneNumber } from '../gateway/pairing.js';
import { redactSecrets } from '../logger/logger.js';
import {
  REQUIRED_SERVICES,
  validateServiceCredential,
  type ServiceCredentialKey,
} from '../services/health.js';
import { runInteractiveWhatsAppPairing, type PairingCliDependencies } from './pairing.js';
import { CliCancelledError, createCliUi, type CliUi } from './ui.js';

interface SetupService {
  name: string;
  key: ServiceCredentialKey;
}

const SETUP_SERVICES: readonly SetupService[] = REQUIRED_SERVICES;

export interface SetupDependencies {
  pairing?: PairingCliDependencies;
  validateService?: (service: ServiceCredentialKey, apiKey: string) => Promise<void>;
}

async function configureService(
  config: ConfigManager,
  ui: CliUi,
  service: SetupService,
  validate: (service: ServiceCredentialKey, apiKey: string) => Promise<void>
): Promise<void> {
  const existing = config.getCredentials()[service.key];
  if (existing && (await ui.confirm(`Keep the existing ${service.name} API key?`, true))) {
    ui.success(`${service.name} remains configured.`);
    return;
  }

  while (true) {
    const apiKey = (await ui.secret({ message: `${service.name} API key`, required: true })).trim();
    if (!apiKey) {
      ui.error(`${service.name} is required for Poke setup.`);
      continue;
    }

    try {
      await ui.spinner(`Validating ${service.name}…`, () => validate(service.key, apiKey));
      config.updateCredentials({ [service.key]: apiKey } as Partial<ServiceCredentials>);
      ui.success(`${service.name} configured.`);
      return;
    } catch (error: unknown) {
      ui.error(
        `${service.name} validation failed: ${error instanceof Error ? redactSecrets(error.message) : 'Unknown error.'}`
      );
    }
  }
}

export async function runSetup(
  customHome?: string,
  ui: CliUi = createCliUi(),
  dependencies: SetupDependencies = {}
): Promise<void> {
  const config = new ConfigManager(customHome);
  ui.note('Poke setup');
  ui.note('Timezone: Asia/Karachi');

  try {
    // Setup is deliberately WhatsApp-first. Existing completed state is
    // resumable without making the owner pair again.
    if (!config.getWhatsAppAccount()) {
      const paired = await runInteractiveWhatsAppPairing(config, customHome, ui, dependencies.pairing);
      if (!paired) return;
    } else {
      ui.note(`WhatsApp already paired as ${config.getWhatsAppAccount()}.`);
      if (await ui.confirm('Pair a different WhatsApp account?', false)) {
        const paired = await runInteractiveWhatsAppPairing(config, customHome, ui, dependencies.pairing);
        if (!paired) return;
      }
    }

    while (true) {
      const ownerRaw = await ui.text({
        message: 'Personal owner number in E.164 format',
        default: config.getOwnerPhoneNumber() ? `+${config.getOwnerPhoneNumber()}` : undefined,
        required: true,
      });
      try {
        const owner = normalizeE164PhoneNumber(ownerRaw);
        if (owner === config.getWhatsAppAccount()) {
          throw new Error('The owner number must be different from Poke’s paired WhatsApp account.');
        }
        config.setOwnerPhoneNumber(owner);
        ui.success(`Owner number saved as ${owner}.`);
        break;
      } catch (error: unknown) {
        ui.error(error instanceof Error ? error.message : 'Enter a valid owner number.');
      }
    }

    const validate = dependencies.validateService || validateServiceCredential;
    for (const service of SETUP_SERVICES) {
      await configureService(config, ui, service, validate);
    }

    ui.success('Setup complete. Next run `poke login`, `poke model`, and `poke model worker`.');
  } catch (error: unknown) {
    if (error instanceof CliCancelledError) {
      ui.warning('Setup cancelled. Completed steps were kept.');
      return;
    }
    throw error;
  }
}
