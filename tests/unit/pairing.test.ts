import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WhatsAppPairingService,
  normalizeE164PhoneNumber,
  type PairingSocket,
} from '../../src/gateway/pairing.js';
import { resolvePokePaths } from '../../src/config/paths.js';

class FakeSocket implements PairingSocket {
  readonly ev = new EventEmitter();
  readonly end = vi.fn();
  readonly requestPairingCode = vi.fn().mockResolvedValue('ABCD1234');
  user = { id: '923001111111:7@s.whatsapp.net' };
}

describe('WhatsAppPairingService', () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('waits for an open connection before atomically replacing the saved session', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-pairing-'));
    directories.push(home);
    const paths = resolvePokePaths(home);
    fs.mkdirSync(paths.whatsappDir, { recursive: true });
    fs.writeFileSync(path.join(paths.whatsappDir, 'old-creds.json'), 'old');
    const socket = new FakeSocket();
    const pairingCodes: string[] = [];

    const service = new WhatsAppPairingService(paths, {
      async create(stagingDirectory) {
        fs.writeFileSync(path.join(stagingDirectory, 'creds.json'), 'new');
        setTimeout(() => socket.ev.emit('connection.update', { connection: 'open' }), 0);
        return { socket, saveCreds: vi.fn() };
      },
    });

    const result = await service.pair({
      method: { type: 'phone', phoneNumber: '+923001111111' },
      onPairingCode: (code) => pairingCodes.push(code),
    });

    expect(socket.requestPairingCode).toHaveBeenCalledWith('923001111111');
    expect(pairingCodes).toEqual(['ABCD-1234']);
    expect(result.pairedAccount).toBe('923001111111');
    expect(fs.readFileSync(path.join(paths.whatsappDir, 'creds.json'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(paths.whatsappDir, 'old-creds.json'))).toBe(false);
    expect(socket.end).toHaveBeenCalled();
  });

  it('rolls back a failed pairing and leaves the existing session untouched', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-pairing-'));
    directories.push(home);
    const paths = resolvePokePaths(home);
    fs.mkdirSync(paths.whatsappDir, { recursive: true });
    fs.writeFileSync(path.join(paths.whatsappDir, 'old-creds.json'), 'old');
    const socket = new FakeSocket();

    const service = new WhatsAppPairingService(paths, {
      async create(stagingDirectory) {
        fs.writeFileSync(path.join(stagingDirectory, 'creds.json'), 'new');
        setTimeout(() =>
          socket.ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 401 } } },
          }), 0
        );
        return { socket, saveCreds: vi.fn() };
      },
    });

    await expect(service.pair({ method: { type: 'qr' } })).rejects.toThrow(/logged out/i);
    expect(fs.readFileSync(path.join(paths.whatsappDir, 'old-creds.json'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(paths.whatsappDir, 'creds.json'))).toBe(false);
  });

  it('requires E.164 input for phone pairing', () => {
    expect(normalizeE164PhoneNumber('+92 300 1111111')).toBe('923001111111');
    expect(() => normalizeE164PhoneNumber('923001111111')).toThrow(/E\.164/);
    expect(() => normalizeE164PhoneNumber('+000123')).toThrow(/E\.164/);
  });

  it('validates a phone number before opening a staged pairing socket', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-pairing-'));
    directories.push(home);
    const paths = resolvePokePaths(home);
    const create = vi.fn();
    const service = new WhatsAppPairingService(paths, { create });

    await expect(
      service.pair({ method: { type: 'phone', phoneNumber: '923001111111' } })
    ).rejects.toThrow(/E\.164/);

    expect(create).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('cleans up the connection waiter when requesting a phone pairing code fails', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-pairing-'));
    directories.push(home);
    const paths = resolvePokePaths(home);
    const socket = new FakeSocket();
    socket.requestPairingCode.mockRejectedValueOnce(new Error('pairing code unavailable'));
    const service = new WhatsAppPairingService(paths, {
      async create() {
        return { socket, saveCreds: vi.fn() };
      },
    });

    await expect(
      service.pair({
        method: { type: 'phone', phoneNumber: '+923001111111' },
        timeoutMs: 60_000,
      })
    ).rejects.toThrow('pairing code unavailable');

    expect(socket.ev.listenerCount('connection.update')).toBe(0);
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('reconnects when receiving DisconnectReason.restartRequired (515) and succeeds on second socket', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-pairing-'));
    directories.push(home);
    const paths = resolvePokePaths(home);
    const socket1 = new FakeSocket();
    const socket2 = new FakeSocket();
    let callCount = 0;

    const service = new WhatsAppPairingService(paths, {
      async create(stagingDirectory) {
        callCount++;
        if (callCount === 1) {
          fs.writeFileSync(path.join(stagingDirectory, 'creds.json'), 'new-staged');
          setTimeout(() =>
            socket1.ev.emit('connection.update', {
              connection: 'close',
              lastDisconnect: { error: { output: { statusCode: 515 } } },
            }), 0
          );
          return { socket: socket1, saveCreds: vi.fn() };
        } else {
          setTimeout(() => socket2.ev.emit('connection.update', { connection: 'open' }), 0);
          return { socket: socket2, saveCreds: vi.fn() };
        }
      },
    });

    const result = await service.pair({
      method: { type: 'qr' },
    });

    expect(callCount).toBe(2);
    expect(result.paired).toBe(true);
    expect(result.pairedAccount).toBe('923001111111');
    expect(socket1.end).toHaveBeenCalled();
    expect(socket2.end).toHaveBeenCalled();
    expect(fs.readFileSync(path.join(paths.whatsappDir, 'creds.json'), 'utf8')).toBe('new-staged');
  });
});
