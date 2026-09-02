import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDoctor } from '../../src/cli/doctor.js';
import { ConfigManager } from '../../src/config/config.js';
import { PokeDatabase } from '../../src/db/database.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { CompactionManager } from '../../src/context/compaction-manager.js';
import { FileCredentialStore } from '../../src/providers/credential-store.js';

describe('VPS Smoke Test Suite', () => {
  it('passes comprehensive health check in initialized environment', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-smoke-'));

    try {
      const config = new ConfigManager(tempDir);
      config.setOwnerPhoneNumber('+92 300 1234567');
      config.updateCredentials({
        composioApiKey: 'smoke-composio-key',
        supermemoryApiKey: 'smoke-supermemory-key',
        exaApiKey: 'smoke-exa-key',
        deepgramApiKey: 'smoke-dg-key',
        groqApiKey: 'smoke-groq-key',
      });
      config.setMainModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });
      config.setWorkerModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });
      await new FileCredentialStore(config.getPaths().credentialsFile).modify('commandcode', async () => ({
        type: 'api_key',
        key: 'smoke-cmd-key',
      }));

      const db = new PokeDatabase(tempDir);
      const skills = new SkillRegistry(path.join(tempDir, 'skills'));
      skills.seedDefaultSkills();

      const compaction = new CompactionManager(db, config);
      expect(compaction.getStats().approximateTokens).toBe(0);

      const { checks } = await runDoctor(tempDir, {
        catalog: {
          fetchModels: async () => [
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet', capabilities: { reasoningEfforts: [] } },
          ],
          validateSelection: async () => ({ valid: true }),
        },
        validateService: async () => undefined,
      });
      const failedChecks = checks.filter((c) => !c.passed && !c.warning);

      expect(failedChecks.length).toBe(0);
      db.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
