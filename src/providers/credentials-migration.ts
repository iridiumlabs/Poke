import type { CredentialStore } from '@earendil-works/pi-ai';
import { ConfigManager } from '../config/config.js';

export interface CredentialMigrationResult {
  migrated: string[];
  codexReloginRequired: boolean;
}

/**
 * Moves old config-embedded API keys into the private credential store.
 *
 * The legacy Codex record is deliberately not migrated: it is not a valid,
 * refreshable OAuth credential.
 */
export async function migrateLegacyProviderCredentials(
  config: ConfigManager,
  credentials: CredentialStore
): Promise<CredentialMigrationResult> {
  const legacy = config.getCredentials();
  const candidates = [
    ['fireworks', legacy.fireworksApiKey],
    ['commandcode', legacy.commandCodeApiKey],
  ] as const;
  const migrated: string[] = [];

  for (const [providerId, apiKey] of candidates) {
    if (!apiKey) continue;
    await credentials.modify(providerId, async (current) => {
      if (current) return current;
      return { type: 'api_key', key: apiKey };
    });
    migrated.push(providerId);
  }

  const codexReloginRequired = Boolean(legacy.codexAuth);
  if (migrated.length > 0 || codexReloginRequired) {
    config.clearProviderCredentials();
  }

  return { migrated, codexReloginRequired };
}
