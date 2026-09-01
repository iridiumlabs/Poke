import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { fireworksProvider } from '@earendil-works/pi-ai/providers/fireworks';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { ModelInfo, ReasoningEffort } from '../config/types.js';

export const CODEX_PROVIDER_ID = 'openai-codex';
export const FIREWORKS_PROVIDER_ID = 'fireworks';
export const COMMAND_CODE_PROVIDER_ID = 'commandcode';
const COMMAND_CODE_BASE_URL = 'https://api.commandcode.ai/provider/v1';

const REASONING_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

export function createCommandCodeRuntimeModel(info: ModelInfo): Model<'openai-completions'> {
  const supportedEfforts = new Set(info.capabilities.reasoningEfforts);
  const reasoning = supportedEfforts.size > 0;
  const thinkingLevelMap = reasoning
    ? {
        off: null,
        minimal: null,
        low: supportedEfforts.has('low') ? 'low' : null,
        medium: supportedEfforts.has('medium') ? 'medium' : null,
        high: supportedEfforts.has('high') ? 'high' : null,
        xhigh: supportedEfforts.has('xhigh') ? 'xhigh' : null,
        max: supportedEfforts.has('max') ? 'max' : null,
      }
    : undefined;
  const contextWindow = Math.max(1, info.capabilities.contextWindow || 128000);

  return {
    id: info.id,
    name: info.name || info.id,
    api: 'openai-completions',
    provider: COMMAND_CODE_PROVIDER_ID,
    baseUrl: COMMAND_CODE_BASE_URL,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: info.capabilities.acceptsImages ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // The Command Code catalog does not advertise a completion limit. Keep a
    // conservative non-zero bound so Flue can enable threshold compaction.
    maxTokens: Math.min(16384, contextWindow),
    compat: { supportsReasoningEffort: reasoning },
  };
}

export function createCommandCodeCredentialProvider(
  runtimeModels: readonly ModelInfo[] = []
): Provider<'openai-completions'> {
  const provider = createProvider({
    id: COMMAND_CODE_PROVIDER_ID,
    name: 'Command Code',
    baseUrl: COMMAND_CODE_BASE_URL,
    auth: {
      apiKey: {
        name: 'Command Code API key',
        resolve: async ({ credential }) => {
          if (!credential?.key) return undefined;
          return {
            auth: { apiKey: credential.key },
            source: 'Poke credential store',
          };
        },
      },
    },
    models: runtimeModels.map(createCommandCodeRuntimeModel),
    api: openAICompletionsApi(),
  }) as unknown as Provider<'openai-completions'>;

  // Static models resolve before this fallback. Keep it for a startup where
  // the live catalog is temporarily unavailable; selected known models never
  // use the zero-metadata template.
  (provider as any)[Symbol.for('flue.dynamicModelTemplate')] = {
    api: 'openai-completions',
    baseUrl: COMMAND_CODE_BASE_URL,
  };

  return provider;
}

/** The one app-owned pi-ai collection. OAuth refreshes use this locked store. */
export function createPokeModels(credentials: CredentialStore): MutableModels {
  const models = createModels({ credentials });
  models.setProvider(createCommandCodeCredentialProvider());
  models.setProvider(fireworksProvider());
  models.setProvider(openaiCodexProvider());
  return models;
}

export function normalizePiCatalog(models: readonly Model<any>[]): ModelInfo[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name || model.id,
    capabilities: {
      reasoningEfforts: getSupportedThinkingLevels(model).filter(
        (level): level is ReasoningEffort => REASONING_EFFORTS.has(level as ReasoningEffort)
      ),
      acceptsImages: model.input.includes('image'),
      contextWindow: model.contextWindow || undefined,
    },
  }));
}

export async function getAuthenticatedModels(
  models: Models,
  providerId: typeof CODEX_PROVIDER_ID | typeof FIREWORKS_PROVIDER_ID
): Promise<ModelInfo[]> {
  const auth = await models.checkAuth(providerId);
  if (!auth) {
    const label = providerId === CODEX_PROVIDER_ID ? 'Codex' : 'Fireworks';
    throw new Error(`${label} is not authenticated. Run \`poke login\`.`);
  }
  return normalizePiCatalog(await models.getAvailable(providerId));
}

/**
 * Flue owns a second pi-ai collection. Delegate each runtime auth lookup to
 * Poke's collection so OAuth refreshes remain serialized in Poke's store.
 */
export function withPokeCredentialResolver(provider: Provider, models: Models): Provider {
  return {
    ...provider,
    auth: {
      apiKey: {
        name: provider.auth.oauth?.name || provider.auth.apiKey?.name || provider.name,
        resolve: async () => {
          const auth = await models.getAuth(provider.id);
          if (!auth) return undefined;
          return {
            auth: auth.auth,
            source: 'Poke credential store',
          };
        },
      },
    },
  };
}
