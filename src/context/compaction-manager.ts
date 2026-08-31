import { PokeDatabase } from '../db/database.js';
import { ConfigManager } from '../config/config.js';
import { getLogger } from '../logger/logger.js';

export const ACTIVE_COMPACTION_TOKEN_THRESHOLD = 272000;
export const IDLE_COMPACTION_TOKEN_THRESHOLD = 100000;
export const IDLE_INACTIVITY_TIME_MS = 30 * 60 * 1000; // 30 minutes
export const RECENT_TOKENS_RETENTION = 20000;

export interface ContextStats {
  approximateTokens: number;
  lastActivityTime: number;
  activeThreshold: number;
  idleThreshold: number;
  idleTimeMs: number;
  isIdleCompactable: boolean;
  isActiveCompactable: boolean;
}

export function estimateTokenCount(textOrObjects: any): number {
  if (!textOrObjects) return 0;
  if (typeof textOrObjects === 'string') {
    // Standard rule of thumb: ~4 characters per token
    return Math.ceil(textOrObjects.length / 4);
  }
  const str = JSON.stringify(textOrObjects);
  return Math.ceil(str.length / 4);
}

export class CompactionManager {
  private lastActivityTime: number = Date.now();
  private isMainAgentBusy = false;
  private approximateTokens = 0;

  constructor(
    private db: PokeDatabase,
    private configManager: ConfigManager
  ) {
    // Restore last activity from db if available
    const savedLastActivity = this.db.getState('last_activity_time');
    if (savedLastActivity) {
      this.lastActivityTime = parseInt(savedLastActivity, 10);
    }
    const savedTokens = this.db.getState('approximate_tokens');
    if (savedTokens) {
      this.approximateTokens = parseInt(savedTokens, 10);
    }
  }

  recordActivity(tokenDelta = 0): void {
    this.lastActivityTime = Date.now();
    if (tokenDelta > 0) {
      this.approximateTokens += tokenDelta;
    }
    this.db.setState('last_activity_time', String(this.lastActivityTime));
    this.db.setState('approximate_tokens', String(this.approximateTokens));
  }

  setLastActivityTime(timeMs: number): void {
    this.lastActivityTime = timeMs;
    this.db.setState('last_activity_time', String(this.lastActivityTime));
  }

  setMainAgentBusy(busy: boolean): void {
    this.isMainAgentBusy = busy;
    if (busy) {
      this.recordActivity();
    }
  }

  setEstimatedTokens(tokens: number): void {
    this.approximateTokens = tokens;
    this.db.setState('approximate_tokens', String(tokens));
  }

  getEstimatedTokens(): number {
    return this.approximateTokens;
  }

  getLastActivityTime(): number {
    return this.lastActivityTime;
  }

  getStats(): ContextStats {
    const now = Date.now();
    const idleDuration = now - this.getLastActivityTime();

    const isActiveCompactable = this.approximateTokens >= ACTIVE_COMPACTION_TOKEN_THRESHOLD;
    const isIdleCompactable =
      !this.isMainAgentBusy &&
      this.approximateTokens >= IDLE_COMPACTION_TOKEN_THRESHOLD &&
      idleDuration >= IDLE_INACTIVITY_TIME_MS;

    return {
      approximateTokens: this.approximateTokens,
      lastActivityTime: this.lastActivityTime,
      activeThreshold: ACTIVE_COMPACTION_TOKEN_THRESHOLD,
      idleThreshold: IDLE_COMPACTION_TOKEN_THRESHOLD,
      idleTimeMs: idleDuration,
      isIdleCompactable,
      isActiveCompactable,
    };
  }

  shouldCompactActive(): boolean {
    return this.approximateTokens >= ACTIVE_COMPACTION_TOKEN_THRESHOLD;
  }

  shouldCompactIdle(): boolean {
    const stats = this.getStats();
    return stats.isIdleCompactable;
  }

  shouldPreflightCompact(): boolean {
    return this.shouldCompactIdle();
  }

  onCompactionSuccess(remainingTokens = RECENT_TOKENS_RETENTION): void {
    const logger = getLogger();
    logger.info({ remainingTokens }, 'Compaction succeeded, clearing active conditional capabilities');

    // 1. Clear conditional capabilities
    this.configManager.clearActiveCapabilities();

    // 2. Reset token counter to retained raw tokens + summary estimate
    this.approximateTokens = remainingTokens;
    this.db.setState('approximate_tokens', String(this.approximateTokens));
    this.recordActivity();
  }

  onCompactionFailure(error: any): void {
    const logger = getLogger();
    logger.error({ err: error.message }, 'Compaction failed; conversation preserved');
    this.db.recordOperationalError('compaction', `Compaction failed: ${error.message}`);
  }
}
