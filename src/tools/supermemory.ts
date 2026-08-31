import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';

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
  private baseUrl = 'https://api.supermemory.ai/v1';

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

    return await withProviderRetry(async () => {
      const res = await fetch(`${this.baseUrl}/memories`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: params.content,
          containerId: this.containerId,
          metadata: {
            ...params.metadata,
            savedAt: new Date().toISOString(),
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Supermemory save returned ${res.status}: ${text}`);
        (err as any).status = res.status;
        throw err;
      }

      const data = (await res.json()) as any;
      return { success: true, id: data.id || data.memoryId };
    });
  }

  async recall(params: MemoryRecallParams): Promise<{ results: MemoryItem[] }> {
    if (!this.apiKey) {
      throw new Error('Supermemory API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info({ query: params.query, containerId: this.containerId }, 'Recalling memories from Supermemory');

    return await withProviderRetry(async () => {
      const url = new URL(`${this.baseUrl}/memories/search`);
      url.searchParams.set('q', params.query);
      url.searchParams.set('containerId', this.containerId);
      url.searchParams.set('limit', String(Math.min(params.limit || 5, 10)));

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Supermemory recall returned ${res.status}: ${text}`);
        (err as any).status = res.status;
        throw err;
      }

      const data = (await res.json()) as any;
      const memories = Array.isArray(data) ? data : data.memories || data.results || [];

      const results: MemoryItem[] = memories.map((m: any) => ({
        id: m.id || m.memoryId,
        content: m.content || m.text || '',
        metadata: m.metadata,
        score: m.score,
        created_at: m.createdAt || m.created_at,
      }));

      return { results };
    });
  }
}
