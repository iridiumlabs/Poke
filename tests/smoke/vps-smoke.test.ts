import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDoctor } from '../../src/cli/doctor.js';
import { ConfigManager } from '../../src/config/config.js';
import { PokeDatabase } from '../../src/db/database.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { CompactionManager } from '../../src/context/compaction-manager.js';

describe('VPS Smoke Test Suite', () => {
  it('passes comprehensive health check in initialized environment', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-smoke-'));

    try {
      const config = new ConfigManager(tempDir);
      config.setOwnerPhoneNumber('+92 300 1234567');
      config.updateCredentials({
        exaApiKey: 'smoke-exa-key',
        deepgramApiKey: 'smoke-dg-key',
        commandCodeApiKey: 'smoke-cmd-key',
      });
      config.setMainModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });

      const db = new PokeDatabase(tempDir);
      const skills = new SkillRegistry(path.join(tempDir, 'skills'));
      skills.seedDefaultSkills();

      const compaction = new CompactionManager(db, config);
      expect(compaction.getStats().approximateTokens).toBe(0);

      const { checks } = await runDoctor(tempDir);
      const failedChecks = checks.filter((c) => !c.passed && !c.warning);

      expect(failedChecks.length).toBe(0);
      db.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
