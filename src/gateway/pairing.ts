import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { PokePaths } from '../config/paths.js';
import { normalizePhoneNumber } from '../config/config.js';
import { getLogger } from '../logger/logger.js';

const DEFAULT_PAIRING_TIMEOUT_MS = 5 * 60 * 1000;

export type PairingMethod =
  | { type: 'qr' }
  | { type: 'phone'; phoneNumber: string };

export interface PairingConnectionUpdate {
  connection?: 'open' | 'close' | 'connecting';
  qr?: string;
  lastDisconnect?: { error?: unknown };
}

export interface PairingSocket {
  ev: {
    on(event: 'creds.update' | 'connection.update', listener: (update: any) => void): unknown;
    off?(event: 'creds.update' | 'connection.update', listener: (update: any) => void): unknown;
  };
  requestPairingCode(phoneNumber: string): Promise<string>;
  end(error?: Error): unknown;
  user?: { id?: string } | null;
}

export interface PairingSocketFactory {
  create(stagingDirectory: string): Promise<{
    socket: PairingSocket;
    saveCreds: () => void | Promise<void>;
  }>;
}

export interface PairingRequest {
  method: PairingMethod;
  timeoutMs?: number;
  signal?: AbortSignal;
  onQr?: (qr: string) => void;
  onPairingCode?: (code: string) => void;
  onStatus?: (status: string) => void;
}

export interface PairingResult {
  paired: boolean;
  pairedAccount?: string;
}

export class PairingCancelledError extends Error {
  constructor() {
    super('WhatsApp pairing cancelled.');
    this.name = 'PairingCancelledError';
  }
}

export function normalizeE164PhoneNumber(value: string): string {
  const compact = value.trim().replace(/[\s\-().]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) {
    throw new Error('Enter a valid E.164 phone number, for example +923001234567.');
  }
  return compact.slice(1);
}

export function formatPairingCode(code: string): string {
  const compact = code.replace(/\s+/g, '');
  return compact.match(/.{1,4}/g)?.join('-') || compact;
}

export function createBaileysPairingSocketFactory(): PairingSocketFactory {
  return {
    async create(stagingDirectory) {
      const { state, saveCreds } = await useMultiFileAuthState(stagingDirectory);
      const { version } = await fetchLatestBaileysVersion();
      const socket = makeWASocket({
        version,
        auth: state,
        logger: getLogger().child({ module: 'baileys-pairing' }) as any,
      });
      return { socket: socket as unknown as PairingSocket, saveCreds };
    },
  };
}

/**
 * Owns short-lived pairing sockets only. The daemon remains the sole owner of
 * the long-lived gateway socket and only sees the session after a successful
 * staged swap.
 */
export class WhatsAppPairingService {
  constructor(
    private readonly paths: Pick<PokePaths, 'whatsappDir'>,
    private readonly factory: PairingSocketFactory = createBaileysPairingSocketFactory()
  ) {}

  async pair(request: PairingRequest): Promise<PairingResult> {
    // Reject malformed phone numbers before allocating a staging directory or
    // opening a socket. Besides giving the caller the right error, this keeps
    // a failed prompt from leaving a connection waiter alive until timeout.
    const phoneNumber = request.method.type === 'phone'
      ? normalizeE164PhoneNumber(request.method.phoneNumber)
      : undefined;
    const stagingDirectory = `${this.paths.whatsappDir}.staging-${randomUUID()}`;
    await fs.mkdir(stagingDirectory, { recursive: true, mode: 0o700 });

    let activeSocket: PairingSocket | undefined;
    let committed = false;
    const cancelWaiter = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, cancelWaiter.signal])
      : cancelWaiter.signal;

    const createSocket = async (): Promise<PairingSocket> => {
      const connection = await this.factory.create(stagingDirectory);
      const socket = connection.socket;
      activeSocket = socket;
      socket.ev.on('creds.update', () => {
        void Promise.resolve(connection.saveCreds()).catch((error: unknown) => {
          getLogger().warn({ err: error instanceof Error ? error.message : String(error) }, 'Failed to persist pairing credentials');
        });
      });
      return socket;
    };

    try {
      const initialSocket = await createSocket();

      const open = this.waitForOpen(
        initialSocket,
        createSocket,
        { ...request, signal },
        request.timeoutMs || DEFAULT_PAIRING_TIMEOUT_MS
      );
      // A code request can fail before we await `open`. Attach a rejection
      // handler now so that failure does not become an unhandled rejection.
      void open.catch(() => undefined);

      if (phoneNumber) {
        request.onStatus?.('Requesting a WhatsApp pairing code…');
        const code = await initialSocket.requestPairingCode(phoneNumber);
        request.onPairingCode?.(formatPairingCode(code));
      } else {
        request.onStatus?.('Scan the WhatsApp QR code to pair this account.');
      }

      const pairedAccount = await open;
      if (activeSocket) {
        await Promise.resolve(activeSocket.end());
        activeSocket = undefined;
      }
      await this.commitStagedSession(stagingDirectory);
      committed = true;
      return { paired: true, pairedAccount };
    } catch (error) {
      // `waitForOpen` owns its timeout and listener. Abort it on every error
      // path that occurs before a connection opens, including a failed phone
      // pairing-code request.
      cancelWaiter.abort();
      throw error;
    } finally {
      if (activeSocket) {
        try {
          await Promise.resolve(activeSocket.end());
        } catch {
          // The staged directory remains disposable even if socket close fails.
        }
      }
      if (!committed) {
        await fs.rm(stagingDirectory, { recursive: true, force: true });
      }
    }
  }

  async clearSession(): Promise<void> {
    await fs.rm(this.paths.whatsappDir, { recursive: true, force: true });
  }

  private async waitForOpen(
    initialSocket: PairingSocket,
    recreateSocket: () => Promise<PairingSocket>,
    request: PairingRequest,
    timeoutMs: number
  ): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve, reject) => {
      let settled = false;
      let currentSocket = initialSocket;

      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        currentSocket.ev.off?.('connection.update', onUpdate);
        outcome();
      };

      const onAbort = () => finish(() => reject(new PairingCancelledError()));

      const attach = (socket: PairingSocket) => {
        currentSocket = socket;
        socket.ev.on('connection.update', onUpdate);
      };

      const onUpdate = (update: PairingConnectionUpdate) => {
        if (update.qr) request.onQr?.(update.qr);
        if (update.connection === 'open') {
          const rawId = currentSocket.user?.id || '';
          const pairedAccount = rawId ? normalizePhoneNumber(rawId.replace(/@.*$/, '').split(':')[0]) : undefined;
          finish(() => resolve(pairedAccount || undefined));
        } else if (update.connection === 'close') {
          const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            currentSocket.ev.off?.('connection.update', onUpdate);
            void Promise.resolve(currentSocket.end()).catch(() => {});
            void recreateSocket().then(
              (newSock) => {
                if (settled) {
                  void Promise.resolve(newSock.end()).catch(() => {});
                  return;
                }
                attach(newSock);
              },
              (err: unknown) => {
                finish(() => reject(err instanceof Error ? err : new Error(String(err))));
              }
            );
            return;
          }
          finish(() => reject(new Error(describeDisconnect(update.lastDisconnect?.error))));
        }
      };

      const timeout = setTimeout(() => {
        finish(() => reject(new Error('WhatsApp pairing timed out. The previous session was kept.')));
      }, timeoutMs);

      if (request.signal?.aborted) {
        onAbort();
        return;
      }
      request.signal?.addEventListener('abort', onAbort, { once: true });
      attach(initialSocket);
    });
  }

  private async commitStagedSession(stagingDirectory: string): Promise<void> {
    const backupDirectory = `${this.paths.whatsappDir}.backup-${randomUUID()}`;
    let previousMoved = false;
    try {
      try {
        await fs.rename(this.paths.whatsappDir, backupDirectory);
        previousMoved = true;
      } catch (error: unknown) {
        if (!isCode(error, 'ENOENT')) throw error;
      }
      await fs.rename(stagingDirectory, this.paths.whatsappDir);
    } catch (error) {
      if (previousMoved) {
        try {
          await fs.rename(backupDirectory, this.paths.whatsappDir);
        } catch {
          // Preserve the original failure. Manual recovery can use the backup.
        }
      }
      throw error;
    }

    if (previousMoved) {
      await fs.rm(backupDirectory, { recursive: true, force: true });
    }
  }
}

function describeDisconnect(error: unknown): string {
  const statusCode = (error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
    return 'WhatsApp logged out during pairing. The previous session was kept.';
  }
  return 'WhatsApp closed the pairing connection. The previous session was kept.';
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}
