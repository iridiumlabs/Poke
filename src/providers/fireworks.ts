import { ModelInfo, ReasoningEffort } from '../config/types.js';
import { withProviderRetry } from './retry.js';

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
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const error = new Error(`Fireworks returned ${res.status}: ${errBody}`);
        (error as any).status = res.status;
        throw error;
      }

      return await res.json();
    });

    const modelsList: any[] = Array.isArray(rawData) ? rawData : rawData.data || [];
    const result: ModelInfo[] = [];

    for (const item of modelsList) {
      const id = typeof item === 'string' ? item : item.id || item.name;
      if (!id) continue;

      const name = typeof item === 'object' && item.name ? item.name : id;
      const description = typeof item === 'object' ? item.description : undefined;

      const reasoningEfforts = FIREWORKS_KNOWN_REASONING[id] || [];
      const acceptsImages = id.includes('vision') || id.includes('vl');
      const contextWindow = typeof item === 'object' && item.context_length ? item.context_length : 128000;

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
