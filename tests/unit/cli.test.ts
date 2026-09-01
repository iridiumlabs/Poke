import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDoctor } from '../../src/cli/doctor.js';
import { redactSecrets } from '../../src/logger/logger.js';
import { ConfigManager } from '../../src/config/config.js';
import { PokeDatabase } from '../../src/db/database.js';
import { readLogTail } from '../../src/cli/logs.js';
import { createCli } from '../../src/cli/index.js';
import { colorizeCliText, isPromptCancellation } from '../../src/cli/ui.js';
import type { CliUi, SelectChoice, TextPromptOptions } from '../../src/cli/ui.js';
import { runSetup } from '../../src/cli/setup.js';
import { runLogin } from '../../src/cli/login.js';
import { runModelSelection } from '../../src/cli/model.js';
import { runWhatsAppMenu } from '../../src/cli/whatsapp.js';
import { runInteractiveWhatsAppPairing } from '../../src/cli/pairing.js';
import { FileCredentialStore } from '../../src/providers/credential-store.js';
import { readGatewayRuntimeStatus, writeGatewayRuntimeStatus } from '../../src/gateway/runtime-status.js';

class ScriptedUi implements CliUi {
  readonly notes: string[] = [];
  readonly errors: string[] = [];
  readonly selectMessages: string[] = [];

  constructor(
    private readonly selections: string[] = [],
    private readonly texts: string[] = [],
    private readonly secrets: string[] = [],
    private readonly confirmations: boolean[] = []
  ) {}

  async select<T extends string>(message: string, _choices: readonly SelectChoice<T>[]): Promise<T> {
    this.selectMessages.push(message);
    return this.selections.shift() as T;
  }

  async text(_options: TextPromptOptions): Promise<string> {
    return this.texts.shift() || '';
  }

  async secret(_options: TextPromptOptions): Promise<string> {
    return this.secrets.shift() || '';
  }

  async confirm(_message: string, defaultValue = false): Promise<boolean> {
    return this.confirmations.shift() ?? defaultValue;
  }

  async spinner<T>(_message: string, action: () => Promise<T>): Promise<T> {
    return await action();
  }

  note(message: string): void {
    this.notes.push(message);
  }

  success(message: string): void {
    this.notes.push(message);
  }

  warning(message: string): void {
    this.notes.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

describe('CLI & Diagnostics', () => {
  let tempDir: string;
  let config: ConfigManager;
  let db: PokeDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-cli-test-'));
    config = new ConfigManager(tempDir);
    db = new PokeDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('redacts sensitive API keys and tokens completely from logs and objects', () => {
    const rawObject = {
      apiKey: 'sk-1234567890abcdef12345678',
      user: 'arham',
      credentials: {
        deepgramApiKey: 'dg-abcdef1234567890abcdef12',
        commandCodeApiKey: 'cm_abcdef1234567890',
      },
      message: 'Authorization: Bearer mySecretToken123456789',
    };

    const redacted = redactSecrets(rawObject);
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.credentials.deepgramApiKey).toBe('[REDACTED]');
    expect(redacted.credentials.commandCodeApiKey).toBe('[REDACTED]');
    expect(redacted.message).toContain('Bearer [REDACTED]');
  });

  it('poke doctor returns failure when mandatory fields are missing', async () => {
    // Unconfigured directory should fail doctor check
    const { success, checks } = await runDoctor(tempDir);
    expect(success).toBe(false);

    const ownerCheck = checks.find((c) => c.name === 'Owner Phone Number');
    expect(ownerCheck?.passed).toBe(false);
  });

  it('keeps the state directory byte-for-byte unchanged while running diagnostics', async () => {
    const snapshot = () =>
      fs
        .readdirSync(tempDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [path.relative(tempDir, file), fs.readFileSync(file).toString('base64')] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right));
    const before = snapshot();

    await runDoctor(tempDir, {
      catalog: {
        fetchModels: vi.fn().mockResolvedValue([]),
        validateSelection: vi.fn().mockResolvedValue({ valid: false, error: 'not configured' }),
      },
    });

    expect(snapshot()).toEqual(before);
  });

  it('poke doctor passes when all requirements are satisfied', async () => {
    config.setOwnerPhoneNumber('+92 300 1234567');
    config.updateCredentials({
      composioApiKey: 'composio-key-123',
      supermemoryApiKey: 'supermemory-key-123',
      exaApiKey: 'exa-key-123',
      deepgramApiKey: 'dg-key-123',
    });
    config.setMainModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });
    config.setWorkerModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });
    await new FileCredentialStore(config.getPaths().credentialsFile).modify('commandcode', async () => ({
      type: 'api_key',
      key: 'cmd-key-123',
    }));

    const validateService = vi.fn().mockResolvedValue(undefined);
    const { success, checks } = await runDoctor(tempDir, {
      catalog: {
        fetchModels: vi.fn().mockResolvedValue([]),
        validateSelection: vi.fn().mockResolvedValue({ valid: true }),
      },
      validateService,
    });
    const ownerCheck = checks.find((c) => c.name === 'Owner Phone Number');
    expect(ownerCheck?.passed).toBe(true);

    const exaCheck = checks.find((c) => c.name === 'Exa API Key');
    expect(exaCheck?.passed).toBe(true);
    expect(validateService).toHaveBeenCalledTimes(4);
    expect(success).toBe(true);
  });

  it('reads only the requested tail of a large log file', () => {
    const logFile = path.join(tempDir, 'poke.log');
    const lines = Array.from({ length: 2_000 }, (_, index) => `line-${index}`);
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`);

    expect(readLogTail(logFile, 3)).toEqual(['line-1997', 'line-1998', 'line-1999']);
  });

  it('keeps CLI text readable without ANSI and recognizes prompt cancellation', () => {
    expect(colorizeCliText('Poke', false)).toBe('Poke');
    expect(colorizeCliText('Poke', true)).toContain('\u001b[34mPoke\u001b[0m');
    expect(isPromptCancellation({ name: 'ExitPromptError' })).toBe(true);
    expect(isPromptCancellation({ name: 'ValidationError' })).toBe(false);
  });

  it('rejects an invalid model target before selecting a configuration', async () => {
    const program = createCli();

    await expect(
      program.parseAsync(['node', 'poke', 'model', 'wroker'], { from: 'node' })
    ).rejects.toThrow('Model target must be "main" or "worker".');
  });

  it('poke status parses structured PID record from claimDaemonPidFile', async () => {
    const { runStatus } = await import('../../src/cli/status.js');
    const { readDaemonPidFile } = await import('../../src/daemon/pid-file.js');
    const pidFile = path.join(tempDir, 'daemon.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 12345, startTime: 'fake-start-time' }));

    const record = readDaemonPidFile(pidFile);
    expect(record).toEqual({ pid: 12345, startTime: 'fake-start-time' });

    const consoleLogs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      consoleLogs.push(args.join(' '));
    });

    try {
      await runStatus(tempDir);
      const statusOutput = consoleLogs.join('\n');
      expect(statusOutput).toContain('POKE STATUS');
      expect(statusOutput).not.toContain('PID: NaN');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('poke status ignores out-of-range and non-finite timestamps without throwing', async () => {
    const { runStatus } = await import('../../src/cli/status.js');
    db.setState('last_activity_time', '1e25');
    db.getRawDb().prepare("INSERT INTO automations (id, name, instruction, schedule_type, schedule_value, enabled, next_run_at, created_at, updated_at) VALUES ('a1', 'test-auto', 'inst', 'interval', '10m', 1, 1e25, 1000, 1000)").run();
    db.getRawDb().prepare("INSERT INTO operational_errors (id, source, message, created_at) VALUES ('e1', 'test-src', 'some error', 1e25)").run();

    const consoleLogs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      consoleLogs.push(args.join(' '));
    });

    try {
      await runStatus(tempDir);
      const statusOutput = consoleLogs.join('\n');
      expect(statusOutput).toContain('POKE STATUS');
      expect(statusOutput).not.toContain('Last Activity:');
      expect(statusOutput).toContain('None scheduled');
      expect(statusOutput).not.toContain('Last Operational Error');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('ConfigManager loadConfig throws when config.json is malformed instead of overwriting with defaults', () => {
    const configFile = path.join(tempDir, 'config.json');
    fs.writeFileSync(configFile, '{"ownerPhoneNumber": "923001234567", invalid-json}');

    const cm = new ConfigManager(tempDir);
    expect(() => cm.loadConfig()).toThrow(/Failed to parse configuration file/);

    // Ensure malformed file was not overwritten
    expect(fs.readFileSync(configFile, 'utf8')).toContain('invalid-json');
  });

  it('merges daemon and CLI config patches from fresh disk state', () => {
    const daemonConfig = new ConfigManager(tempDir);
    const cliConfig = new ConfigManager(tempDir);
    daemonConfig.loadConfig(); // Simulates the daemon holding an old in-memory view.

    cliConfig.setMainModel({ provider: 'commandcode', model: 'new-main-model' });
    daemonConfig.addActiveCapability('automations');

    const persisted = new ConfigManager(tempDir);
    expect(persisted.getMainModel()).toEqual({
      provider: 'commandcode',
      model: 'new-main-model',
    });
    expect(persisted.getActiveCapabilities()).toEqual(['automations']);
  });

  it('runs setup WhatsApp-first, rejects the paired account as owner, and persists completed service steps', async () => {
    const ui = new ScriptedUi(
      ['qr'],
      ['+923001111111', '+923001222222'],
      ['composio-key', 'supermemory-key', 'exa-key', 'deepgram-key']
    );
    const pairingService = {
      pair: vi.fn().mockResolvedValue({ pairedAccount: '923001111111' }),
    };
    const daemon = {
      isRunning: vi.fn().mockResolvedValue(false),
      stop: vi.fn(),
      start: vi.fn(),
    };

    await runSetup(tempDir, ui, {
      pairing: { service: pairingService as any, daemon },
      validateService: vi.fn().mockResolvedValue(undefined),
    });

    expect(ui.selectMessages[0]).toBe('Choose a WhatsApp pairing method');
    expect(ui.errors).toContain('The owner number must be different from Poke’s paired WhatsApp account.');
    expect(config.getOwnerPhoneNumber()).toBe('923001222222');
    expect(config.getWhatsAppAccount()).toBe('923001111111');
    expect(config.getCredentials()).toMatchObject({
      composioApiKey: 'composio-key',
      supermemoryApiKey: 'supermemory-key',
      exaApiKey: 'exa-key',
      deepgramApiKey: 'deepgram-key',
    });
  });

  it('keeps an existing provider credential when replacement validation fails', async () => {
    const credentials = new FileCredentialStore(config.getPaths().credentialsFile);
    await credentials.modify('commandcode', async () => ({ type: 'api_key', key: 'old-key' }));
    const ui = new ScriptedUi(['commandcode'], [], ['bad-key']);

    await expect(
      runLogin(tempDir, ui, {
        credentials,
        validateCommandCode: vi.fn().mockRejectedValue(new Error('invalid key')),
      })
    ).rejects.toThrow('Login failed: invalid key');

    expect(await credentials.read('commandcode')).toEqual({ type: 'api_key', key: 'old-key' });
    expect(ui.errors.join('\n')).toContain('invalid key');
  });

  it('uses pi-ai’s Codex device-code flow instead of accepting a pasted access token', async () => {
    const ui = new ScriptedUi(['codex']);
    const login = vi.fn().mockImplementation(async (_provider, _type, interaction) => {
      expect(await interaction.prompt({ type: 'select', message: 'Select OpenAI Codex login method:', options: [] })).toBe('device_code');
      interaction.notify({
        type: 'device_code',
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      });
      return { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 1_000 };
    });

    await runLogin(tempDir, ui, { models: { login } as any });

    expect(login).toHaveBeenCalledWith('openai-codex', 'oauth', expect.anything());
    expect(ui.notes.join('\n')).toContain('ABCD-EFGH');
  });

  it('saves an independent worker model after validating the exact selected capability', async () => {
    config.setMainModel({ provider: 'commandcode', model: 'main-model' });
    const ui = new ScriptedUi(['commandcode', 'worker-model', 'high']);
    const catalog = {
      fetchModels: vi.fn().mockResolvedValue([
        {
          id: 'worker-model',
          name: 'Worker model',
          capabilities: { reasoningEfforts: ['low', 'high'] },
        },
      ]),
      validateSelection: vi.fn().mockResolvedValue({ valid: true }),
    };

    await runModelSelection('worker', tempDir, ui, catalog);

    const persisted = new ConfigManager(tempDir);
    expect(persisted.getMainModel()).toMatchObject({ model: 'main-model' });
    expect(persisted.getWorkerModel()).toEqual({
      provider: 'commandcode',
      model: 'worker-model',
      reasoningEffort: 'high',
    });
    expect(catalog.validateSelection).toHaveBeenCalledWith({
      provider: 'commandcode',
      model: 'worker-model',
      reasoningEffort: 'high',
    });
  });

  it('clears stale WhatsApp runtime account metadata with a cleared session', async () => {
    config.setWhatsAppAccount('923001111111');
    const paths = config.getPaths();
    fs.writeFileSync(path.join(paths.whatsappDir, 'creds.json'), 'session');
    writeGatewayRuntimeStatus(paths.runtimeStatusFile, {
      state: 'connected',
      updatedAt: Date.now(),
      pairedAccount: '923001111111',
      lastConnectedAt: Date.now(),
    });

    const ui = new ScriptedUi(['clear'], [], [], [true]);
    const daemon = {
      isRunning: vi.fn().mockResolvedValue(false),
      stop: vi.fn(),
      start: vi.fn(),
    };

    await runWhatsAppMenu(tempDir, ui, { daemon });

    expect(new ConfigManager(tempDir).getWhatsAppAccount()).toBeUndefined();
    expect(fs.existsSync(path.join(paths.whatsappDir, 'creds.json'))).toBe(false);
    expect(readGatewayRuntimeStatus(paths.runtimeStatusFile)).toMatchObject({
      state: 'disconnected',
      reason: 'WhatsApp session cleared.',
    });
    expect(readGatewayRuntimeStatus(paths.runtimeStatusFile)?.pairedAccount).toBeUndefined();
  });

  it('records the newly paired account as disconnected until the daemon reconnects', async () => {
    const paths = config.getPaths();
    writeGatewayRuntimeStatus(paths.runtimeStatusFile, {
      state: 'connected',
      updatedAt: Date.now(),
      pairedAccount: '923001111111',
    });
    const ui = new ScriptedUi(['qr']);
    const daemon = {
      isRunning: vi.fn().mockResolvedValue(false),
      stop: vi.fn(),
      start: vi.fn(),
    };

    await runInteractiveWhatsAppPairing(config, tempDir, ui, {
      service: { pair: vi.fn().mockResolvedValue({ pairedAccount: '923001222222' }) } as any,
      daemon,
    });

    expect(new ConfigManager(tempDir).getWhatsAppAccount()).toBe('923001222222');
    expect(readGatewayRuntimeStatus(paths.runtimeStatusFile)).toMatchObject({
      state: 'disconnected',
      pairedAccount: '923001222222',
      reason: 'WhatsApp session paired.',
    });
  });
});
