import fs from 'fs';
import path from 'path';
import { ModelCapabilities, ModelInfo, ReasoningEffort } from '../config/types.js';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from './retry.js';

// Precedence 3: Bundled fallback map for known models
export const BUNDLED_KNOWN_MODELS: Record<string, Partial<ModelCapabilities>> = {
  'claude-sonnet-5': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1000000,
  },
  'claude-sonnet-4-6': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1000000,
  },
  'claude-fable-5': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1000000,
  },
  'claude-opus-5': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1000000,
  },
  'claude-opus-4-8': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1000000,
  },
  'claude-opus-4-7': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1000000,
  },
  'gpt-5.6-sol': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1050000,
  },
  'gpt-5.6-terra': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1050000,
  },
  'gpt-5.6-luna': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsImages: true,
    contextWindow: 1050000,
  },
  'google/gemini-3.7-flash': {
    reasoningEfforts: ['low', 'medium', 'high'],
    acceptsImages: true,
    contextWindow: 1048576,
  },
  'google/gemini-3.6-flash': {
    reasoningEfforts: ['low', 'medium', 'high'],
    acceptsImages: true,
    contextWindow: 1000000,
  },
  'google/gemini-3.5-flash': {
    reasoningEfforts: ['low', 'medium', 'high'],
    acceptsImages: true,
    contextWindow: 1000000,
  },
  'xai/grok-4.5': {
    reasoningEfforts: ['low', 'medium', 'high'],
    acceptsImages: true,
    contextWindow: 500000,
  },
  'xai/grok-4.6': {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    acceptsImages: false,
    contextWindow: 500000,
  },
};

export class CommandCodeCatalog {
  private static packageMetadataCache: Map<string, Partial<ModelCapabilities>> | null = null;

  static extractPackageMetadata(): Map<string, Partial<ModelCapabilities>> {
    if (this.packageMetadataCache) {
      return this.packageMetadataCache;
    }

    const metadataMap = new Map<string, Partial<ModelCapabilities>>();

    try {
      // Look for command-code/dist/cli.mjs
      const cliPath = path.resolve('node_modules/command-code/dist/cli.mjs');
      if (fs.existsSync(cliPath)) {
        const content = fs.readFileSync(cliPath, 'utf8');
        const modelPattern =
          /\{id:"([^"]+)",(?:inputModalities:\[([^\]]*)\],)?(?:provider:[^,]+,)?(?:spec:[^,]+,)?(?:label:"([^"]+)",)?(?:name:"([^"]+)",)?(?:description:"([^"]+)",)?(?:vendorLabel:"([^"]+)",)?(?:reasoning:(!0|!1|true|false),)?(?:reasoningEfforts:\[([^\]]*)\],)?(?:contextWindow:([^},]+))?[^}]*\}/g;

        let match;
        while ((match = modelPattern.exec(content)) !== null) {
          const [, id, inputModalities, , , , , , reasoningEfforts, contextWindow] = match;
          if (id && !id.includes(' ') && !id.startsWith('http')) {
            const efforts: ReasoningEffort[] = [];
            if (reasoningEfforts) {
              const rawEfforts = reasoningEfforts
                .split(',')
                .map((s) => s.replace(/['"]/g, '').trim().toLowerCase());
              for (const e of rawEfforts) {
                if (['low', 'medium', 'high', 'xhigh', 'max'].includes(e)) {
                  efforts.push(e as ReasoningEffort);
                }
              }
            }

            const acceptsImages = inputModalities ? inputModalities.includes('image') : undefined;
            let ctxWin: number | undefined;
            if (contextWindow) {
              try {
                // Safe numeric evaluation for expressions like 1e6 or 105e4
                const clean = contextWindow.trim();
                if (/^[\d\.e\+]+$/.test(clean)) {
                  ctxWin = Number(clean);
                }
              } catch {
                // Ignore parse errors
              }
            }

            metadataMap.set(id, {
              reasoningEfforts: efforts,
              acceptsImages,
              contextWindow: ctxWin,
            });
          }
        }
      }
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Failed to extract command-code package metadata');
    }

    this.packageMetadataCache = metadataMap;
    return metadataMap;
  }

  static async fetchLiveModels(apiKey: string): Promise<ModelInfo[]> {
    const logger = getLogger();
    const url = 'https://api.commandcode.ai/provider/v1/models';

    const rawData: any = await withProviderRetry(async () => {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const error = new Error(`Command Code returned ${res.status}: ${errBody}`);
        (error as any).status = res.status;
        throw error;
      }

      return await res.json();
    });

    const packageMeta = this.extractPackageMetadata();
    const modelsList: any[] = Array.isArray(rawData) ? rawData : rawData.data || rawData.models || [];

    const result: ModelInfo[] = [];

    for (const item of modelsList) {
      const id = typeof item === 'string' ? item : item.id || item.name;
      if (!id) continue;

      const name = typeof item === 'object' && item.name ? item.name : id;
      const description = typeof item === 'object' ? item.description : undefined;

      // Precedence 1: Live API reasoning-effort metadata
      let reasoningEfforts: ReasoningEffort[] = [];
      let acceptsImages: boolean | undefined;
      let contextWindow: number | undefined;

      if (typeof item === 'object') {
        if (Array.isArray(item.reasoningEfforts) && item.reasoningEfforts.length > 0) {
          reasoningEfforts = item.reasoningEfforts.filter((e: string) =>
            ['low', 'medium', 'high', 'xhigh', 'max'].includes(e.toLowerCase())
          );
        }
        if (typeof item.acceptsImages === 'boolean') {
          acceptsImages = item.acceptsImages;
        }
        if (typeof item.contextWindow === 'number') {
          contextWindow = item.contextWindow;
        }
      }

      // Precedence 2: Official package metadata if live didn't specify reasoningEfforts
      if (reasoningEfforts.length === 0 && packageMeta.has(id)) {
        const meta = packageMeta.get(id)!;
        if (meta.reasoningEfforts && meta.reasoningEfforts.length > 0) {
          reasoningEfforts = meta.reasoningEfforts;
        }
        if (acceptsImages === undefined && meta.acceptsImages !== undefined) {
          acceptsImages = meta.acceptsImages;
        }
        if (contextWindow === undefined && meta.contextWindow !== undefined) {
          contextWindow = meta.contextWindow;
        }
      }

      // Precedence 3: Bundled fallback map for known models
      if (reasoningEfforts.length === 0 && BUNDLED_KNOWN_MODELS[id]) {
        const bundled = BUNDLED_KNOWN_MODELS[id];
        if (bundled.reasoningEfforts && bundled.reasoningEfforts.length > 0) {
          reasoningEfforts = bundled.reasoningEfforts;
        }
        if (acceptsImages === undefined && bundled.acceptsImages !== undefined) {
          acceptsImages = bundled.acceptsImages;
        }
        if (contextWindow === undefined && bundled.contextWindow !== undefined) {
          contextWindow = bundled.contextWindow;
        }
      }

      // Precedence 4: Unknown model with no metadata -> empty reasoningEfforts (default reasoning)

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
