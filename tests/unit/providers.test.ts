import { describe, it, expect } from 'vitest';
import { withProviderRetry, isTransientError, NonRetryableError } from '../../src/providers/retry.js';
import { CommandCodeCatalog } from '../../src/providers/commandcode.js';

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
});

describe('resolveFlueModelSpecifier', () => {
  it('correctly maps provider and model selections to provider/model format', async () => {
    const { resolveFlueModelSpecifier } = await import('../../src/providers/provider-registry.js');

    expect(resolveFlueModelSpecifier({ provider: 'codex', model: 'gpt-4o' })).toBe('openai-codex/gpt-4o');
    expect(resolveFlueModelSpecifier({ provider: 'commandcode', model: 'claude-sonnet-4-6' })).toBe('commandcode/claude-sonnet-4-6');
    expect(resolveFlueModelSpecifier({ provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-r1' })).toBe('fireworks/accounts/fireworks/models/deepseek-r1');
    expect(resolveFlueModelSpecifier({ provider: 'codex', model: 'openai-codex/o3-mini' })).toBe('openai-codex/o3-mini');
  });
});
