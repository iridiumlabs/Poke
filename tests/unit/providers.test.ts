import { describe, it, expect, vi } from 'vitest';
import { withProviderRetry, isTransientError, NonRetryableError } from '../../src/providers/retry.js';
import { CommandCodeCatalog } from '../../src/providers/commandcode.js';
import { FireworksCatalog } from '../../src/providers/fireworks.js';
import { ProviderRegistry, normalizeCatalogModelId } from '../../src/providers/provider-registry.js';
import { FileCredentialStore } from '../../src/providers/credential-store.js';
import { ComposioToolHandler } from '../../src/tools/composio.js';
import { PokeDatabase } from '../../src/db/database.js';

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
  it('exposes only the explicit Poke-owned manual catalog containing GLM 5.3 Flash', () => {
    const models = CommandCodeCatalog.getModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: 'z-ai/glm-5.3-flash',
      name: 'GLM-5.3 Flash',
      description: 'Fast, affordable GLM coding with 1M context',
      capabilities: {
        reasoningEfforts: ['low', 'high', 'max'],
        acceptsImages: true,
        contextWindow: 1050000,
      },
    });
  });

  it('validates Command Code API key against provider endpoint and returns manual catalog', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    const originalFetch = global.fetch;
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = String((init?.headers as Record<string, string>)?.Authorization || '');
      return new Response(JSON.stringify({ data: [{ id: 'arbitrary-remote-model' }] }), { status: 200 });
    }) as typeof fetch;

    try {
      const models = await CommandCodeCatalog.validateApiKey('test-command-code-key');
      expect(capturedUrl).toBe('https://api.commandcode.ai/provider/v1/models');
      expect(capturedAuth).toBe('Bearer test-command-code-key');
      // Returns manual catalog models, NOT arbitrary live models from API response
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('z-ai/glm-5.3-flash');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws when Command Code API key validation receives non-ok HTTP status', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })) as typeof fetch;

    try {
      await expect(CommandCodeCatalog.validateApiKey('invalid-key')).rejects.toThrow('Command Code returned 401.');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('FireworksCatalog', () => {
  it('extracts authoritative capabilities for live compatible Fireworks models', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'accounts/fireworks/models/deepseek-r1',
              displayName: 'DeepSeek R1',
              description: 'Frontier reasoning model',
              context_length: 160000,
              supports_image_input: false,
              supports_tools: true,
              reasoning_efforts: ['low', 'medium', 'high', 'max'],
            },
            {
              id: 'accounts/fireworks/models/qwen2p5-vl-72b-instruct',
              name: 'accounts/fireworks/models/qwen2p5-vl-72b-instruct',
              display_name: 'Qwen 2.5 VL 72B Instruct',
              contextLength: 131072,
              supportsImageInput: true,
              supportsTools: true,
            },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const models = await FireworksCatalog.fetchLiveModels('fireworks-key');
      expect(models).toHaveLength(2);

      const r1 = models.find((m) => m.id === 'accounts/fireworks/models/deepseek-r1')!;
      expect(r1).toBeDefined();
      expect(r1.name).toBe('DeepSeek R1');
      expect(r1.description).toBe('Frontier reasoning model');
      expect(r1.capabilities.contextWindow).toBe(160000);
      expect(r1.capabilities.acceptsImages).toBe(false);
      expect(r1.capabilities.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max']);

      const qwenVl = models.find((m) => m.id === 'accounts/fireworks/models/qwen2p5-vl-72b-instruct')!;
      expect(qwenVl).toBeDefined();
      expect(qwenVl.name).toBe('Qwen 2.5 VL 72B Instruct');
      expect(qwenVl.capabilities.contextWindow).toBe(131072);
      expect(qwenVl.capabilities.acceptsImages).toBe(true);
      expect(qwenVl.capabilities.reasoningEfforts).toEqual([]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('applies conservative defaults when capability metadata is absent', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'accounts/fireworks/models/unannotated-chat-model',
            },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const models = await FireworksCatalog.fetchLiveModels('fireworks-key');
      expect(models).toHaveLength(1);
      expect(models[0].capabilities.contextWindow).toBe(128000);
      expect(models[0].capabilities.acceptsImages).toBe(false);
      expect(models[0].capabilities.reasoningEfforts).toEqual([]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('excludes incompatible model types (embeddings, rerankers, image/audio generation, guardrails, non-serverless)', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            // Compatible
            { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', displayName: 'Llama 3.3 70B' },
            { id: 'accounts/fireworks/models/new-compatible-text-model', context_length: 64000 },

            // Incompatible - Embeddings
            { id: 'accounts/fireworks/models/qwen3-embedding-8b', kind: 'EMBEDDING' },
            { id: 'accounts/fireworks/models/bge-large-en-v1.5' },
            { id: 'accounts/fireworks/models/text-embedding-004', type: 'embedding' },

            // Incompatible - Rerankers
            { id: 'accounts/fireworks/models/qwen3-reranker-8b', type: 'reranking' },
            { id: 'accounts/fireworks/models/bge-reranker-v2-m3' },

            // Incompatible - Image / Video Generation
            { id: 'accounts/fireworks/models/flux-1-dev', kind: 'IMAGE_GENERATION' },
            { id: 'accounts/fireworks/models/stable-diffusion-xl-1024-v1-0' },
            { id: 'accounts/fireworks/models/kandinsky-2-2', type: 'image_generation' },
            { id: 'accounts/fireworks/models/cogvideox-5b', type: 'video_generation' },

            // Incompatible - Audio / Speech / Whisper
            { id: 'accounts/fireworks/models/whisper-large-v3', type: 'audio' },
            { id: 'accounts/fireworks/models/bark', type: 'tts' },

            // Incompatible - Guardrails / Moderation
            { id: 'accounts/fireworks/models/llama-guard-3-8b' },
            { id: 'accounts/fireworks/models/moderation-model', type: 'moderation' },

            // Incompatible - Explicit non-serverless or inactive
            { id: 'accounts/fireworks/models/custom-dedicated-model', serverless: false },
            { id: 'accounts/fireworks/models/disabled-model', state: 'DISABLED' },
            { id: 'accounts/fireworks/models/no-tools-model', supports_tools: false },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;

    try {
      const models = await FireworksCatalog.fetchLiveModels('fireworks-key');
      const ids = models.map((m) => m.id);
      expect(ids).toEqual([
        'accounts/fireworks/models/llama-v3p3-70b-instruct',
        'accounts/fireworks/models/new-compatible-text-model',
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('resolveFlueModelSpecifier & Runtime Resolution', () => {
  it('correctly maps provider and model selections to provider/model format', async () => {
    const { resolveFlueModelSpecifier } = await import('../../src/providers/provider-registry.js');

    expect(resolveFlueModelSpecifier({ provider: 'codex', model: 'gpt-4o' })).toBe('openai-codex/gpt-4o');
    expect(resolveFlueModelSpecifier({ provider: 'commandcode', model: 'z-ai/glm-5.3-flash' })).toBe(
      'commandcode/z-ai/glm-5.3-flash'
    );
    expect(
      resolveFlueModelSpecifier({ provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-r1' })
    ).toBe('fireworks/accounts/fireworks/models/deepseek-r1');
    expect(resolveFlueModelSpecifier({ provider: 'codex', model: 'openai-codex/o3-mini' })).toBe(
      'openai-codex/o3-mini'
    );
  });

  it('matches provider-qualified configuration IDs with bare catalog IDs', async () => {
    expect(normalizeCatalogModelId('openai-codex/gpt-4o', 'codex')).toBe('gpt-4o');
    expect(normalizeCatalogModelId('commandcode/z-ai/glm-5.3-flash', 'commandcode')).toBe('z-ai/glm-5.3-flash');
    expect(normalizeCatalogModelId('fireworks/accounts/fireworks/models/deepseek-r1', 'fireworks')).toBe(
      'accounts/fireworks/models/deepseek-r1'
    );

    const directory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/poke-provider-test-'));
    const registry = new ProviderRegistry(new FileCredentialStore(`${directory}/credentials.json`));
    const fetchModels = vi.spyOn(registry, 'fetchModels').mockResolvedValue([
      {
        id: 'gpt-4o',
        name: 'gpt-4o',
        capabilities: { reasoningEfforts: [] },
      },
    ]);
    try {
      await expect(
        registry.validateSelection({ provider: 'codex', model: 'openai-codex/gpt-4o' })
      ).resolves.toMatchObject({ valid: true, modelInfo: { id: 'gpt-4o' } });
    } finally {
      fetchModels.mockRestore();
      await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
    }
  });

  it('uses only manual catalog for Command Code without dynamic scraping', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/poke-provider-test-'));
    const credentials = new FileCredentialStore(`${directory}/credentials.json`);
    await credentials.modify('commandcode', async () => ({ type: 'api_key', key: 'stored-command-code-key' }));
    const registry = new ProviderRegistry(credentials);

    try {
      const models = await registry.fetchModels('commandcode');
      expect(models).toEqual(CommandCodeCatalog.getModels());
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('z-ai/glm-5.3-flash');
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
    }
  });

  it('exposes newly available live Fireworks models and makes them resolvable by Flue at runtime', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/poke-provider-test-'));
    const credentials = new FileCredentialStore(`${directory}/credentials.json`);
    await credentials.modify('fireworks', async () => ({ type: 'api_key', key: 'stored-fireworks-key' }));
    const registry = new ProviderRegistry(credentials);

    const newLiveModel = {
      id: 'accounts/fireworks/models/brand-new-future-model-70b',
      name: 'Brand New Future Model 70B',
      capabilities: { reasoningEfforts: ['low', 'high'] as any, acceptsImages: true, contextWindow: 200000 },
    };

    const fetchLiveModels = vi.spyOn(FireworksCatalog, 'fetchLiveModels').mockResolvedValue([newLiveModel]);

    try {
      // 1. poke model / fetchModels returns newly available model without static filtering
      const fetched = await registry.fetchModels('fireworks');
      expect(fetched).toEqual([newLiveModel]);

      // 2. Selection validation succeeds
      const validation = await registry.validateSelection({
        provider: 'fireworks',
        model: newLiveModel.id,
        reasoningEffort: 'high',
      });
      expect(validation.valid).toBe(true);
      expect(validation.modelInfo).toEqual(newLiveModel);

      // 3. Register with Flue runtime and verify resolution
      const { registerAllProviders } = await import('../../src/providers/provider-registry.js');
      const { createFireworksCredentialProvider } = await import('../../src/providers/models.js');

      registerAllProviders(registry.models, [], [validation.modelInfo!]);

      const fireworksProvider = createFireworksCredentialProvider([validation.modelInfo!]);
      const registeredFlueModel = fireworksProvider.getModels().find((m) => m.id === newLiveModel.id);
      expect(registeredFlueModel).toBeDefined();
      expect(registeredFlueModel).toMatchObject({
        id: newLiveModel.id,
        api: 'openai-completions',
        provider: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 16384,
      });
    } finally {
      fetchLiveModels.mockRestore();
      await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
    }
  });

  it('rejects an absent model selection instead of silently picking a fallback', async () => {
    const { resolveFlueModelSpecifier } = await import('../../src/providers/provider-registry.js');
    expect(() => resolveFlueModelSpecifier()).toThrow(/No model is configured/);
  });

  it('attaches Flue dynamicModelTemplate to Fireworks and Command Code providers', async () => {
    const {
      createCommandCodeCredentialProvider,
      createFireworksCredentialProvider,
      withPokeCredentialResolver,
      createPokeModels,
    } = await import('../../src/providers/models.js');
    const dynamicKey = Symbol.for('flue.dynamicModelTemplate');

    const cmdProvider = createCommandCodeCredentialProvider();
    expect((cmdProvider as any)[dynamicKey]).toEqual({
      api: 'openai-completions',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
    });

    const fwProvider = createFireworksCredentialProvider();
    expect((fwProvider as any)[dynamicKey]).toEqual({
      api: 'openai-completions',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
    });

    const credentials = new FileCredentialStore('/tmp/test-creds.json');
    const models = createPokeModels(credentials);
    const resolvedFw = withPokeCredentialResolver(fwProvider, models);
    expect((resolvedFw as any)[dynamicKey]).toEqual({
      api: 'openai-completions',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
    });
  });

  it('registers selected live Command Code metadata as a concrete Flue model', async () => {
    const { createCommandCodeRuntimeModel, createCommandCodeCredentialProvider } = await import(
      '../../src/providers/models.js'
    );
    const modelInfo = {
      id: 'z-ai/glm-5.3-flash',
      name: 'GLM-5.3 Flash',
      capabilities: {
        reasoningEfforts: ['low', 'high', 'max'] as any,
        acceptsImages: true,
        contextWindow: 1050000,
      },
    };
    const runtimeModel = createCommandCodeRuntimeModel(modelInfo);
    expect(runtimeModel).toMatchObject({
      id: 'z-ai/glm-5.3-flash',
      api: 'openai-completions',
      provider: 'commandcode',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1050000,
      maxTokens: 16384,
    });
    expect((runtimeModel as any).thinkingLevelMap.low).toBe('low');
    expect((runtimeModel as any).thinkingLevelMap.high).toBe('high');
    expect((runtimeModel as any).thinkingLevelMap.max).toBe('max');

    const provider = createCommandCodeCredentialProvider([modelInfo]);
    expect(provider.getModels()[0]).toMatchObject({
      id: 'z-ai/glm-5.3-flash',
    });
  });
});

describe('ComposioToolHandler', () => {
  it('caches the locally filtered catalog and does not retry externally mutating actions', async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([
        {
          slug: 'GMAIL_SEND_EMAIL',
          name: 'GMAIL_SEND_EMAIL',
          description: 'Send an email through Gmail.',
          inputParameters: { type: 'object' },
        },
      ]),
      listConnectedAccounts: vi.fn().mockResolvedValue([]),
      execute: vi.fn().mockRejectedValue(new Error('connection reset after action')),
    };
    const handler = new ComposioToolHandler('test-key', () => client);

    await expect(handler.search({ query: 'email' })).resolves.toMatchObject({
      actions: [{ name: 'GMAIL_SEND_EMAIL' }],
    });
    await expect(handler.search({ query: 'email' })).resolves.toMatchObject({
      actions: [{ name: 'GMAIL_SEND_EMAIL' }],
    });
    expect(client.listTools).toHaveBeenCalledTimes(1);

    await expect(handler.execute({ action: 'GMAIL_SEND_EMAIL' })).rejects.toThrow(
      'connection reset after action'
    );
    expect(client.execute).toHaveBeenCalledWith(
      'GMAIL_SEND_EMAIL',
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(client.execute).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached catalog across setApiKey generations and ignores stale resolutions', async () => {
    let resolveFirst!: (value: any) => void;
    const firstPromise = new Promise<any[]>((res) => {
      resolveFirst = res;
    });

    const firstClient = {
      listTools: vi.fn().mockReturnValue(firstPromise),
      listConnectedAccounts: vi.fn().mockResolvedValue([]),
      execute: vi.fn(),
    };
    const secondClient = {
      listTools: vi.fn().mockResolvedValue([
        { slug: 'SECOND_TOOL', name: 'SECOND_TOOL', description: 'Second tool description' },
      ]),
      listConnectedAccounts: vi.fn().mockResolvedValue([]),
      execute: vi.fn(),
    };
    const clients = [firstClient, secondClient];
    const handler = new ComposioToolHandler('initial-key', () => clients.shift()!);

    // Start in-flight catalog fetch for first generation
    const search1 = handler.search({ query: 'first' });

    // Rotate API key while first fetch is pending
    handler.setApiKey('second-key');

    // Resolve the first (stale) catalog fetch
    resolveFirst([{ slug: 'FIRST_TOOL', name: 'FIRST_TOOL', description: 'First tool description' }]);
    await expect(search1).resolves.toMatchObject({
      actions: [{ name: 'FIRST_TOOL' }],
    });

    // A search on the new key should fetch with the new toolset
    await expect(handler.search({ query: 'second' })).resolves.toMatchObject({
      actions: [{ name: 'SECOND_TOOL' }],
    });
    expect(secondClient.listTools).toHaveBeenCalledTimes(1);
  });

  it('filters file transfer actions and executes against the selected active account exactly once', async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([
        {
          slug: 'GMAIL_SEND_EMAIL',
          name: 'GMAIL_SEND_EMAIL',
          inputParameters: { type: 'object' },
        },
        {
          slug: 'GOOGLEDRIVE_UPLOAD_FILE',
          name: 'GOOGLEDRIVE_UPLOAD_FILE',
          inputParameters: {
            properties: { upload: { file_uploadable: true } },
          },
        },
      ]),
      listConnectedAccounts: vi.fn().mockResolvedValue([
        { id: 'acct-active', toolkit: 'gmail', status: 'ACTIVE' },
      ]),
      execute: vi.fn().mockResolvedValue({ sent: true }),
    };
    const db = new PokeDatabase(undefined, true);
    const handler = new ComposioToolHandler('test-key', () => client, db);

    try {
      await expect(handler.search({ query: 'email' })).resolves.toMatchObject({
        actions: [{ name: 'GMAIL_SEND_EMAIL' }],
        connected_accounts: [{ id: 'acct-active' }],
      });

      await expect(
        handler.execute({
          action: 'GMAIL_SEND_EMAIL',
          params: { to: 'owner@example.com' },
          connected_account_id: 'acct-active',
          idempotencyKey: 'composio-tool-call-1',
        })
      ).resolves.toEqual({ result: { sent: true } });
      await handler.execute({
        action: 'GMAIL_SEND_EMAIL',
        params: { to: 'owner@example.com' },
        connected_account_id: 'acct-active',
        idempotencyKey: 'composio-tool-call-1',
      });

      expect(client.execute).toHaveBeenCalledTimes(1);
      expect(client.execute).toHaveBeenCalledWith(
        'GMAIL_SEND_EMAIL',
        { to: 'owner@example.com' },
        expect.objectContaining({
          connectedAccountId: 'acct-active',
          signal: expect.any(AbortSignal),
        })
      );
    } finally {
      db.close();
    }
  });
});
