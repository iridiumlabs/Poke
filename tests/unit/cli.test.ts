import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { runDoctor } from '../../src/cli/doctor.js';
import { redactSecrets } from '../../src/logger/logger.js';
import { ConfigManager } from '../../src/config/config.js';
import { PokeDatabase } from '../../src/db/database.js';
import { readLogTail } from '../../src/cli/logs.js';
import { promptSecret } from '../../src/cli/prompt.js';
import { createCli } from '../../src/cli/index.js';

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

  it('poke doctor passes when all requirements are satisfied', async () => {
    config.setOwnerPhoneNumber('+92 300 1234567');
    config.updateCredentials({
      exaApiKey: 'exa-key-123',
      deepgramApiKey: 'dg-key-123',
      commandCodeApiKey: 'cmd-key-123',
    });
    config.setMainModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });

    const { checks } = await runDoctor(tempDir);
    const ownerCheck = checks.find((c) => c.name === 'Owner Phone Number');
    expect(ownerCheck?.passed).toBe(true);

    const exaCheck = checks.find((c) => c.name === 'Exa API Key');
    expect(exaCheck?.passed).toBe(true);
  });

  it('reads only the requested tail of a large log file', () => {
    const logFile = path.join(tempDir, 'poke.log');
    const lines = Array.from({ length: 2_000 }, (_, index) => `line-${index}`);
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`);

    expect(readLogTail(logFile, 3)).toEqual(['line-1997', 'line-1998', 'line-1999']);
  });

  it('masks credential input in a terminal readline prompt', async () => {
    const input = new PassThrough();
    let output = '';
    const outputStream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const rl = readline.createInterface({ input, output: outputStream, terminal: true });

    const answer = promptSecret(rl, 'API key: ', true);
    input.write('secret-value\n');

    await expect(answer).resolves.toBe('secret-value');
    expect(output).not.toContain('secret-value');
    expect(output).toContain('************');
    rl.close();
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

  it('ConfigManager loadConfig throws when config.json is malformed instead of overwriting with defaults', () => {
    const configFile = path.join(tempDir, 'config.json');
    fs.writeFileSync(configFile, '{"ownerPhoneNumber": "923001234567", invalid-json}');

    const cm = new ConfigManager(tempDir);
    expect(() => cm.loadConfig()).toThrow(/Failed to parse configuration file/);

    // Ensure malformed file was not overwritten
    expect(fs.readFileSync(configFile, 'utf8')).toContain('invalid-json');
  });
});

