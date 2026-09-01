import fs from 'node:fs/promises';
import path from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { getLogger } from '../logger/logger.js';

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 60_000;
const STALE_LOCK_MS = 5 * 60_000;

interface CredentialDocument {
  version: 1;
  credentials: Record<string, Credential>;
}

interface FileLock {
  handle: fs.FileHandle;
  id: string;
}

function pause(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object') return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === 'api_key') {
    return credential.key === undefined || typeof credential.key === 'string';
  }
  return (
    credential.type === 'oauth' &&
    typeof credential.access === 'string' &&
    typeof credential.refresh === 'string' &&
    typeof credential.expires === 'number'
  );
}

function emptyDocument(): CredentialDocument {
  return { version: 1, credentials: {} };
}

export class FileCredentialStore implements CredentialStore {
  private readonly lockFile: string;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly file: string) {
    this.lockFile = `${file}.lock`;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    this.assertProviderId(providerId);
    const document = await this.readDocument();
    return document.credentials[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const document = await this.readDocument();
    return Object.entries(document.credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    this.assertProviderId(providerId);
    return await this.serialize(providerId, async () =>
      this.withFileLock(async () => {
        const document = await this.readDocument();
        const current = document.credentials[providerId];
        const next = await fn(current);

        // pi-ai uses undefined as "leave the stored credential unchanged".
        if (next === undefined) return current;
        if (!isCredential(next)) {
          throw new Error('Refusing to persist an invalid provider credential.');
        }

        document.credentials[providerId] = next;
        await this.writeDocument(document);
        return next;
      })
    );
  }

  async delete(providerId: string): Promise<void> {
    this.assertProviderId(providerId);
    await this.serialize(providerId, async () =>
      this.withFileLock(async () => {
        const document = await this.readDocument();
        if (!(providerId in document.credentials)) return;
        delete document.credentials[providerId];
        await this.writeDocument(document);
      })
    );
  }

  private async serialize<T>(providerId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(providerId) || Promise.resolve();
    const result = prior.catch(() => undefined).then(action);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(providerId, tail);
    try {
      return await result;
    } finally {
      if (this.chains.get(providerId) === tail) {
        this.chains.delete(providerId);
      }
    }
  }

  private async withFileLock<T>(action: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock();
    try {
      return await action();
    } finally {
      await this.releaseLock(lock);
    }
  }

  private async acquireLock(): Promise<FileLock> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    while (Date.now() < deadline) {
      try {
        const handle = await fs.open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(id, 'utf8');
        return { handle, id };
      } catch (error: unknown) {
        if (!isCode(error, 'EEXIST')) throw error;
        await this.removeStaleLock();
        await pause(LOCK_WAIT_MS);
      }
    }

    throw new Error('Credential store is busy. Try again shortly.');
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const stat = await fs.stat(this.lockFile);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.unlink(this.lockFile);
      }
    } catch (error: unknown) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
  }

  private async releaseLock(lock: FileLock): Promise<void> {
    try {
      await lock.handle.close();
    } catch {
      // Ignore handle close failure
    }
    try {
      const owner = await fs.readFile(this.lockFile, 'utf8');
      if (owner === lock.id) {
        await fs.unlink(this.lockFile);
      }
    } catch (error: unknown) {
      if (!isCode(error, 'ENOENT')) {
        getLogger().warn({ err: error instanceof Error ? error.message : String(error) }, 'Failed to remove lock file');
      }
    }
  }

  private async readDocument(): Promise<CredentialDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error: unknown) {
      if (isCode(error, 'ENOENT')) return emptyDocument();
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Credential store is malformed. Restore it from a known-good backup.');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Credential store has an invalid format.');
    }
    const credentials = (parsed as { credentials?: unknown }).credentials;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new Error('Credential store has an invalid credentials section.');
    }

    const validated: Record<string, Credential> = {};
    for (const [providerId, credential] of Object.entries(credentials as Record<string, unknown>)) {
      if (!isCredential(credential)) {
        throw new Error(`Credential store contains an invalid entry for provider "${providerId}".`);
      }
      validated[providerId] = credential;
    }

    return { version: 1, credentials: validated };
  }

  private async writeDocument(document: CredentialDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const handle = await fs.open(temporary, 'wx', 0o600);

    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.rename(temporary, this.file);
      await fs.chmod(this.file, 0o600);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private assertProviderId(providerId: string): void {
    if (!providerId || providerId.trim() !== providerId) {
      throw new Error('Provider ID is required.');
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}
