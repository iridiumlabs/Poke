import { Composio } from '@composio/core';
import crypto from 'node:crypto';
import { PokeDatabase } from '../db/database.js';
import { getLogger } from '../logger/logger.js';
import { providerRequestSignal } from '../providers/fetch.js';
import { withProviderRetry } from '../providers/retry.js';

export interface ComposioSearchParams {
  query: string;
}

export interface ComposioExecuteParams {
  action: string;
  params?: Record<string, unknown>;
  connected_account_id?: string;
  /** Stable Poke key for an external action's durable tool step. */
  idempotencyKey?: string;
}

export interface ComposioCatalogTool {
  slug: string;
  name: string;
  description?: string;
  inputParameters?: unknown;
}

export interface ComposioConnectedAccount {
  id: string;
  toolkit: string;
  alias?: string;
  status: string;
}

export interface ComposioExecutionOptions {
  signal?: AbortSignal;
  connectedAccountId?: string;
}

export interface ComposioClient {
  listTools(query: string, options?: { signal?: AbortSignal }): Promise<readonly ComposioCatalogTool[]>;
  listConnectedAccounts?(options?: { signal?: AbortSignal }): Promise<readonly ComposioConnectedAccount[]>;
  execute(
    action: string,
    params: Record<string, unknown>,
    options?: ComposioExecutionOptions
  ): Promise<unknown>;
}

export type ComposioClientFactory = (apiKey: string) => ComposioClient;

export const COMPOSIO_OWNER_ID = 'owner';
export const COMPOSIO_CATALOG_TTL_MS = 5 * 60 * 1000;

function createComposioClient(apiKey: string): ComposioClient {
  const composio = new Composio({ apiKey });

  return {
    async listTools(
      query: string,
      options?: { signal?: AbortSignal }
    ): Promise<readonly ComposioCatalogTool[]> {
      return await composio.tools.getRawComposioTools(
        { search: query },
        undefined,
        { signal: options?.signal }
      );
    },
    async listConnectedAccounts(
      options?: { signal?: AbortSignal }
    ): Promise<readonly ComposioConnectedAccount[]> {
      const response = await composio.connectedAccounts.list(
        { userIds: [COMPOSIO_OWNER_ID], limit: 100 },
        { signal: options?.signal }
      );
      return response.items.map((account) => ({
        id: account.id,
        toolkit: account.toolkit.slug,
        ...(account.alias ? { alias: account.alias } : {}),
        status: account.status,
      }));
    },
    async execute(
      action: string,
      params: Record<string, unknown>,
      options?: ComposioExecutionOptions
    ): Promise<unknown> {
      // Poke returns tool results to the agent instead of parsing a stable
      // application schema, so Composio permits the account's current toolkit
      // version for this direct execution.
      return await composio.tools.execute(action, {
        userId: COMPOSIO_OWNER_ID,
        arguments: params,
        dangerouslySkipVersionCheck: true,
        ...(options?.connectedAccountId ? { connectedAccountId: options.connectedAccountId } : {}),
      }, { signal: options?.signal });
    },
  };
}

interface CatalogCacheEntry {
  tools: readonly ComposioCatalogTool[];
  expiresAt: number;
}

export class ComposioToolHandler {
  private client: ComposioClient | null = null;
  private catalogCache = new Map<string, CatalogCacheEntry>();
  private catalogGeneration = 0;

  constructor(
    private apiKey?: string,
    private readonly clientFactory: ComposioClientFactory = createComposioClient,
    private readonly db?: PokeDatabase
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
    params: ComposioSearchParams,
    signal?: AbortSignal
  ): Promise<{
    actions: Array<{ name: string; description?: string; parameters?: unknown }>;
    connected_accounts: ComposioConnectedAccount[];
  }> {
    if (!this.apiKey || !this.client) {
      throw new Error('Composio API key is not configured. Add it with `poke configure`.');
    }

    const query = params.query.trim();
    if (!query) {
      throw new Error('Composio search query is required.');
    }

    const requestSignal = providerRequestSignal(signal);
    const [tools, connectedAccounts] = await Promise.all([
      withProviderRetry(() => this.getCatalog(query, requestSignal), { signal: requestSignal }),
      this.client!.listConnectedAccounts
        ? withProviderRetry(
            () => this.client!.listConnectedAccounts!({ signal: requestSignal }),
            { signal: requestSignal }
          )
        : Promise.resolve<readonly ComposioConnectedAccount[]>([]),
    ]);
    return {
      actions: tools
        .filter((tool) => !hasFileTransferParameter(tool.inputParameters))
        .slice(0, 10)
        .map((tool) => ({
          name: tool.slug,
          description: tool.description,
          parameters: tool.inputParameters,
        })),
      connected_accounts: Array.from(connectedAccounts),
    };
  }

  async execute(
    params: ComposioExecuteParams,
    signal?: AbortSignal
  ): Promise<{ result: unknown }> {
    if (!this.apiKey || !this.client) {
      throw new Error('Composio API key is not configured. Add it with `poke configure`.');
    }

    const action = params.action.trim();
    if (!action) {
      throw new Error('Composio action is required.');
    }

    const requestSignal = providerRequestSignal(signal);
    const connectedAccountId = params.connected_account_id?.trim() || undefined;
    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ action, params: params.params || {}, connectedAccountId }))
      .digest('hex');
    if (params.idempotencyKey && this.db) {
      const existing = this.db.getOutgoingDelivery(params.idempotencyKey);
      if (existing) {
        if (existing.action_type !== 'composio_execute' || existing.payload_hash !== payloadHash) {
          throw new Error('This Composio action key is already associated with different input.');
        }
        if (existing.status === 'pending') {
          throw new Error('Composio action outcome is unknown. Refusing to replay it automatically.');
        }
        try {
          return { result: JSON.parse(existing.response_data || 'null') };
        } catch {
          throw new Error('Completed Composio action has an unreadable stored result.');
        }
      }
    }

    if (connectedAccountId) {
      if (!this.client.listConnectedAccounts) {
        throw new Error('This Composio client cannot validate connected accounts.');
      }
      const accounts = await this.client.listConnectedAccounts({ signal: requestSignal });
      if (!accounts.some((account) => account.id === connectedAccountId && account.status === 'ACTIVE')) {
        throw new Error(`Connected account "${connectedAccountId}" is not active for this Poke owner.`);
      }
    }

    if (params.idempotencyKey && this.db) {
      const reservation = this.db.reserveOutgoingDelivery(
        params.idempotencyKey,
        'composio_execute',
        payloadHash
      );
      if (!reservation.created) {
        if (reservation.record.status === 'pending') {
          throw new Error('Composio action outcome is unknown. Refusing to replay it automatically.');
        }
        try {
          return { result: JSON.parse(reservation.record.response_data || 'null') };
        } catch {
          throw new Error('Completed Composio action has an unreadable stored result.');
        }
      }
    }

    // Composio actions can mutate external services. The SDK disables its own
    // execution retries; a timeout/cancellation remains an unknown outcome.
    try {
      const result = await this.client.execute(action, params.params || {}, {
        signal: requestSignal,
        connectedAccountId,
      });
      if (params.idempotencyKey && this.db) {
        this.db.completeOutgoingDelivery(
          params.idempotencyKey,
          'composio_execute',
          payloadHash,
          JSON.stringify(result) ?? 'null'
        );
      }
      return { result };
    } catch (error: any) {
      if (params.idempotencyKey && this.db && requestSignal.aborted) {
        throw new Error('Composio action was interrupted and its outcome is unknown.', { cause: error });
      }
      throw error;
    }
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

  private async getCatalog(
    query: string,
    signal: AbortSignal
  ): Promise<readonly ComposioCatalogTool[]> {
    const now = Date.now();
    const cached = this.catalogCache.get(query);
    if (cached && cached.expiresAt > now) {
      return cached.tools;
    }

    const client = this.client;
    if (!client) {
      throw new Error('Composio API key is not configured. Add it with `poke configure`.');
    }

    const generation = this.catalogGeneration;
    const tools = Array.from(await client.listTools(query, { signal }));
    if (this.catalogGeneration === generation) {
      this.catalogCache.set(query, {
        tools,
        expiresAt: now + COMPOSIO_CATALOG_TTL_MS,
      });
    }
    return tools;
  }
}

function hasFileTransferParameter(value: unknown, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (record.file_uploadable === true || record.file_downloadable === true) return true;
  return Object.values(record).some((nested) => {
    if (Array.isArray(nested)) return nested.some((item) => hasFileTransferParameter(item, seen));
    return hasFileTransferParameter(nested, seen);
  });
}
