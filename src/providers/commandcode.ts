import { ModelInfo } from '../config/types.js';
import { withProviderRetry } from './retry.js';
import { providerRequestSignal } from './fetch.js';

export const COMMAND_CODE_MANUAL_CATALOG: readonly ModelInfo[] = [
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    description: 'Fast, affordable GLM coding with 1M context',
    capabilities: {
      reasoningEfforts: ['low', 'high', 'max'],
      acceptsImages: true,
      contextWindow: 1050000,
    },
  },
];

export class CommandCodeCatalog {
  static getModels(): ModelInfo[] {
    return [...COMMAND_CODE_MANUAL_CATALOG];
  }

  static async fetchLiveModels(apiKey: string): Promise<ModelInfo[]> {
    return CommandCodeCatalog.validateApiKey(apiKey);
  }

  static async validateApiKey(apiKey: string): Promise<ModelInfo[]> {
    const url = 'https://api.commandcode.ai/provider/v1/models';

    await withProviderRetry(async () => {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: providerRequestSignal(),
      });

      if (!res.ok) {
        const error = new Error(`Command Code returned ${res.status}.`);
        (error as any).status = res.status;
        (error as any).headers = res.headers;
        throw error;
      }

      return await res.json();
    });

    return CommandCodeCatalog.getModels();
  }
}
