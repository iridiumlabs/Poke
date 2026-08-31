import { ModelCapabilities, ModelInfo } from '../config/types.js';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from './retry.js';

export const CODEX_KNOWN_MODELS: Record<string, Partial<ModelCapabilities>> = {
  'o1': {
    reasoningEfforts: ['low', 'medium', 'high'],
    acceptsImages: true,
    contextWindow: 200000,
  },
  'o1-mini': {
    reasoningEfforts: ['low', 'medium', 'high'],
    acceptsImages: false,
    contextWindow: 128000,
  },
  'o3-mini': {
    reasoningEfforts: ['low', 'medium', 'high'],
    acceptsImages: false,
    contextWindow: 200000,
  },
  'gpt-4o': {
    reasoningEfforts: [],
    acceptsImages: true,
    contextWindow: 128000,
  },
  'gpt-4o-mini': {
    reasoningEfforts: [],
    acceptsImages: true,
    contextWindow: 128000,
  },
};

export class CodexCatalog {
  static async fetchLiveModels(accessToken?: string): Promise<ModelInfo[]> {
    // If accessToken is provided, query OpenAI models endpoint or fallback to known models
    if (accessToken) {
      try {
        const rawData: any = await withProviderRetry(async () => {
          const res = await fetch('https://api.openai.com/v1/models', {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
            },
          });
          if (!res.ok) {
            throw new Error(`OpenAI API returned ${res.status}`);
          }
          return await res.json();
        });

        const list: any[] = Array.isArray(rawData.data) ? rawData.data : [];
        const result: ModelInfo[] = [];

        for (const item of list) {
          const id = item.id;
          if (!id || (!id.startsWith('gpt-') && !id.startsWith('o1') && !id.startsWith('o3'))) {
            continue;
          }
          const known = CODEX_KNOWN_MODELS[id];
          result.push({
            id,
            name: id,
            capabilities: {
              reasoningEfforts: known?.reasoningEfforts || (id.startsWith('o1') || id.startsWith('o3') ? ['low', 'medium', 'high'] : []),
              acceptsImages: known?.acceptsImages ?? (id.includes('4o') || id.startsWith('o1')),
              contextWindow: known?.contextWindow ?? 128000,
            },
          });
        }

        if (result.length > 0) return result;
      } catch (err: any) {
        getLogger().warn({ err: err.message }, 'Failed to fetch OpenAI live models, using default catalog');
      }
    }

    return Object.entries(CODEX_KNOWN_MODELS).map(([id, caps]) => ({
      id,
      name: id,
      capabilities: {
        reasoningEfforts: caps.reasoningEfforts || [],
        acceptsImages: caps.acceptsImages ?? true,
        contextWindow: caps.contextWindow ?? 128000,
      },
    }));
  }
}
