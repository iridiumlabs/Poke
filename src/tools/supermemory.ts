import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';
import { providerRequestSignal } from '../providers/fetch.js';

export interface MemorySaveParams {
  content: string;
  metadata?: Record<string, string>;
}

export interface MemoryRecallParams {
  query: string;
  limit?: number;
}

export interface MemoryItem {
  id: string;
  content: string;
  metadata?: Record<string, any>;
  score?: number;
  created_at?: string;
}

export class SupermemoryToolHandler {
  private baseUrl = 'https://api.supermemory.ai/v3';

  constructor(private apiKey?: string, private containerId: string = 'owner') {}

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async save(params: MemorySaveParams): Promise<{ success: boolean; id?: string }> {
    if (!this.apiKey) {
      throw new Error('Supermemory API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info({ containerId: this.containerId }, 'Saving memory to Supermemory');
    const customId = `poke-${randomUUID()}`;
    const savedAt = new Date().toISOString();

    return await withProviderRetry(async () => {
      const res = await fetch(`${this.baseUrl}/memories`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: providerRequestSignal(),
        body: JSON.stringify({
          content: params.content,
          containerId: this.containerId,
          customId,
          metadata: {
            ...params.metadata,
            savedAt,
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Supermemory save returned ${res.status}: ${text}`);
        (err as any).status = res.status;
        (err as any).headers = res.headers;
        throw err;
      }

      const data = (await res.json()) as any;
      return { success: true, id: data.id || data.memoryId || data.uuid };
    });
  }

  async recall(params: MemoryRecallParams): Promise<{ results: MemoryItem[] }> {
    if (!this.apiKey) {
      throw new Error('Supermemory API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info({ query: params.query, containerId: this.containerId }, 'Recalling memories from Supermemory');

    return await withProviderRetry(async () => {
      const res = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: providerRequestSignal(),
        body: JSON.stringify({
          query: params.query,
          containerId: this.containerId,
          limit: Math.min(params.limit || 5, 10),
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Supermemory recall returned ${res.status}: ${text}`);
        (err as any).status = res.status;
        (err as any).headers = res.headers;
        throw err;
      }

      const data = (await res.json()) as any;
      const memories = Array.isArray(data)
        ? data
        : data.results || data.memories || data.data || [];

      const results: MemoryItem[] = memories.map((m: any) => ({
        id: m.id || m.memoryId || m.uuid || '',
        content: m.content || m.text || m.body || '',
        metadata: m.metadata,
        score: m.score ?? m.similarity,
        created_at: m.createdAt || m.created_at,
      }));

      return { results };
    });
  }
}
