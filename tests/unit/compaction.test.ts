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
    // Active pressure is an admission gate even without 30 minutes of idle
    // time, so a new submission cannot push an oversized context further.
    expect(manager.shouldPreflightCompact()).toBe(true);
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

  it('resets conditional capabilities after successful compaction without updating last activity time', () => {
    config.addActiveCapability('automations');
    expect(config.getActiveCapabilities()).toContain('automations');

    const pastTime = Date.now() - 3600000;
    manager.setLastActivityTime(pastTime);

    manager.onCompactionSuccess(20000);
    expect(config.getActiveCapabilities()).toEqual([]);
    expect(manager.getEstimatedTokens()).toBe(20000);
    // Compaction must not mutate last activity time
    expect(manager.getLastActivityTime()).toBe(pastTime);
  });

  it('setMainAgentBusy updates busy state without triggering phantom activity', () => {
    const pastTime = Date.now() - 3600000;
    manager.setLastActivityTime(pastTime);

    expect(manager.isBusy()).toBe(false);
    manager.setMainAgentBusy(true);
    expect(manager.isBusy()).toBe(true);
    expect(manager.getLastActivityTime()).toBe(pastTime);

    manager.setMainAgentBusy(false);
    expect(manager.isBusy()).toBe(false);
    expect(manager.getLastActivityTime()).toBe(pastTime);
  });

  it('calculates active conversation token estimate and reflects compaction reduction', () => {
    // Setup Flue table in sqlite
    (db as any).db.exec(`
      CREATE TABLE IF NOT EXISTS flue_conversation_stream_batches (
        path TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (path, seq)
      );
    `);

    const streamPath = 'agents/PokeMainAgent/owner';
    const longMessage = 'A'.repeat(40000); // ~10,000 tokens

    // 1. Initial messages before compaction
    const batch1 = [
      { type: 'user_message', content: longMessage },
      { type: 'assistant_text_completed', text: longMessage },
    ];
    (db as any).db
      .prepare('INSERT INTO flue_conversation_stream_batches (path, seq, data) VALUES (?, ?, ?)')
      .run(streamPath, 1, JSON.stringify(batch1));

    const beforeEstimate = db.getActiveConversationTokenEstimate('PokeMainAgent', 'owner');
    expect(beforeEstimate).toBeGreaterThanOrEqual(20000);

    // 2. Add compaction record + small recent message
    const summary = 'Summary of prior discussion.';
    const recentMsg = 'Short recent message.';
    const batch2 = [
      { type: 'compaction', entryId: 'c1', summary, details: { readFiles: ['/a/b'] } },
      { type: 'user_message', content: recentMsg },
    ];
    (db as any).db
      .prepare('INSERT INTO flue_conversation_stream_batches (path, seq, data) VALUES (?, ?, ?)')
      .run(streamPath, 2, JSON.stringify(batch2));

    const afterEstimate = db.getActiveConversationTokenEstimate('PokeMainAgent', 'owner');
    expect(afterEstimate).toBeLessThan(beforeEstimate!);
    expect(afterEstimate).toBeLessThan(1000);

    // 3. Add older historical batches and a second newer compaction
    const batch3 = [
      { type: 'compaction', entryId: 'c2', summary: 'Second compaction summary.', details: {} },
      { type: 'user_message', content: 'Newest message.' },
    ];
    (db as any).db
      .prepare('INSERT INTO flue_conversation_stream_batches (path, seq, data) VALUES (?, ?, ?)')
      .run(streamPath, 3, JSON.stringify(batch3));

    const newestEstimate = db.getActiveConversationTokenEstimate('PokeMainAgent', 'owner');
    expect(newestEstimate).toBeLessThan(1000);
  });
});
