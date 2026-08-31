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
  fireworksApiKey?: string;
  commandCodeApiKey?: string;
  codexAuth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    accountId?: string;
  };
}

export interface PokeConfig {
  ownerPhoneNumber?: string;
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
