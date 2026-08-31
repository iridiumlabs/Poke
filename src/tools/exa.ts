import { Exa } from 'exa-js';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';

export interface WebSearchParams {
  query: string;
  num_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  start_published_date?: string;
  end_published_date?: string;
}

export interface WebSearchItem {
  title?: string | null;
  url: string;
  published_date?: string | null;
  text?: string;
  highlights?: string[];
}

export interface WebFetchParams {
  url: string;
  max_characters?: number;
}

export interface WebFetchResult {
  url: string;
  title?: string | null;
  text: string;
  published_date?: string | null;
}

export class ExaToolHandler {
  private client: Exa | null = null;

  constructor(private apiKey?: string) {
    if (apiKey) {
      this.client = new Exa(apiKey);
    }
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.client = new Exa(apiKey);
  }

  async search(params: WebSearchParams): Promise<{ results: WebSearchItem[] }> {
    if (!this.client) {
      throw new Error('Exa API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info({ query: params.query }, 'Executing web search via Exa');

    return await withProviderRetry(async () => {
      const res = await this.client!.searchAndContents(params.query, {
        numResults: Math.min(params.num_results || 5, 10),
        includeDomains: params.include_domains,
        excludeDomains: params.exclude_domains,
        startPublishedDate: params.start_published_date,
        endPublishedDate: params.end_published_date,
        text: { maxCharacters: 1500 },
        highlights: { numSentences: 3 },
      });

      const results: WebSearchItem[] = (res.results || []).map((r: any) => ({
        title: r.title,
        url: r.url,
        published_date: r.publishedDate,
        text: r.text ? r.text.slice(0, 1500) : undefined,
        highlights: r.highlights,
      }));

      return { results };
    });
  }

  async fetch(params: WebFetchParams): Promise<WebFetchResult> {
    if (!this.client) {
      throw new Error('Exa API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info({ url: params.url }, 'Fetching webpage content via Exa');

    const maxChars = Math.min(params.max_characters || 15000, 30000);

    return await withProviderRetry(async () => {
      const res = await this.client!.getContents([params.url], {
        text: { maxCharacters: maxChars },
      });

      const result = res.results?.[0];
      if (!result) {
        throw new Error(`Could not fetch contents for URL: ${params.url}`);
      }

      return {
        url: result.url,
        title: result.title,
        text: (result.text || '').slice(0, maxChars),
        published_date: result.publishedDate,
      };
    });
  }
}
