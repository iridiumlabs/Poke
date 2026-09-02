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
  private isVoiceRecording = false;
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
    return this.isVoiceRecording;
  }

  getCurrentPresence(): 'idle' | 'composing' | 'recording' {
    return this.currentPresence;
  }

  startTurn(key?: string): string {
    const turnKey = key || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeTurns.add(turnKey);

    if (this.isVoiceRecording) {
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
      this.turnAliases.delete(key);
    } else {
      this.activeTurns.clear();
      this.turnAliases.clear();
    }

    if (this.activeTurns.size > 0) {
      if (!this.isVoiceRecording && this.currentPresence !== 'composing') {
        this.currentPresence = 'composing';
        this.sendUpdate('composing');
        this.ensureRefreshTimer();
      }
      return;
    }

    if (this.isVoiceRecording) {
      return;
    }

    if (this.currentPresence !== 'idle') {
      this.clearRefreshTimer();
      this.currentPresence = 'idle';
      this.sendUpdate('paused');
    }
  }

  startRecording(): void {
    this.isVoiceRecording = true;
    if (this.currentPresence !== 'recording') {
      this.currentPresence = 'recording';
      this.sendUpdate('recording');
      this.ensureRefreshTimer();
    }
  }

  stopRecording(): void {
    this.isVoiceRecording = false;

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
    this.isVoiceRecording = false;
    this.clearRefreshTimer();
    if (this.currentPresence !== 'idle') {
      this.currentPresence = 'idle';
      this.sendUpdate('paused');
    }
  }

  stop(): void {
    this.activeTurns.clear();
    this.turnAliases.clear();
    this.isVoiceRecording = false;
    this.clearRefreshTimer();
    if (this.currentPresence !== 'idle') {
      this.currentPresence = 'idle';
      this.sendUpdate('paused');
    }
  }

  pauseTimer(): void {
    this.clearRefreshTimer();
  }

  resumeTimerIfNeeded(): void {
    if (this.activeTurns.size > 0 || this.isVoiceRecording) {
      this.ensureRefreshTimer();
      if (this.isVoiceRecording) {
        this.sendUpdate('recording');
      } else {
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
