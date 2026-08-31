import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CompactionManager, ACTIVE_COMPACTION_TOKEN_THRESHOLD, IDLE_COMPACTION_TOKEN_THRESHOLD, IDLE_INACTIVITY_TIME_MS } from '../../src/context/compaction-manager.js';
import { PokeDatabase } from '../../src/db/database.js';
import { ConfigManager } from '../../src/config/config.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('CompactionManager', () => {
  let db: PokeDatabase;
  let config: ConfigManager;
  let tempDir: string;
  let manager: CompactionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-compact-test-'));
    db = new PokeDatabase(tempDir);
    config = new ConfigManager(tempDir);
    manager = new CompactionManager(db, config);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('triggers active compaction when token count reaches 272k', () => {
    manager.setEstimatedTokens(200000);
    expect(manager.shouldCompactActive()).toBe(false);

    manager.setEstimatedTokens(ACTIVE_COMPACTION_TOKEN_THRESHOLD);
    expect(manager.shouldCompactActive()).toBe(true);
  });

  it('evaluates idle threshold accurately: 99k vs 100k at 30 minutes', () => {
    // Under 100k tokens -> should not compact even after 30 minutes
    manager.setEstimatedTokens(99000);
    const thirtyOneMinutesAgo = Date.now() - (IDLE_INACTIVITY_TIME_MS + 60000);
    manager.setLastActivityTime(thirtyOneMinutesAgo);

    expect(manager.shouldCompactIdle()).toBe(false);

    // 100k tokens -> should compact after 30 minutes
    manager.setEstimatedTokens(IDLE_COMPACTION_TOKEN_THRESHOLD);
    expect(manager.shouldCompactIdle()).toBe(true);

    // If active work is running, idle compaction is blocked
    manager.setMainAgentBusy(true);
    expect(manager.shouldCompactIdle()).toBe(false);
  });

  it('resets conditional capabilities after successful compaction', () => {
    config.addActiveCapability('automations');
    expect(config.getActiveCapabilities()).toContain('automations');

    manager.onCompactionSuccess(20000);
    expect(config.getActiveCapabilities()).toEqual([]);
    expect(manager.getEstimatedTokens()).toBe(20000);
  });
});
