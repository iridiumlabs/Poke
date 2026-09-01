import type { AuthInteraction, CredentialStore, Models } from '@earendil-works/pi-ai';
import { ConfigManager } from '../config/config.js';
import { redactSecrets } from '../logger/logger.js';
import { CommandCodeCatalog } from '../providers/commandcode.js';
import { FileCredentialStore } from '../providers/credential-store.js';
import { migrateLegacyProviderCredentials } from '../providers/credentials-migration.js';
import { FireworksCatalog } from '../providers/fireworks.js';
import { CODEX_PROVIDER_ID, createPokeModels } from '../providers/models.js';
import { CliCancelledError, CliCommandFailedError, createCliUi, type CliUi } from './ui.js';

export interface LoginDependencies {
  credentials?: CredentialStore;
  models?: Models;
  validateCommandCode?: (apiKey: string) => Promise<unknown[]>;
  validateFireworks?: (apiKey: string) => Promise<unknown[]>;
}

type LoginProvider = 'commandcode' | 'fireworks' | 'codex';

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Authentication failed.';
  return redactSecrets(message);
}

function createCodexDeviceCodeInteraction(ui: CliUi): AuthInteraction {
  return {
    async prompt(prompt) {
      // Codex's pi-ai flow offers browser and device-code paths. Poke is a VPS
      // CLI, so it always picks the headless, refreshable device-code flow.
      if (prompt.type === 'select') return 'device_code';
      if (prompt.type === 'secret') {
        return await ui.secret({
          message: prompt.message,
          required: true,
        });
      }
      return await ui.text({
        message: prompt.message,
        required: true,
      });
    },
    notify(event) {
      if (event.type === 'device_code') {
        ui.note(`Open ${event.verificationUri} and enter code ${event.userCode}.`);
      } else if (event.type === 'auth_url') {
        ui.note(`${event.instructions || 'Open this URL:'} ${event.url}`);
      } else if (event.type === 'progress' || event.type === 'info') {
        ui.note(event.message);
      }
    },
  };
}

export async function runLogin(
  customHome?: string,
  ui: CliUi = createCliUi(),
  dependencies: LoginDependencies = {}
): Promise<void> {
  const config = new ConfigManager(customHome);
  const credentials = dependencies.credentials || new FileCredentialStore(config.getPaths().credentialsFile);
  await migrateLegacyProviderCredentials(config, credentials);
  const models = dependencies.models || createPokeModels(credentials);
  const validateCommandCode = dependencies.validateCommandCode || CommandCodeCatalog.validateApiKey;
  const validateFireworks = dependencies.validateFireworks || FireworksCatalog.fetchLiveModels;

  ui.note('Poke login');

  try {
    const provider = await ui.select<LoginProvider>('Choose a model provider', [
      { value: 'commandcode', name: 'Command Code', description: 'Provider API key' },
      { value: 'fireworks', name: 'Fireworks AI', description: 'API key' },
      { value: 'codex', name: 'Codex', description: 'ChatGPT/Codex device-code login' },
    ]);

    if (provider === 'codex') {
      await ui.spinner('Waiting for Codex device-code login…', async () => {
        await models.login(CODEX_PROVIDER_ID, 'oauth', createCodexDeviceCodeInteraction(ui));
      });
      ui.success('Codex authenticated with a refreshable credential.');
      return;
    }

    const label = provider === 'commandcode' ? 'Command Code' : 'Fireworks AI';
    const apiKey = await ui.secret({
      message: `${label} API key`,
      required: true,
    });

    const catalog = await ui.spinner(`Validating ${label} credentials…`, async () => {
      return provider === 'commandcode'
        ? await validateCommandCode(apiKey)
        : await validateFireworks(apiKey);
    });

    // Validation completes before the atomic replacement, so a typo or a
    // network/auth failure never discards the prior working credential.
    await credentials.modify(provider, async () => ({ type: 'api_key', key: apiKey }));
    ui.success(`${label} authenticated. Found ${catalog.length} available models.`);
  } catch (error: unknown) {
    if (error instanceof CliCancelledError) {
      ui.warning('Login cancelled. Existing credentials were kept.');
      return;
    }
    const message = `Login failed: ${safeErrorMessage(error)}`;
    ui.error(message);
    throw new CliCommandFailedError(message);
  }
}
