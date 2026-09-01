import { setProvider } from '@flue/runtime';
import type { CredentialStore, Models } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { ModelInfo, ModelSelection, ProviderType } from '../config/types.js';
import { COMMAND_CODE_MANUAL_CATALOG, CommandCodeCatalog } from './commandcode.js';
import { FireworksCatalog } from './fireworks.js';
import { redactSecrets } from '../logger/logger.js';
import {
  CODEX_PROVIDER_ID,
  COMMAND_CODE_PROVIDER_ID,
  FIREWORKS_PROVIDER_ID,
  createCommandCodeCredentialProvider,
  createFireworksCredentialProvider,
  createPokeModels,
  getAuthenticatedModels,
  withPokeCredentialResolver,
} from './models.js';

export function resolveFlueModelSpecifier(selection?: ModelSelection): string {
  if (!selection?.model) {
    throw new Error('No model is configured. Run `poke model` and `poke model worker`.');
  }

  const providerPrefix = selection.provider === 'codex' ? CODEX_PROVIDER_ID : selection.provider;
  if (selection.model.startsWith(`${providerPrefix}/`)) {
    return selection.model;
  }
  return `${providerPrefix}/${normalizeCatalogModelId(selection.model, selection.provider)}`;
}

export function normalizeCatalogModelId(model: string, provider?: ProviderType): string {
  const prefixes =
    provider === 'codex'
      ? [`${CODEX_PROVIDER_ID}/`, 'codex/']
      : provider === 'commandcode'
        ? [`${COMMAND_CODE_PROVIDER_ID}/`]
        : provider === 'fireworks'
          ? [`${FIREWORKS_PROVIDER_ID}/`]
          : [`${CODEX_PROVIDER_ID}/`, 'codex/', `${COMMAND_CODE_PROVIDER_ID}/`, `${FIREWORKS_PROVIDER_ID}/`];

  for (const prefix of prefixes) {
    if (model.startsWith(prefix)) return model.slice(prefix.length);
  }
  return model;
}

/** Registers Flue adapters whose request-time auth resolves from Poke's store. */
export function registerAllProviders(
  models: Models,
  commandCodeModels: readonly ModelInfo[] = COMMAND_CODE_MANUAL_CATALOG,
  fireworksModels: readonly ModelInfo[] = []
): void {
  setProvider(
    withPokeCredentialResolver(createCommandCodeCredentialProvider(commandCodeModels), models)
  );
  setProvider(
    withPokeCredentialResolver(createFireworksCredentialProvider(fireworksModels), models)
  );
  setProvider(withPokeCredentialResolver(openaiCodexProvider(), models));
}

import { isTransientError } from './retry.js';

export interface ModelValidationResult {
  valid: boolean;
  error?: string;
  transient?: boolean;
  modelInfo?: ModelInfo;
}

export interface ProviderCatalog {
  fetchModels(provider: ProviderType): Promise<ModelInfo[]>;
  validateSelection(selection: ModelSelection): Promise<ModelValidationResult>;
}

export class ProviderRegistry implements ProviderCatalog {
  readonly models: Models;

  constructor(private readonly credentials: CredentialStore, models?: Models) {
    this.models = models || createPokeModels(credentials);
  }

  async fetchModels(provider: ProviderType): Promise<ModelInfo[]> {
    switch (provider) {
      case 'commandcode': {
        const auth = await this.models.getAuth(COMMAND_CODE_PROVIDER_ID);
        const apiKey = auth?.auth.apiKey;
        if (!apiKey) {
          throw new Error('Command Code is not authenticated. Run `poke login`.');
        }
        return CommandCodeCatalog.getModels();
      }
      case 'fireworks': {
        const auth = await this.models.getAuth(FIREWORKS_PROVIDER_ID);
        const apiKey = auth?.auth.apiKey;
        if (!apiKey) {
          throw new Error('Fireworks is not authenticated. Run `poke login`.');
        }
        return await FireworksCatalog.fetchLiveModels(apiKey);
      }
      case 'codex':
        return await getAuthenticatedModels(this.models, CODEX_PROVIDER_ID);
      default:
        throw new Error(`Unsupported model provider: ${String(provider)}`);
    }
  }

  async validateSelection(selection: ModelSelection): Promise<ModelValidationResult> {
    try {
      const models = await this.fetchModels(selection.provider);
      const modelId = normalizeCatalogModelId(selection.model, selection.provider);
      const found = models.find((model) => model.id === modelId);
      if (!found) {
        return {
          valid: false,
          error: `Model "${selection.model}" is not available from ${selection.provider}. Run \`poke model\` to choose another one.`,
        };
      }
      if (
        selection.reasoningEffort &&
        !found.capabilities.reasoningEfforts.includes(selection.reasoningEffort)
      ) {
        return {
          valid: false,
          error: `Reasoning effort "${selection.reasoningEffort}" is not supported for ${selection.model}.`,
        };
      }
      return { valid: true, modelInfo: found };
    } catch (error: unknown) {
      return {
        valid: false,
        transient: isTransientError(error),
        error: error instanceof Error
          ? redactSecrets(error.message)
          : 'Unable to validate the selected model.',
      };
    }
  }
}
