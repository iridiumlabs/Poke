import { getLogger } from '../logger/logger.js';

export type WAPresenceType = 'unavailable' | 'available' | 'composing' | 'recording' | 'paused';

export interface WhatsAppPresenceSocketLike {
  sendPresenceUpdate?(type: WAPresenceType, toJid?: string): Promise<void>;
}

export interface WhatsAppPresenceOptions {
  refreshIntervalMs?: number;
}

export class WhatsAppPresence {
  private activeTurns = new Set<string>();
  private turnAliases = new Map<string, string>();
  private activeRecordingTokens = new Set<string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private currentPresence: 'idle' | 'composing' | 'recording' = 'idle';
  private readonly refreshIntervalMs: number;

  constructor(
    private getSocket: () => WhatsAppPresenceSocketLike | null,
    private getOwnerJid: () => string,
    options: WhatsAppPresenceOptions = {}
  ) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? 8000;
  }

  getActiveTurnCount(): number {
    return this.activeTurns.size;
  }

  isRecording(): boolean {
    return this.activeRecordingTokens.size > 0;
  }

  getCurrentPresence(): 'idle' | 'composing' | 'recording' {
    return this.currentPresence;
  }

  startTurn(key?: string): string {
    const turnKey = key || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeTurns.add(turnKey);

    if (this.activeRecordingTokens.size > 0) {
      return turnKey;
    }

    if (this.currentPresence !== 'composing') {
      this.currentPresence = 'composing';
      this.sendUpdate('composing');
      this.ensureRefreshTimer();
    }
    return turnKey;
  }

  attachTurnAlias(key: string, alias: string): void {
    if (this.activeTurns.has(key)) {
      this.turnAliases.set(alias, key);
    }
  }

  stopTurn(key?: string): void {
    if (key) {
      const resolvedKey = this.turnAliases.get(key) || key;
      this.activeTurns.delete(resolvedKey);
      this.activeTurns.delete(key);
      for (const [alias, target] of this.turnAliases.entries()) {
        if (target === resolvedKey || target === key || alias === key || alias === resolvedKey) {
          this.turnAliases.delete(alias);
        }
      }
    } else {
      this.activeTurns.clear();
      this.turnAliases.clear();
    }

    if (this.activeTurns.size > 0) {
      if (this.activeRecordingTokens.size === 0 && this.currentPresence !== 'composing') {
        this.currentPresence = 'composing';
        this.sendUpdate('composing');
        this.ensureRefreshTimer();
      }
      return;
    }

    if (this.activeRecordingTokens.size > 0) {
      return;
    }

    if (this.currentPresence !== 'idle') {
      this.clearRefreshTimer();
      this.currentPresence = 'idle';
      this.sendUpdate('paused');
    }
  }

  startRecording(token?: string): string {
    const recordingToken = token || `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeRecordingTokens.add(recordingToken);
    if (this.currentPresence !== 'recording') {
      this.currentPresence = 'recording';
      this.sendUpdate('recording');
      this.ensureRefreshTimer();
    }
    return recordingToken;
  }

  stopRecording(token?: string): void {
    if (token) {
      this.activeRecordingTokens.delete(token);
    } else if (this.activeRecordingTokens.size > 0) {
      const first = this.activeRecordingTokens.values().next().value;
      if (first) {
        this.activeRecordingTokens.delete(first);
      }
    }

    if (this.activeRecordingTokens.size > 0) {
      return;
    }

    if (this.activeTurns.size > 0) {
      if (this.currentPresence !== 'composing') {
        this.currentPresence = 'composing';
        this.sendUpdate('composing');
        this.ensureRefreshTimer();
      }
    } else {
      if (this.currentPresence !== 'idle') {
        this.clearRefreshTimer();
        this.currentPresence = 'idle';
        this.sendUpdate('paused');
      }
    }
  }

  clear(): void {
    this.activeTurns.clear();
    this.turnAliases.clear();
    this.activeRecordingTokens.clear();
    this.clearRefreshTimer();
    if (this.currentPresence !== 'idle') {
      this.currentPresence = 'idle';
      this.sendUpdate('paused');
    }
  }

  stop(): void {
    this.clear();
  }

  pauseTimer(): void {
    this.clearRefreshTimer();
  }

  resumeTimerIfNeeded(): void {
    if (this.activeRecordingTokens.size > 0 || this.activeTurns.size > 0) {
      this.ensureRefreshTimer();
      if (this.activeRecordingTokens.size > 0) {
        this.currentPresence = 'recording';
        this.sendUpdate('recording');
      } else {
        this.currentPresence = 'composing';
        this.sendUpdate('composing');
      }
    }
  }

  private sendUpdate(type: WAPresenceType): Promise<void> {
    const sock = this.getSocket();
    const jid = this.getOwnerJid();
    if (!sock || !jid || typeof sock.sendPresenceUpdate !== 'function') {
      return Promise.resolve();
    }
    try {
      const res = sock.sendPresenceUpdate(type, jid);
      if (res && typeof res.catch === 'function') {
        return res.catch((err: any) => {
          getLogger().debug(
            { type, jid, err: err?.message || String(err) },
            'Failed to send WhatsApp presence update'
          );
        });
      }
      return Promise.resolve();
    } catch (err: any) {
      getLogger().debug(
        { type, jid, err: err?.message || String(err) },
        'Failed to send WhatsApp presence update'
      );
      return Promise.resolve();
    }
  }

  private ensureRefreshTimer(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (this.currentPresence === 'recording') {
        this.sendUpdate('recording');
      } else if (this.currentPresence === 'composing') {
        this.sendUpdate('composing');
      } else {
        this.clearRefreshTimer();
      }
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
