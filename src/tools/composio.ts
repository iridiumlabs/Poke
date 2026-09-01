import { Composio } from '@composio/core';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';

export interface ComposioSearchParams {
  query: string;
}

export interface ComposioExecuteParams {
  action: string;
  params?: Record<string, unknown>;
}

export interface ComposioCatalogTool {
  slug: string;
  name: string;
  description?: string;
  inputParameters?: unknown;
}

export interface ComposioClient {
  listTools(query: string): Promise<readonly ComposioCatalogTool[]>;
  execute(action: string, params: Record<string, unknown>): Promise<unknown>;
}

export type ComposioClientFactory = (apiKey: string) => ComposioClient;

export const COMPOSIO_OWNER_ID = 'owner';
export const COMPOSIO_CATALOG_TTL_MS = 5 * 60 * 1000;

function createComposioClient(apiKey: string): ComposioClient {
  const composio = new Composio({ apiKey });

  return {
    async listTools(query: string): Promise<readonly ComposioCatalogTool[]> {
      return await composio.tools.getRawComposioTools({ search: query });
    },
    async execute(action: string, params: Record<string, unknown>): Promise<unknown> {
      // Poke returns tool results to the agent instead of parsing a stable
      // application schema, so Composio permits the account's current toolkit
      // version for this direct execution.
      return await composio.tools.execute(action, {
        userId: COMPOSIO_OWNER_ID,
        arguments: params,
        dangerouslySkipVersionCheck: true,
      });
    },
  };
}

interface CatalogCacheEntry {
  promise: Promise<readonly ComposioCatalogTool[]>;
  expiresAt: number;
}

export class ComposioToolHandler {
  private client: ComposioClient | null = null;
  private catalogCache = new Map<string, CatalogCacheEntry>();
  private catalogGeneration = 0;

  constructor(
    private apiKey?: string,
    private readonly clientFactory: ComposioClientFactory = createComposioClient
  ) {
    this.rebuildClient();
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.catalogGeneration++;
    this.catalogCache.clear();
    this.rebuildClient();
  }

  async search(
    params: ComposioSearchParams
  ): Promise<{ actions: Array<{ name: string; description?: string; parameters?: unknown }> }> {
    if (!this.apiKey || !this.client) {
      throw new Error('Composio API key is not configured. Add it via `poke setup`.');
    }

    const query = params.query.trim();
    if (!query) {
      throw new Error('Composio search query is required.');
    }

    const tools = await withProviderRetry(() => this.getCatalog(query));
    return {
      actions: tools.slice(0, 10).map((tool) => ({
        name: tool.slug,
        description: tool.description,
        parameters: tool.inputParameters,
      })),
    };
  }

  async execute(params: ComposioExecuteParams): Promise<{ result: unknown }> {
    if (!this.apiKey || !this.client) {
      throw new Error('Composio API key is not configured. Add it via `poke setup`.');
    }

    const action = params.action.trim();
    if (!action) {
      throw new Error('Composio action is required.');
    }

    // Composio actions can mutate external services. Do not retry a request
    // whose outcome is ambiguous.
    return { result: await this.client.execute(action, params.params || {}) };
  }

  private rebuildClient(): void {
    if (!this.apiKey) {
      this.client = null;
      return;
    }

    try {
      this.client = this.clientFactory(this.apiKey);
    } catch (err: unknown) {
      this.client = null;
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to initialize Composio client'
      );
    }
  }

  private getCatalog(query: string): Promise<readonly ComposioCatalogTool[]> {
    const now = Date.now();
    const cached = this.catalogCache.get(query);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }

    const client = this.client;
    if (!client) {
      throw new Error('Composio API key is not configured. Add it via `poke setup`.');
    }

    const generation = this.catalogGeneration;
    const promise = client
      .listTools(query)
      .then((tools) => Array.from(tools))
      .catch((err: unknown) => {
        const current = this.catalogCache.get(query);
        if (this.catalogGeneration === generation && current?.promise === promise) {
          this.catalogCache.delete(query);
        }
        throw err;
      });

    this.catalogCache.set(query, {
      promise,
      expiresAt: now + COMPOSIO_CATALOG_TTL_MS,
    });
    return promise;
  }
}
