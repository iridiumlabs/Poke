import { describe, expect, it } from 'vitest';
import { createPokeSandboxEnvironment } from '../../src/agent/sandbox-env.js';

describe('createPokeSandboxEnvironment', () => {
  it('preserves the full host environment including provider variables', () => {
    const environment = createPokeSandboxEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/poke',
      GH_TOKEN: 'host-tool-token',
      OPENAI_API_KEY: 'openai-secret',
      DEEPGRAM_API_KEY: 'deepgram-secret',
      COMPOSIO_API_KEY: 'composio-secret',
    });

    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.HOME).toBe('/home/poke');
    expect(environment.GH_TOKEN).toBe('host-tool-token');
    expect(environment.OPENAI_API_KEY).toBe('openai-secret');
    expect(environment.DEEPGRAM_API_KEY).toBe('deepgram-secret');
    expect(environment.COMPOSIO_API_KEY).toBe('composio-secret');
  });
});
