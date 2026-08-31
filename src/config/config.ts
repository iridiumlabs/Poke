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
  private configCache: PokeConfig | null = null;

  constructor(customHome?: string) {
    this.paths = resolvePokePaths(customHome);
    ensurePokeDirectories(this.paths);
  }

  getPaths(): PokePaths {
    return this.paths;
  }

  loadConfig(): PokeConfig {
    if (this.configCache) {
      return this.configCache;
    }

    if (!fs.existsSync(this.paths.configFile)) {
      const defaultConfig = getDefaultConfig();
      this.saveConfig(defaultConfig);
      this.configCache = defaultConfig;
      return defaultConfig;
    }

    try {
      const raw = fs.readFileSync(this.paths.configFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.configCache = {
        ...getDefaultConfig(),
        ...parsed,
        timezone: DEFAULT_TIMEZONE, // Invariant: always Asia/Karachi
        credentials: {
          ...parsed.credentials,
        },
      };
      return this.configCache!;
    } catch (err) {
      const defaultConfig = getDefaultConfig();
      this.configCache = defaultConfig;
      return defaultConfig;
    }
  }

  saveConfig(config: PokeConfig): void {
    ensurePokeDirectories(this.paths);
    const content = JSON.stringify(
      {
        ...config,
        timezone: DEFAULT_TIMEZONE,
      },
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
    this.configCache = config;
  }

  getOwnerPhoneNumber(): string | undefined {
    const config = this.loadConfig();
    return config.ownerPhoneNumber;
  }

  setOwnerPhoneNumber(phoneNumber: string): void {
    const normalized = normalizePhoneNumber(phoneNumber);
    const config = this.loadConfig();
    config.ownerPhoneNumber = normalized;
    this.saveConfig(config);
  }

  getCredentials(): ServiceCredentials {
    const config = this.loadConfig();
    return config.credentials;
  }

  updateCredentials(credentials: Partial<ServiceCredentials>): void {
    const config = this.loadConfig();
    config.credentials = {
      ...config.credentials,
      ...credentials,
    };
    this.saveConfig(config);
  }

  getMainModel(): ModelSelection | undefined {
    const config = this.loadConfig();
    return config.mainModel;
  }

  setMainModel(modelSelection: ModelSelection): void {
    const config = this.loadConfig();
    config.mainModel = modelSelection;
    this.saveConfig(config);
  }

  getWorkerModel(): ModelSelection | undefined {
    const config = this.loadConfig();
    return config.workerModel;
  }

  setWorkerModel(modelSelection: ModelSelection): void {
    const config = this.loadConfig();
    config.workerModel = modelSelection;
    this.saveConfig(config);
  }

  getActiveCapabilities(): string[] {
    const config = this.loadConfig();
    return config.activeCapabilities || [];
  }

  addActiveCapability(capability: string): void {
    const config = this.loadConfig();
    const caps = new Set(config.activeCapabilities || []);
    caps.add(capability);
    config.activeCapabilities = Array.from(caps);
    this.saveConfig(config);
  }

  clearActiveCapabilities(): void {
    const config = this.loadConfig();
    config.activeCapabilities = [];
    this.saveConfig(config);
  }
}
