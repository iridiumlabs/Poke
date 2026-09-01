import fs from 'fs';
import { PokeConfig, ModelSelection, ServiceCredentials } from './types.js';
import { resolvePokePaths, ensurePokeDirectories, PokePaths } from './paths.js';

export const DEFAULT_TIMEZONE = 'Asia/Karachi';

export function normalizePhoneNumber(rawNumber: string): string {
  // Strip non-digits except leading plus
  let cleaned = rawNumber.trim().replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  } else if (cleaned.startsWith('00')) {
    cleaned = cleaned.substring(2);
  }
  // Strip any remaining non-digit characters
  cleaned = cleaned.replace(/\D/g, '');
  return cleaned;
}

export function getDefaultConfig(): PokeConfig {
  return {
    timezone: DEFAULT_TIMEZONE,
    credentials: {},
    activeCapabilities: [],
  };
}

export class ConfigManager {
  private paths: PokePaths;
  private readonly initialize: boolean;

  constructor(customHome?: string, options: { initialize?: boolean } = {}) {
    this.paths = resolvePokePaths(customHome);
    this.initialize = options.initialize !== false;
    if (this.initialize) {
      ensurePokeDirectories(this.paths);
    }
  }

  getPaths(): PokePaths {
    return this.paths;
  }

  loadConfig(): PokeConfig {
    if (!fs.existsSync(this.paths.configFile)) {
      const defaultConfig = getDefaultConfig();
      if (this.initialize) {
        this.withConfigLock(() => {
          if (!fs.existsSync(this.paths.configFile)) {
            this.writeConfig(defaultConfig);
          }
        });
      }
      return this.readConfig();
    }

    return this.readConfig();
  }

  private readConfig(): PokeConfig {
    if (!fs.existsSync(this.paths.configFile)) {
      const defaultConfig = getDefaultConfig();
      return defaultConfig;
    }

    const raw = fs.readFileSync(this.paths.configFile, 'utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(
        `Failed to parse configuration file at ${this.paths.configFile}: ${err.message}`
      );
    }

    const config: PokeConfig = {
      ...getDefaultConfig(),
      ...parsed,
      timezone: DEFAULT_TIMEZONE, // Invariant: always Asia/Karachi
      credentials: {
        ...parsed?.credentials,
      },
    };
    return config;
  }

  saveConfig(config: PokeConfig): void {
    this.withConfigLock((lockId) => this.writeConfig(config, lockId));
  }

  private writeConfig(config: PokeConfig, lockId?: string): void {
    ensurePokeDirectories(this.paths);
    if (lockId) {
      const lockFile = `${this.paths.configFile}.lock`;
      try {
        const owner = fs.readFileSync(lockFile, 'utf8');
        if (owner !== lockId) {
          throw new Error('Config lock lease expired or was taken over.');
        }
      } catch (err: any) {
        if (err.message === 'Config lock lease expired or was taken over.') throw err;
        throw new Error(`Config lock is missing: ${err.message}`);
      }
    }
    const normalized: PokeConfig = {
      ...config,
      timezone: DEFAULT_TIMEZONE,
      credentials: { ...config.credentials },
    };
    const content = JSON.stringify(
      normalized,
      null,
      2
    );

    const tempFile = `${this.paths.configFile}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, content, { mode: 0o600 });
    fs.renameSync(tempFile, this.paths.configFile);
    try {
      fs.chmodSync(this.paths.configFile, 0o600);
    } catch {
      // Ignore if chmod fails on some FS
    }
  }

  private updateConfig(mutator: (config: PokeConfig) => void): void {
    this.withConfigLock((lockId) => {
      // Always start from disk while holding the lock. A live daemon and a
      // CLI process therefore patch only their own fields instead of writing
      // a stale whole-document cache over each other.
      const config = this.readConfig();
      mutator(config);
      this.writeConfig(config, lockId);
    });
  }

  private withConfigLock<T>(operation: (lockId: string) => T): T {
    ensurePokeDirectories(this.paths);
    const lockFile = `${this.paths.configFile}.lock`;
    const deadline = Date.now() + 5_000;
    let descriptor: number | undefined;
    const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    while (descriptor === undefined) {
      try {
        descriptor = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeFileSync(descriptor, lockId, 'utf8');
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
          if (ageMs > 60_000) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch (lockError: any) {
          if (lockError?.code !== 'ENOENT') throw lockError;
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting to update configuration at ${this.paths.configFile}.`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }

    try {
      return operation(lockId);
    } finally {
      try {
        fs.closeSync(descriptor);
      } finally {
        try {
          if (fs.existsSync(lockFile)) {
            const currentOwner = fs.readFileSync(lockFile, 'utf8');
            if (currentOwner === lockId) {
              fs.unlinkSync(lockFile);
            }
          }
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  getOwnerPhoneNumber(): string | undefined {
    const config = this.loadConfig();
    return config.ownerPhoneNumber;
  }

  setOwnerPhoneNumber(phoneNumber: string): void {
    const normalized = normalizePhoneNumber(phoneNumber);
    this.updateConfig((config) => {
      config.ownerPhoneNumber = normalized;
    });
  }

  getWhatsAppAccount(): string | undefined {
    return this.loadConfig().whatsappAccount;
  }

  setWhatsAppAccount(phoneNumber: string | undefined): void {
    this.updateConfig((config) => {
      config.whatsappAccount = phoneNumber;
    });
  }

  getCredentials(): ServiceCredentials {
    const config = this.loadConfig();
    return config.credentials;
  }

  updateCredentials(credentials: Partial<ServiceCredentials>): void {
    this.updateConfig((config) => {
      config.credentials = {
        ...config.credentials,
        ...credentials,
      };
    });
  }

  clearProviderCredentials(): void {
    this.updateConfig((config) => {
      const { fireworksApiKey, commandCodeApiKey, codexAuth, ...retained } = config.credentials;
      void fireworksApiKey;
      void commandCodeApiKey;
      void codexAuth;
      config.credentials = retained;
    });
  }

  getMainModel(): ModelSelection | undefined {
    const config = this.loadConfig();
    return config.mainModel;
  }

  setMainModel(modelSelection: ModelSelection): void {
    this.updateConfig((config) => {
      config.mainModel = modelSelection;
    });
  }

  getWorkerModel(): ModelSelection | undefined {
    const config = this.loadConfig();
    return config.workerModel;
  }

  setWorkerModel(modelSelection: ModelSelection): void {
    this.updateConfig((config) => {
      config.workerModel = modelSelection;
    });
  }

  getActiveCapabilities(): string[] {
    const config = this.loadConfig();
    return config.activeCapabilities || [];
  }

  addActiveCapability(capability: string): void {
    this.updateConfig((config) => {
      const caps = new Set(config.activeCapabilities || []);
      caps.add(capability);
      config.activeCapabilities = Array.from(caps);
    });
  }

  clearActiveCapabilities(): void {
    this.updateConfig((config) => {
      config.activeCapabilities = [];
    });
  }
}
