import { ConfigManager } from '../config/config.js';
import { redactSecrets } from '../logger/logger.js';
import {
  validateServiceCredential,
  type RequiredService,
  type ServiceCredentialKey,
} from '../services/health.js';
import { isDaemonRunning, runRestart } from './lifecycle.js';
import { CliCancelledError, createCliUi, type CliUi } from './ui.js';

const CONFIGURABLE_SERVICES = [
  { name: 'Supermemory', key: 'supermemoryApiKey' },
  { name: 'Composio', key: 'composioApiKey' },
  { name: 'Exa', key: 'exaApiKey' },
  { name: 'Deepgram', key: 'deepgramApiKey' },
  { name: 'Groq', key: 'groqApiKey' },
] as const satisfies readonly RequiredService[];

type ConfigurableService = typeof CONFIGURABLE_SERVICES[number];
type ConfigureAction = ConfigurableService['key'] | 'done';

export interface ConfigureDependencies {
  validateService?: (service: ServiceCredentialKey, apiKey: string) => Promise<void>;
  isDaemonRunning?: (customHome?: string) => boolean;
  restartDaemon?: (customHome?: string) => Promise<void>;
}

function serviceFor(action: ConfigurableService['key']): ConfigurableService {
  const service = CONFIGURABLE_SERVICES.find((candidate) => candidate.key === action);
  if (!service) throw new Error(`Unknown service credential: ${action}`);
  return service;
}

async function configureService(
  config: ConfigManager,
  ui: CliUi,
  service: ConfigurableService,
  validate: (service: ServiceCredentialKey, apiKey: string) => Promise<void>
): Promise<boolean> {
  const currentKey = config.getCredentials()[service.key];
  if (currentKey && !(await ui.confirm(`Replace the existing ${service.name} API key?`, false))) {
    ui.note(`${service.name} API key unchanged.`);
    return false;
  }

  while (true) {
    const apiKey = await ui.secret({ message: `${service.name} API key`, required: true });
    if (!apiKey) {
      ui.error(`${service.name} API key is required.`);
      continue;
    }

    try {
      await ui.spinner(`Validating ${service.name}…`, () => validate(service.key, apiKey));
      // Validation completes before the atomic config update. A bad key never
      // replaces a working one.
      config.updateCredentials({ [service.key]: apiKey });
      ui.success(`${service.name} configured.`);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? redactSecrets(error.message) : 'Unknown error.';
      ui.error(`${service.name} validation failed: ${message}`);
    }
  }
}

export async function runConfigure(
  customHome?: string,
  ui: CliUi = createCliUi(),
  dependencies: ConfigureDependencies = {}
): Promise<void> {
  const config = new ConfigManager(customHome);
  const validate = dependencies.validateService || validateServiceCredential;
  let changed = false;
  let restarted = false;
  const restartIfNeeded = async () => {
    if (restarted || !changed || !(dependencies.isDaemonRunning || isDaemonRunning)(customHome)) return;
    ui.note('Restarting the daemon so the updated credentials are applied.');
    await (dependencies.restartDaemon || ((home?: string) => runRestart({}, home)))(customHome);
    restarted = true;
  };

  try {
    ui.note('Poke service credentials');
    while (true) {
      const action = await ui.select<ConfigureAction>('Choose a service to configure', [
        ...CONFIGURABLE_SERVICES.map((service) => ({
          value: service.key,
          name: service.name,
        })),
        { value: 'done', name: 'Done' },
      ]);
      if (action === 'done') break;
      changed = (await configureService(config, ui, serviceFor(action), validate)) || changed;
    }

    await restartIfNeeded();
  } catch (error: unknown) {
    if (error instanceof CliCancelledError) {
      await restartIfNeeded();
      ui.warning('Configuration cancelled. Completed changes were kept.');
      return;
    }
    throw error;
  }
}
