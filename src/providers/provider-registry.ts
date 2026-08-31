import {
  ModelInfo,
  ModelSelection,
  ProviderType,
  ServiceCredentials,
} from '../config/types.js';
import { CommandCodeCatalog } from './commandcode.js';
import { FireworksCatalog } from './fireworks.js';
import { CodexCatalog } from './codex.js';
import { setProvider } from '@flue/runtime';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { fireworksProvider } from '@earendil-works/pi-ai/providers/fireworks';

export function resolveFlueModelSpecifier(selection?: ModelSelection): string {
  if (!selection || !selection.model) {
    return 'openai-codex/gpt-4o';
  }
  const provider = selection.provider || 'codex';
  const providerPrefix = provider === 'codex' ? 'openai-codex' : provider;

  if (
    selection.model.startsWith('openai-codex/') ||
    selection.model.startsWith('commandcode/') ||
    selection.model.startsWith('fireworks/') ||
    selection.model.startsWith('codex/')
  ) {
    return selection.model;
  }

  return `${providerPrefix}/${selection.model}`;
}

export function normalizeCatalogModelId(model: string, provider?: ProviderType): string {
  const prefixes =
    provider === 'codex'
      ? ['openai-codex/', 'codex/']
      : provider === 'commandcode'
        ? ['commandcode/']
        : provider === 'fireworks'
          ? ['fireworks/']
          : ['openai-codex/', 'codex/', 'commandcode/', 'fireworks/'];

  for (const prefix of prefixes) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

export function createCommandCodeProvider() {
  const DYNAMIC_MODEL_TEMPLATE = Symbol.for('flue.dynamicModelTemplate');
  const provider = createProvider({
    id: 'commandcode',
    name: 'Command Code',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    auth: {
      apiKey: {
        name: 'Command Code API key',
        resolve: async ({ ctx, credential }: any) => {
          const key = (await ctx?.env?.('COMMANDCODE_API_KEY')) || process.env.COMMANDCODE_API_KEY || credential?.key;
          if (!key) return undefined;
          return {
            auth: { apiKey: key },
            source: 'COMMANDCODE_API_KEY',
          };
        },
      },
    },
    models: [],
    api: openAICompletionsApi(),
  });
  (provider as any)[DYNAMIC_MODEL_TEMPLATE] = {
    api: 'openai-completions',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
  };
  return provider;
}

export function registerAllProviders(): void {
  try {
    setProvider(createCommandCodeProvider());
  } catch {}
  try {
    setProvider(fireworksProvider());
  } catch {}
  try {
    const codex = openaiCodexProvider();
    setProvider(codex);
    const codexAlias = { ...codex, id: 'codex' };
    setProvider(codexAlias as any);
  } catch {}
}

export class ProviderRegistry {
  static async fetchModels(
    provider: ProviderType,
    credentials: ServiceCredentials
  ): Promise<ModelInfo[]> {
    switch (provider) {
      case 'commandcode': {
        const apiKey = credentials.commandCodeApiKey || process.env.COMMANDCODE_API_KEY;
        if (!apiKey) {
          throw new Error('Command Code API key is missing. Run `poke login` to authenticate.');
        }
        return await CommandCodeCatalog.fetchLiveModels(apiKey);
      }
      case 'fireworks': {
        const apiKey = credentials.fireworksApiKey || process.env.FIREWORKS_API_KEY;
        if (!apiKey) {
          throw new Error('Fireworks API key is missing. Run `poke login` to authenticate.');
        }
        return await FireworksCatalog.fetchLiveModels(apiKey);
      }
      case 'codex': {
        return await CodexCatalog.fetchLiveModels(
          credentials.codexAuth?.accessToken || process.env.OPENAI_CODEX_ACCESS_TOKEN || process.env.OPENAI_API_KEY
        );
      }
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  static async validateSelection(
    selection: ModelSelection,
    credentials: ServiceCredentials
  ): Promise<{ valid: boolean; error?: string; modelInfo?: ModelInfo }> {
    try {
      const models = await this.fetchModels(selection.provider, credentials);
      const modelId = normalizeCatalogModelId(selection.model, selection.provider);
      const found = models.find((m) => m.id === modelId);

      if (!found) {
        return {
          valid: false,
          error: `Model "${selection.model}" not found in ${selection.provider} live catalog.`,
        };
      }

      if (selection.reasoningEffort) {
        if (!found.capabilities.reasoningEfforts.includes(selection.reasoningEffort)) {
          return {
            valid: false,
            error: `Reasoning effort "${selection.reasoningEffort}" is not supported for ${selection.model}. Valid options: ${found.capabilities.reasoningEfforts.join(', ') || 'none (default only)'}`,
          };
        }
      }

      return { valid: true, modelInfo: found };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  }
}
