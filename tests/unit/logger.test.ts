import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import {
  BoundedLogStream,
  getLogger,
  resetLoggerForTesting,
  redactSecrets,
} from '../../src/logger/logger.js';

describe('Logger and BoundedLogStream', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-log-test-'));
    resetLoggerForTesting();
  });

  afterEach(() => {
    resetLoggerForTesting();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('bounds log file size and rotates to .1, .2 up to maxFiles', () => {
    const logFile = path.join(tempDir, 'poke.log');
    const maxSize = 250; // small size for testing
    const maxFiles = 3;

    const stream = new BoundedLogStream(logFile, maxSize, maxFiles);
    const logger = pino(stream);

    // Write enough logs to trigger multiple rotations
    for (let i = 0; i < 15; i++) {
      logger.info({ messageIndex: i }, `This is a reasonably long log line to exceed byte limits ${i}`);
    }

    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.existsSync(`${logFile}.2`)).toBe(true);
    // Should not exceed maxFiles
    expect(fs.existsSync(`${logFile}.3`)).toBe(false);

    // Main file size should be within bounds
    const stat = fs.statSync(logFile);
    expect(stat.size).toBeLessThanOrEqual(maxSize + 300);
  });

  it('rotates existing oversized log file upon opening', () => {
    const logFile = path.join(tempDir, 'poke.log');
    fs.writeFileSync(logFile, 'A'.repeat(500));

    const stream = new BoundedLogStream(logFile, 200, 3);
    const logger = pino(stream);
    logger.info('New log line after initial oversize');

    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toContain('AAAAA');
    expect(fs.readFileSync(logFile, 'utf8')).toContain('New log line');
  });

  it('redacts sensitive keys from objects and text', () => {
    const sensitive = {
      apiKey: 'sk-12345678901234567890',
      nested: {
        token: 'secret-token-12345',
        safe: 'public-value',
      },
    };

    const redacted = redactSecrets(sensitive);
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.nested.token).toBe('[REDACTED]');
    expect(redacted.nested.safe).toBe('public-value');
  });

  it('redacts credentials embedded in logged error strings', () => {
    const logger = getLogger(tempDir);
    const secret = 'super-secret-token-value';

    logger.error({ err: `Authorization: Bearer ${secret}` }, 'Provider request failed');

    const content = fs.readFileSync(path.join(tempDir, 'logs', 'poke.log'), 'utf8');
    expect(content).not.toContain(secret);
    expect(content).toContain('Bearer [REDACTED]');
  });
});
