export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelCapabilities {
  reasoningEfforts: ReasoningEffort[];
  acceptsImages?: boolean;
  contextWindow?: number;
}

export type ProviderType = 'codex' | 'fireworks' | 'commandcode';

export interface ModelSelection {
  provider: ProviderType;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ServiceCredentials {
  composioApiKey?: string;
  supermemoryApiKey?: string;
  exaApiKey?: string;
  deepgramApiKey?: string;
  groqApiKey?: string;
  /** @deprecated Read only to migrate existing installations into credentials.json. */
  fireworksApiKey?: string;
  /** @deprecated Read only to migrate existing installations into credentials.json. */
  commandCodeApiKey?: string;
  /** @deprecated Legacy token state cannot be refreshed and is discarded during migration. */
  codexAuth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    accountId?: string;
  };
}

export interface PokeConfig {
  ownerPhoneNumber?: string;
  whatsappAccount?: string;
  timezone: 'Asia/Karachi';
  credentials: ServiceCredentials;
  mainModel?: ModelSelection;
  workerModel?: ModelSelection;
  activeCapabilities?: string[];
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  capabilities: ModelCapabilities;
}
