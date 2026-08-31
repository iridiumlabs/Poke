import {
  ModelInfo,
  ModelSelection,
  ProviderType,
  ServiceCredentials,
} from '../config/types.js';
import { CommandCodeCatalog } from './commandcode.js';
import { FireworksCatalog } from './fireworks.js';
import { CodexCatalog } from './codex.js';

export class ProviderRegistry {
  static async fetchModels(
    provider: ProviderType,
    credentials: ServiceCredentials
  ): Promise<ModelInfo[]> {
    switch (provider) {
      case 'commandcode': {
        if (!credentials.commandCodeApiKey) {
          throw new Error('Command Code API key is missing. Run `poke login` to authenticate.');
        }
        return await CommandCodeCatalog.fetchLiveModels(credentials.commandCodeApiKey);
      }
      case 'fireworks': {
        if (!credentials.fireworksApiKey) {
          throw new Error('Fireworks API key is missing. Run `poke login` to authenticate.');
        }
        return await FireworksCatalog.fetchLiveModels(credentials.fireworksApiKey);
      }
      case 'codex': {
        return await CodexCatalog.fetchLiveModels(credentials.codexAuth?.accessToken);
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
      const found = models.find((m) => m.id === selection.model);

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
