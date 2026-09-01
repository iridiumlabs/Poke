import crypto from 'node:crypto';
import { PokeDatabase } from '../db/database.js';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';
import { providerRequestSignal } from '../providers/fetch.js';

export interface MemorySaveParams {
  content: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface MemoryRecallParams {
  query: string;
  limit?: number;
}

export interface MemoryItem {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  score?: number;
  created_at?: string;
}

const SUPERMEMORY_V4_URL = 'https://api.supermemory.ai/v4';

export class SupermemoryToolHandler {
  constructor(
    private apiKey?: string,
    private readonly containerTag = 'poke-owner',
    private readonly db?: PokeDatabase
  ) {}

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async save(params: MemorySaveParams): Promise<{ success: boolean; id?: string }> {
    if (!this.apiKey) {
      throw new Error('Supermemory API key is not configured. Add it via `poke setup`.');
    }
    if (!params.content.trim()) {
      throw new Error('Memory content is required.');
    }

    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ content: params.content, metadata: params.metadata || {} }))
      .digest('hex');
    if (params.idempotencyKey && this.db) {
      const existing = this.db.getOutgoingDelivery(params.idempotencyKey);
      if (existing) {
        if (existing.action_type !== 'supermemory_save' || existing.payload_hash !== payloadHash) {
          throw new Error('This memory save key is already associated with different content.');
        }
        if (existing.status === 'pending') {
          throw new Error('Memory save outcome is unknown. Refusing to replay it automatically.');
        }
        return parseStoredMemoryResult(existing.response_data);
      }
      const reservation = this.db.reserveOutgoingDelivery(
        params.idempotencyKey,
        'supermemory_save',
        payloadHash
      );
      if (!reservation.created) {
        if (reservation.record.status === 'pending') {
          throw new Error('Memory save outcome is unknown. Refusing to replay it automatically.');
        }
        return parseStoredMemoryResult(reservation.record.response_data);
      }
    }

    getLogger().info({ containerTag: this.containerTag }, 'Saving memory to Supermemory');
    // The v4 memories endpoint has no Poke-controlled idempotency key. Do not
    // replay an ambiguous mutation after a transport failure.
    const response = await fetch(`${SUPERMEMORY_V4_URL}/memories`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: providerRequestSignal(params.signal),
      body: JSON.stringify({
        containerTag: this.containerTag,
        memories: [{ content: params.content, metadata: params.metadata }],
      }),
    });
    if (!response.ok) {
      throw providerError('Supermemory save', response.status, response.headers);
    }

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const memories = Array.isArray(data.memories) ? data.memories : [];
    const first = memories[0] as Record<string, unknown> | undefined;
    const result = {
      success: true,
      ...(typeof first?.id === 'string'
        ? { id: first.id }
        : typeof data.id === 'string'
          ? { id: data.id }
          : {}),
    };
    if (params.idempotencyKey && this.db) {
      this.db.completeOutgoingDelivery(
        params.idempotencyKey,
        'supermemory_save',
        payloadHash,
        JSON.stringify(result)
      );
    }
    return result;
  }

  async recall(params: MemoryRecallParams): Promise<{ results: MemoryItem[] }> {
    if (!this.apiKey) {
      throw new Error('Supermemory API key is not configured. Add it via `poke setup`.');
    }
    if (!params.query.trim()) {
      throw new Error('Memory search query is required.');
    }

    getLogger().info({ containerTag: this.containerTag }, 'Recalling memories from Supermemory');
    return await withProviderRetry(async () => {
      const response = await fetch(`${SUPERMEMORY_V4_URL}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: providerRequestSignal(),
        body: JSON.stringify({
          q: params.query,
          containerTag: this.containerTag,
          searchMode: 'memories',
          limit: Math.min(params.limit || 5, 10),
        }),
      });
      if (!response.ok) {
        throw providerError('Supermemory search', response.status, response.headers);
      }
      const data = (await response.json()) as Record<string, unknown>;
      const hits = Array.isArray(data.results) ? data.results : [];
      return {
        results: hits.flatMap((hit): MemoryItem[] => {
          if (!hit || typeof hit !== 'object') return [];
          const value = hit as Record<string, unknown>;
          const content = value.memory ?? value.content ?? value.chunk;
          if (typeof content !== 'string') return [];
          return [{
            id: typeof value.id === 'string' ? value.id : '',
            content,
            ...(value.metadata && typeof value.metadata === 'object'
              ? { metadata: value.metadata as Record<string, unknown> }
              : {}),
            ...(typeof value.similarity === 'number'
              ? { score: value.similarity }
              : typeof value.score === 'number'
                ? { score: value.score }
                : {}),
            ...(typeof value.createdAt === 'string'
              ? { created_at: value.createdAt }
              : typeof value.created_at === 'string'
                ? { created_at: value.created_at }
                : {}),
          }];
        }),
      };
    });
  }
}

function parseStoredMemoryResult(responseData: string | null | undefined): { success: boolean; id?: string } {
  try {
    return JSON.parse(responseData || '{}') as { success: boolean; id?: string };
  } catch {
    throw new Error('Completed memory save has an unreadable stored result.');
  }
}

function providerError(operation: string, status: number, headers: Headers): Error {
  const error = new Error(`${operation} returned ${status}.`);
  (error as any).status = status;
  (error as any).headers = headers;
  return error;
}
