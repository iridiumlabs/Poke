import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCredentialStore } from '../../src/providers/credential-store.js';
import { migrateLegacyProviderCredentials } from '../../src/providers/credentials-migration.js';
import { ConfigManager } from '../../src/config/config.js';

describe('FileCredentialStore', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes provider credentials atomically with owner-only permissions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-credentials-'));
    directories.push(directory);
    const file = path.join(directory, 'credentials.json');
    const store = new FileCredentialStore(file);

    await store.modify('fireworks', async () => ({ type: 'api_key', key: 'fw-test-secret' }));

    expect(await store.read('fireworks')).toEqual({ type: 'api_key', key: 'fw-test-secret' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.list()).toEqual([{ providerId: 'fireworks', type: 'api_key' }]);
  });

  it('serializes concurrent provider modifications without losing a rotated credential', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-credentials-'));
    directories.push(directory);
    const store = new FileCredentialStore(path.join(directory, 'credentials.json'));

    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 1,
    }));

    await Promise.all([
      store.modify('openai-codex', async (current) => ({
        ...(current as any),
        access: 'access-2',
      })),
      store.modify('openai-codex', async (current) => ({
        ...(current as any),
        refresh: 'refresh-2',
      })),
    ]);

    expect(await store.read('openai-codex')).toEqual({
      type: 'oauth',
      access: 'access-2',
      refresh: 'refresh-2',
      expires: 1,
    });
  });

  it('migrates API keys and discards the non-refreshable legacy Codex token', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-credentials-'));
    directories.push(directory);
    const config = new ConfigManager(directory);
    config.updateCredentials({
      fireworksApiKey: 'fw-old-key',
      commandCodeApiKey: 'cc-old-key',
      codexAuth: { accessToken: 'fabricated-access-token', expiresAt: Date.now() },
    });
    const store = new FileCredentialStore(path.join(directory, 'credentials.json'));

    const result = await migrateLegacyProviderCredentials(config, store);

    expect(result).toEqual({ migrated: ['fireworks', 'commandcode'], codexReloginRequired: true });
    expect(await store.read('fireworks')).toEqual({ type: 'api_key', key: 'fw-old-key' });
    expect(await store.read('commandcode')).toEqual({ type: 'api_key', key: 'cc-old-key' });
    const creds = config.getCredentials();
    expect(creds.fireworksApiKey).toBeUndefined();
    expect(creds.commandCodeApiKey).toBeUndefined();
    expect(creds.codexAuth).toBeUndefined();
  });
});
