import { OpenAIToolSet } from 'composio-core';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';

export interface ComposioSearchParams {
  query: string;
}

export interface ComposioExecuteParams {
  action: string;
  params?: Record<string, any>;
}

export class ComposioToolHandler {
  private toolset: OpenAIToolSet | null = null;

  constructor(private apiKey?: string) {
    if (apiKey) {
      try {
        this.toolset = new OpenAIToolSet({ apiKey });
      } catch (err: any) {
        getLogger().warn({ err: err.message }, 'Failed to initialize Composio toolset');
      }
    }
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    try {
      this.toolset = new OpenAIToolSet({ apiKey });
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Failed to reinitialize Composio toolset');
    }
  }

  async search(params: ComposioSearchParams): Promise<{ actions: any[] }> {
    if (!this.apiKey || !this.toolset) {
      throw new Error('Composio API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info({ query: params.query }, 'Searching Composio actions');

    return await withProviderRetry(async () => {
      // Use Composio client to search actions/tools
      const tools = await this.toolset!.getTools({
        actions: [],
      });

      // Filter or query matching tools
      const queryLower = params.query.toLowerCase();
      const filtered = (tools || []).filter((t: any) => {
        const name = (t.function?.name || '').toLowerCase();
        const desc = (t.function?.description || '').toLowerCase();
        return name.includes(queryLower) || desc.includes(queryLower);
      });

      return {
        actions: filtered.slice(0, 10).map((t: any) => ({
          name: t.function?.name,
          description: t.function?.description,
          parameters: t.function?.parameters,
        })),
      };
    });
  }

  async execute(params: ComposioExecuteParams): Promise<{ result: any }> {
    if (!this.apiKey || !this.toolset) {
      throw new Error('Composio API key is not configured. Add it via `poke setup`.');
    }

    const logger = getLogger();
    logger.info({ action: params.action }, 'Executing Composio action');

    return await withProviderRetry(async () => {
      const response = await this.toolset!.executeAction({
        action: params.action as any,
        params: params.params || {},
      });

      return { result: response };
    });
  }
}
