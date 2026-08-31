import { ModelInfo, ReasoningEffort } from '../config/types.js';
import { withProviderRetry } from './retry.js';
import { providerRequestSignal } from './fetch.js';

export const FIREWORKS_KNOWN_REASONING: Record<string, ReasoningEffort[]> = {
  'accounts/fireworks/models/deepseek-r1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'accounts/fireworks/models/qwq-32b': ['low', 'medium', 'high'],
  'accounts/fireworks/models/deepseek-v3': [],
  'accounts/fireworks/models/llama-v3p3-70b-instruct': [],
  'accounts/fireworks/models/llama-v3p1-405b-instruct': [],
};

export class FireworksCatalog {
  static async fetchLiveModels(apiKey: string): Promise<ModelInfo[]> {
    const url = 'https://api.fireworks.ai/inference/v1/models';

    const rawData: any = await withProviderRetry(async () => {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: providerRequestSignal(),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const error = new Error(`Fireworks returned ${res.status}: ${errBody}`);
        (error as any).status = res.status;
        (error as any).headers = res.headers;
        throw error;
      }

      return await res.json();
    });

    const modelsList: any[] = Array.isArray(rawData) ? rawData : rawData?.data || [];
    const result: ModelInfo[] = [];

    for (const item of modelsList) {
      const isObject = item !== null && typeof item === 'object';
      const id = typeof item === 'string' ? item : isObject ? item.id || item.name : undefined;
      if (typeof id !== 'string' || !id) continue;

      const name = isObject && typeof item.name === 'string' ? item.name : id;
      const description = isObject && typeof item.description === 'string' ? item.description : undefined;

      const reasoningEfforts = FIREWORKS_KNOWN_REASONING[id] || [];
      const acceptsImages = id.includes('vision') || id.includes('vl');
      const contextWindow = isObject && typeof item.context_length === 'number' ? item.context_length : 128000;

      result.push({
        id,
        name,
        description,
        capabilities: {
          reasoningEfforts,
          acceptsImages,
          contextWindow,
        },
      });
    }

    return result;
  }
}
