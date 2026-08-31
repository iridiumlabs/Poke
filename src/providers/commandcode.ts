import fs from 'fs';
import { createRequire } from 'node:module';
import { ModelCapabilities, ModelInfo, ReasoningEffort } from '../config/types.js';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from './retry.js';
import { providerRequestSignal } from './fetch.js';

const requireFromHere = createRequire(import.meta.url);
const REASONING_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

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
      // Resolve from this package, not the caller's working directory.
      const cliPath = requireFromHere.resolve('command-code/dist/cli.mjs');
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
            for (const effort of rawEfforts) {
              if (REASONING_EFFORTS.has(effort as ReasoningEffort)) {
                efforts.push(effort as ReasoningEffort);
              }
            }
          }

          const acceptsImages = inputModalities ? inputModalities.includes('image') : undefined;
          let ctxWin: number | undefined;
          if (contextWindow) {
            // Safe numeric evaluation for expressions like 1e6 or 105e4
            const clean = contextWindow.trim();
            if (/^[\d\.e\+]+$/.test(clean)) {
              const parsed = Number(clean);
              if (Number.isFinite(parsed)) {
                ctxWin = parsed;
              }
            }
          }

          metadataMap.set(id, {
            reasoningEfforts: efforts,
            acceptsImages,
            contextWindow: ctxWin,
          });
        }
      }
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Failed to extract command-code package metadata');
      // Do not cache an absent or unreadable package: it may become available later.
      return metadataMap;
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
        signal: providerRequestSignal(),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const error = new Error(`Command Code returned ${res.status}: ${errBody}`);
        (error as any).status = res.status;
        (error as any).headers = res.headers;
        throw error;
      }

      return await res.json();
    });

    const packageMeta = this.extractPackageMetadata();
    const modelsList: any[] = Array.isArray(rawData) ? rawData : rawData?.data || rawData?.models || [];

    const result: ModelInfo[] = [];

    for (const item of modelsList) {
      const isObject = item !== null && typeof item === 'object';
      const id = typeof item === 'string' ? item : isObject ? item.id || item.name : undefined;
      if (typeof id !== 'string' || !id) continue;

      const name = isObject && typeof item.name === 'string' ? item.name : id;
      const description = isObject && typeof item.description === 'string' ? item.description : undefined;

      // Precedence 1: Live API reasoning-effort metadata
      let reasoningEfforts: ReasoningEffort[] = [];
      let acceptsImages: boolean | undefined;
      let contextWindow: number | undefined;

      if (isObject) {
        if (Array.isArray(item.reasoningEfforts) && item.reasoningEfforts.length > 0) {
          reasoningEfforts = item.reasoningEfforts
            .filter((effort: unknown): effort is string => typeof effort === 'string')
            .map((effort: string) => effort.trim().toLowerCase())
            .filter((effort: string): effort is ReasoningEffort =>
              REASONING_EFFORTS.has(effort as ReasoningEffort)
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
