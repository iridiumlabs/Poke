import { describe, it, expect, vi } from 'vitest';
import { withProviderRetry, isTransientError, NonRetryableError } from '../../src/providers/retry.js';
import { CommandCodeCatalog } from '../../src/providers/commandcode.js';
import { ProviderRegistry, normalizeCatalogModelId } from '../../src/providers/provider-registry.js';
import { ComposioToolHandler } from '../../src/tools/composio.js';

describe('Provider Retry & Error Classification', () => {
  it('identifies transient errors correctly', () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientError(new Error('Rate limit exceeded'))).toBe(true);

    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
    expect(isTransientError(new NonRetryableError('Bad request'))).toBe(false);
  });

  it('retries transient errors with configured attempts', async () => {
    let attempts = 0;
    const result = await withProviderRetry(
      async (attempt) => {
        attempts++;
        if (attempt < 3) {
          const err = new Error('Gateway Timeout');
          (err as any).status = 504;
          throw err;
        }
        return 'success';
      },
      { delaysMs: [10, 20, 30, 40], jitter: false }
    );

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('fails fast on non-transient errors without 5 attempts', async () => {
    let attempts = 0;
    await expect(
      withProviderRetry(
        async () => {
          attempts++;
          const err = new Error('Invalid API Key');
          (err as any).status = 401;
          throw err;
        },
        { delaysMs: [10, 20, 30, 40], jitter: false }
      )
    ).rejects.toThrow('Invalid API Key');

    expect(attempts).toBe(1);
  });

  it('cancels a Retry-After wait when the caller aborts', async () => {
    const controller = new AbortController();
    let attempts = 0;
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });

    const retry = withProviderRetry(
      async () => {
        attempts++;
        operationStarted();
        const error = new Error('Too many requests');
        (error as any).status = 429;
        (error as any).headers = new Headers({ 'retry-after': '10' });
        throw error;
      },
      { signal: controller.signal, jitter: false }
    );

    await started;
    controller.abort(new Error('runtime stopped'));
    await expect(retry).rejects.toThrow('runtime stopped');
    expect(attempts).toBe(1);
  });

  it('fails fast without retry when Retry-After exceeds maxDelayMs', async () => {
    let attempts = 0;
    const retry = withProviderRetry(
      async () => {
        attempts++;
        const error = new Error('Too many requests');
        (error as any).status = 429;
        (error as any).headers = new Headers({ 'retry-after': '86400' });
        throw error;
      },
      { maxDelayMs: 5000, jitter: false }
    );

    await expect(retry).rejects.toThrow(/exceeds maximum allowed delay/);
    expect(attempts).toBe(1);
  });
});

describe('CommandCodeCatalog', () => {
  it('extracts package metadata from official command-code cli.mjs', () => {
    const meta = CommandCodeCatalog.extractPackageMetadata();
    expect(meta.size).toBeGreaterThan(0);

    const sonnetMeta = meta.get('claude-sonnet-4-6');
    expect(sonnetMeta).toBeDefined();
    expect(sonnetMeta?.reasoningEfforts).toContain('low');
    expect(sonnetMeta?.reasoningEfforts).toContain('high');
  });

  it('normalizes live reasoning effort metadata without accepting malformed values', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'model-a', reasoningEfforts: ['HIGH', 'not-an-effort', 5, null] }],
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const models = await CommandCodeCatalog.fetchLiveModels('test-key');
      expect(models).toHaveLength(1);
      expect(models[0].capabilities.reasoningEfforts).toEqual(['high']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns empty list when live catalog data or models property is not an array', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: { invalid: 'object' },
          models: 'not-an-array',
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const models = await CommandCodeCatalog.fetchLiveModels('test-key');
      expect(models).toEqual([]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('resolveFlueModelSpecifier', () => {
  it('correctly maps provider and model selections to provider/model format', async () => {
    const { resolveFlueModelSpecifier } = await import('../../src/providers/provider-registry.js');

    expect(resolveFlueModelSpecifier({ provider: 'codex', model: 'gpt-4o' })).toBe('openai-codex/gpt-4o');
    expect(resolveFlueModelSpecifier({ provider: 'commandcode', model: 'claude-sonnet-4-6' })).toBe('commandcode/claude-sonnet-4-6');
    expect(resolveFlueModelSpecifier({ provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-r1' })).toBe('fireworks/accounts/fireworks/models/deepseek-r1');
    expect(resolveFlueModelSpecifier({ provider: 'codex', model: 'openai-codex/o3-mini' })).toBe('openai-codex/o3-mini');
  });

  it('matches provider-qualified configuration IDs with bare live catalog IDs', async () => {
    expect(normalizeCatalogModelId('openai-codex/gpt-4o', 'codex')).toBe('gpt-4o');
    expect(normalizeCatalogModelId('commandcode/claude-sonnet-4-6', 'commandcode')).toBe('claude-sonnet-4-6');
    expect(normalizeCatalogModelId('fireworks/accounts/fireworks/models/deepseek-r1', 'fireworks')).toBe(
      'accounts/fireworks/models/deepseek-r1'
    );

    const fetchModels = vi.spyOn(ProviderRegistry, 'fetchModels').mockResolvedValue([
      {
        id: 'gpt-4o',
        name: 'gpt-4o',
        capabilities: { reasoningEfforts: [] },
      },
    ]);
    try {
      await expect(
        ProviderRegistry.validateSelection(
          { provider: 'codex', model: 'openai-codex/gpt-4o' },
          {}
        )
      ).resolves.toMatchObject({ valid: true, modelInfo: { id: 'gpt-4o' } });
    } finally {
      fetchModels.mockRestore();
    }
  });

  it('uses environment credentials while validating a provider selection', async () => {
    const previousKey = process.env.COMMANDCODE_API_KEY;
    process.env.COMMANDCODE_API_KEY = 'env-command-code-key';
    const fetchLiveModels = vi.spyOn(CommandCodeCatalog, 'fetchLiveModels').mockResolvedValue([]);

    try {
      await ProviderRegistry.fetchModels('commandcode', {});
      expect(fetchLiveModels).toHaveBeenCalledWith('env-command-code-key');
    } finally {
      fetchLiveModels.mockRestore();
      if (previousKey === undefined) {
        delete process.env.COMMANDCODE_API_KEY;
      } else {
        process.env.COMMANDCODE_API_KEY = previousKey;
      }
    }
  });
});

describe('ComposioToolHandler', () => {
  it('caches the locally filtered catalog and does not retry externally mutating actions', async () => {
    const handler = new ComposioToolHandler('test-key');
    const toolset = {
      getTools: vi.fn().mockResolvedValue([
        {
          function: {
            name: 'GMAIL_SEND_EMAIL',
            description: 'Send an email through Gmail.',
            parameters: { type: 'object' },
          },
        },
      ]),
      executeAction: vi.fn().mockRejectedValue(new Error('connection reset after action')),
    };
    (handler as any).toolset = toolset;

    await expect(handler.search({ query: 'email' })).resolves.toMatchObject({
      actions: [{ name: 'GMAIL_SEND_EMAIL' }],
    });
    await expect(handler.search({ query: 'gmail' })).resolves.toMatchObject({
      actions: [{ name: 'GMAIL_SEND_EMAIL' }],
    });
    expect(toolset.getTools).toHaveBeenCalledTimes(1);

    await expect(handler.execute({ action: 'GMAIL_SEND_EMAIL' })).rejects.toThrow(
      'connection reset after action'
    );
    expect(toolset.executeAction).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached catalog across setApiKey generations and ignores stale resolutions', async () => {
    const handler = new ComposioToolHandler('initial-key');
    let resolveFirst!: (value: any) => void;
    const firstPromise = new Promise<any[]>((res) => {
      resolveFirst = res;
    });

    const firstToolset = {
      getTools: vi.fn().mockReturnValue(firstPromise),
    };
    (handler as any).toolset = firstToolset;

    // Start in-flight catalog fetch for first generation
    const search1 = handler.search({ query: 'first' });

    // Rotate API key while first fetch is pending
    handler.setApiKey('second-key');
    const secondToolset = {
      getTools: vi.fn().mockResolvedValue([
        { function: { name: 'SECOND_TOOL', description: 'Second tool description' } },
      ]),
    };
    (handler as any).toolset = secondToolset;

    // Resolve the first (stale) catalog fetch
    resolveFirst([{ function: { name: 'FIRST_TOOL', description: 'First tool description' } }]);
    await expect(search1).resolves.toMatchObject({
      actions: [{ name: 'FIRST_TOOL' }],
    });

    // A search on the new key should fetch with the new toolset
    await expect(handler.search({ query: 'second' })).resolves.toMatchObject({
      actions: [{ name: 'SECOND_TOOL' }],
    });
    expect(secondToolset.getTools).toHaveBeenCalledTimes(1);
  });
});
