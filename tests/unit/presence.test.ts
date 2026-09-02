import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppPresence } from '../../src/gateway/presence.js';
import { WhatsAppSender } from '../../src/gateway/sender.js';
import { WhatsAppGateway } from '../../src/gateway/whatsapp.js';
import { PokeRuntime } from '../../src/agent/runtime.js';
import { PokeDatabase } from '../../src/db/database.js';
import { ConfigManager } from '../../src/config/config.js';
import { DeepgramHandler } from '../../src/gateway/deepgram.js';
import { CompactionManager } from '../../src/context/compaction-manager.js';
import { WorkerManager } from '../../src/workers/worker-manager.js';
import { AutomationScheduler } from '../../src/scheduler/scheduler.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExaToolHandler } from '../../src/tools/exa.js';
import { SupermemoryToolHandler } from '../../src/tools/supermemory.js';
import { ComposioToolHandler } from '../../src/tools/composio.js';

describe('WhatsApp Presence: Composing, Recording, Refresh & Lifecycle', () => {
  let tempDir: string;
  let db: PokeDatabase;
  let config: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-presence-test-'));
    db = new PokeDatabase(tempDir);
    config = new ConfigManager(tempDir);
    config.setOwnerPhoneNumber('+92 300 1234567');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('WhatsAppPresence Unit Tests', () => {
    it('sends composing presence immediately upon starting a turn', () => {
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      const presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net',
        { refreshIntervalMs: 8000 }
      );

      presence.startTurn('turn-1');

      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledTimes(1);
      expect(presenceUpdates[0]).toEqual({
        type: 'composing',
        toJid: '923001234567@s.whatsapp.net',
      });
      expect(presence.getActiveTurnCount()).toBe(1);
      expect(presence.getCurrentPresence()).toBe('composing');

      presence.stop();
    });

    it('periodically refreshes composing presence so it does not expire during longer work', async () => {
      vi.useFakeTimers();
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      const presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net',
        { refreshIntervalMs: 5000 }
      );

      presence.startTurn('turn-long');
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledTimes(1);

      // Advance by 5s -> refresh 1
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledTimes(2);
      expect(presenceUpdates[1].type).toBe('composing');

      // Advance by 5s -> refresh 2
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledTimes(3);
      expect(presenceUpdates[2].type).toBe('composing');

      // Stop turn -> sends paused and stops timer
      presence.stopTurn('turn-long');
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledTimes(4);
      expect(presenceUpdates[3].type).toBe('paused');

      // Advance further -> no more updates
      await vi.advanceTimersByTimeAsync(15000);
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledTimes(4);

      presence.stop();
    });

    it('handles overlapping turns safely and only sends paused when all turns settle', () => {
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      const presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net',
        { refreshIntervalMs: 8000 }
      );

      // Turn 1 starts -> composing
      presence.startTurn('turn-1');
      expect(presenceUpdates).toEqual([{ type: 'composing', toJid: '923001234567@s.whatsapp.net' }]);
      expect(presence.getActiveTurnCount()).toBe(1);

      // Turn 2 starts -> still composing
      presence.startTurn('turn-2');
      expect(presence.getActiveTurnCount()).toBe(2);

      // Turn 1 settles -> active count is 1, remains composing (no paused sent)
      presence.stopTurn('turn-1');
      expect(presence.getActiveTurnCount()).toBe(1);
      expect(presence.getCurrentPresence()).toBe('composing');
      expect(presenceUpdates).toHaveLength(1);

      // Turn 2 settles -> active count is 0, sends paused
      presence.stopTurn('turn-2');
      expect(presence.getActiveTurnCount()).toBe(0);
      expect(presence.getCurrentPresence()).toBe('idle');
      expect(presenceUpdates).toEqual([
        { type: 'composing', toJid: '923001234567@s.whatsapp.net' },
        { type: 'paused', toJid: '923001234567@s.whatsapp.net' },
      ]);

      presence.stop();
    });

    it('resolves turn aliases when stopping by submissionId or sourceKey', () => {
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      const presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net',
        { refreshIntervalMs: 8000 }
      );

      presence.startTurn('whatsapp:msg-100');
      presence.attachTurnAlias('whatsapp:msg-100', 'sub_ik_100');
      expect(presence.getActiveTurnCount()).toBe(1);

      // Stopping with submissionId alias settles the turn
      presence.stopTurn('sub_ik_100');
      expect(presence.getActiveTurnCount()).toBe(0);
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused']);

      presence.stop();
    });

    it('switches to recording mode and restores composing if turn is still active', () => {
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      const presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net',
        { refreshIntervalMs: 8000 }
      );

      // Turn starts -> composing
      presence.startTurn('turn-voice');
      expect(presence.getCurrentPresence()).toBe('composing');

      // Voice recording starts -> recording
      presence.startRecording();
      expect(presence.getCurrentPresence()).toBe('recording');
      expect(presence.isRecording()).toBe(true);

      // Voice recording finishes while turn is still active -> restores composing
      presence.stopRecording();
      expect(presence.getCurrentPresence()).toBe('composing');
      expect(presence.isRecording()).toBe(false);

      // Turn finishes -> paused
      presence.stopTurn('turn-voice');
      expect(presence.getCurrentPresence()).toBe('idle');

      expect(presenceUpdates.map((u) => u.type)).toEqual([
        'composing',
        'recording',
        'composing',
        'paused',
      ]);

      presence.stop();
    });

    it('transitions to paused on stopRecording if no foreground turn is active', () => {
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      const presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net',
        { refreshIntervalMs: 8000 }
      );

      presence.startRecording();
      expect(presence.getCurrentPresence()).toBe('recording');

      presence.stopRecording();
      expect(presence.getCurrentPresence()).toBe('idle');

      expect(presenceUpdates.map((u) => u.type)).toEqual(['recording', 'paused']);
      presence.stop();
    });

    it('is non-blocking and resilient to socket errors or missing methods', async () => {
      const mockFailingSocket = {
        sendPresenceUpdate: vi.fn().mockRejectedValue(new Error('Connection dropped')),
      };

      const presence = new WhatsAppPresence(
        () => mockFailingSocket,
        () => '923001234567@s.whatsapp.net',
        { refreshIntervalMs: 8000 }
      );

      // Does not throw
      expect(() => presence.startTurn('t1')).not.toThrow();
      expect(() => presence.startRecording()).not.toThrow();
      expect(() => presence.stopRecording()).not.toThrow();
      expect(() => presence.stopTurn('t1')).not.toThrow();
      expect(() => presence.clear()).not.toThrow();
      expect(() => presence.stop()).not.toThrow();

      // Null socket does not throw
      const nullPresence = new WhatsAppPresence(
        () => null,
        () => '923001234567@s.whatsapp.net'
      );
      expect(() => nullPresence.startTurn('t2')).not.toThrow();
      expect(() => nullPresence.stopTurn('t2')).not.toThrow();
    });
  });

  describe('WhatsAppSender Voice-Mode Recording Transition', () => {
    it('switches to recording during voice synthesis and restores composing if turn active', async () => {
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendMessage: vi.fn().mockResolvedValue({ key: { id: 'voice-msg-1' } }),
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      const fakeAudioPath = path.join(tempDir, 'sample-voice.ogg');
      fs.writeFileSync(fakeAudioPath, 'fake-voice-bytes');

      const fakeDeepgram = {
        synthesizeToAudioFile: vi.fn().mockImplementation(async () => {
          // Check that recording is active DURING synthesis
          expect(presence.getCurrentPresence()).toBe('recording');
          return { audioPath: fakeAudioPath, mimeType: 'audio/ogg; codecs=opus' };
        }),
      } as unknown as DeepgramHandler;

      const presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net'
      );

      const sender = new WhatsAppSender(
        () => mockSocket,
        '923001234567@s.whatsapp.net',
        db,
        fakeDeepgram,
        presence
      );

      // Simulate active foreground turn in main agent
      presence.startTurn('turn-agent');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing']);

      const result = await sender.send({
        mode: 'voice',
        text: 'Hello from voice agent',
      });

      expect(result.mode).toBe('voice');
      // After send finishes, composing is restored because foreground turn is still active
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'recording', 'composing']);

      // Main agent finishes turn
      presence.stopTurn('turn-agent');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'recording', 'composing', 'paused']);
    });

    it('safely calls stopRecording and restores state when voice synthesis fails', async () => {
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendMessage: vi.fn().mockResolvedValue({ key: { id: 'voice-fail' } }),
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      const failingDeepgram = {
        synthesizeToAudioFile: vi.fn().mockRejectedValue(new Error('Deepgram quota exceeded')),
      } as unknown as DeepgramHandler;

      const presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net'
      );

      const sender = new WhatsAppSender(
        () => mockSocket,
        '923001234567@s.whatsapp.net',
        db,
        failingDeepgram,
        presence
      );

      presence.startTurn('turn-active');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing']);

      await expect(
        sender.send({ mode: 'voice', text: 'Will fail TTS' })
      ).rejects.toThrow('Deepgram quota exceeded');

      // Despite error, recording stopped and composing was restored
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'recording', 'composing']);
      expect(presence.isRecording()).toBe(false);

      presence.stopTurn('turn-active');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'recording', 'composing', 'paused']);
    });
  });

  describe('WhatsAppGateway & /stop Emergency Cleanup', () => {
    it('clears presence immediately on /stop command', async () => {
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendMessage: vi.fn().mockResolvedValue({ key: { id: 'stop-ack' } }),
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      let stopped = false;
      const gateway = new WhatsAppGateway(
        config,
        db,
        async () => {},
        async () => {
          stopped = true;
        },
        tempDir
      );
      (gateway as any).sock = mockSocket;

      // Simulate turn active
      gateway.getPresence().startTurn('turn-before-stop');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing']);

      // Receive /stop
      await gateway.handleIncomingMessage({
        key: { remoteJid: '923001234567@s.whatsapp.net', id: 'stop-msg' },
        message: { conversation: '/stop' },
      });

      expect(stopped).toBe(true);
      expect(gateway.getPresence().getActiveTurnCount()).toBe(0);
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused']);

      await gateway.stop();
    });

    it('pauses presence refresh on socket close and stops on gateway stop', async () => {
      vi.useFakeTimers();
      const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
      const mockSocket = {
        sendMessage: vi.fn(),
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
        end: vi.fn(),
      };

      const gateway = new WhatsAppGateway(
        config,
        db,
        async () => {},
        async () => {},
        tempDir,
        { presenceOptions: { refreshIntervalMs: 5000 } }
      );
      (gateway as any).sock = mockSocket;

      gateway.getPresence().startTurn('turn-disconnect');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing']);

      // Connection closes -> pauses timer
      gateway.getPresence().pauseTimer();
      await vi.advanceTimersByTimeAsync(15000);
      // No extra composing updates emitted while paused
      expect(presenceUpdates).toHaveLength(1);

      await gateway.stop();
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused']);
    });
  });

  describe('PokeRuntime & Worker Handoff Presence Lifecycle', () => {
    let sender: WhatsAppSender;
    let compactionManager: CompactionManager;
    let runtime: PokeRuntime;
    let presenceUpdates: Array<{ type: string; toJid?: string }>;
    let presence: WhatsAppPresence;
    let mockAgentHandle: {
      dispatch: ReturnType<typeof vi.fn>;
      read: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      presenceUpdates = [];
      const mockSocket = {
        sendMessage: vi.fn().mockResolvedValue({ key: { id: 'sent-id' } }),
        sendPresenceUpdate: vi.fn().mockImplementation(async (type, toJid) => {
          presenceUpdates.push({ type, toJid });
        }),
      };

      presence = new WhatsAppPresence(
        () => mockSocket,
        () => '923001234567@s.whatsapp.net',
        { refreshIntervalMs: 8000 }
      );

      sender = new WhatsAppSender(
        () => mockSocket,
        '923001234567@s.whatsapp.net',
        db,
        {} as any,
        presence
      );
      compactionManager = new CompactionManager(db, config);

      runtime = new PokeRuntime(
        config,
        db,
        new ExaToolHandler(),
        new SupermemoryToolHandler(),
        new ComposioToolHandler(),
        new SkillRegistry(path.join(tempDir, 'skills')),
        new WorkerManager(db, config, {} as any, {} as any, {} as any, {} as any),
        new AutomationScheduler(db),
        sender,
        compactionManager,
        tempDir,
        presence
      );

      mockAgentHandle = {
        dispatch: vi.fn(),
        read: vi.fn().mockResolvedValue({ text: 'done' }),
        abort: vi.fn().mockResolvedValue(undefined),
      };
      (runtime as any).agentHandle = mockAgentHandle;
    });

    it('shows composing during foreground turn and clears it when the turn settles', async () => {
      let resolveRead: (val: any) => void;
      mockAgentHandle.read.mockImplementation(() => new Promise((resolve) => {
        resolveRead = resolve;
      }));
      mockAgentHandle.dispatch.mockResolvedValue({ submissionId: 'sub-user-1' });

      const receipt = await runtime.dispatchUserMessage('Hello Poke', [], 'msg-user-1');
      expect(receipt.submissionId).toBe('sub-user-1');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing']);
      expect(presence.getActiveTurnCount()).toBe(1);

      // Wait for submission settlement
      resolveRead!({ text: 'done' });
      await vi.waitFor(() => {
        expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused']);
      });
      expect(presence.getActiveTurnCount()).toBe(0);
    });

    it('does not keep Poke typing during background worker execution; resumes typing only when worker completion wakes main agent', async () => {
      // Step 1: User sends message -> main agent runs foreground turn
      let resolveUserTurn: (val: any) => void;
      mockAgentHandle.read.mockImplementationOnce(() => new Promise((resolve) => {
        resolveUserTurn = resolve;
      }));
      mockAgentHandle.dispatch.mockResolvedValueOnce({ submissionId: 'sub-hand-off' });

      await runtime.dispatchUserMessage('Run long worker task', [], 'msg-worker-req');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing']);
      expect(presence.getActiveTurnCount()).toBe(1);

      // Main agent foreground turn completes (hands off to background worker)
      resolveUserTurn!({ text: 'Worker job started' });
      await vi.waitFor(() => {
        expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused']);
      });

      // Step 2: While worker is running in background, active turn count is 0 (NOT typing)
      expect(presence.getActiveTurnCount()).toBe(0);
      expect(presence.getCurrentPresence()).toBe('idle');

      // Step 3: Worker completes and dispatches completion signal to main agent
      let resolveWorkerTurn: (val: any) => void;
      mockAgentHandle.read.mockImplementationOnce(() => new Promise((resolve) => {
        resolveWorkerTurn = resolve;
      }));
      mockAgentHandle.dispatch.mockResolvedValueOnce({ submissionId: 'sub-worker-comp' });

      await runtime.dispatchSignal({
        type: 'worker.completion',
        tagName: 'worker',
        attributes: { jobId: 'job-123' },
        body: 'Scraping result data...',
        idempotencyKey: 'worker-job-123',
      });

      // Main agent wakes up for foreground turn -> typing resumes
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused', 'composing']);
      expect(presence.getActiveTurnCount()).toBe(1);

      // Final completion turn settles -> typing pauses
      resolveWorkerTurn!({ text: 'Worker job finished' });
      await vi.waitFor(() => {
        expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused', 'composing', 'paused']);
      });
      expect(presence.getActiveTurnCount()).toBe(0);
    });

    it('cleans up turn presence when dispatch fails before admission', async () => {
      mockAgentHandle.dispatch.mockRejectedValue(new Error('Pre-admission error'));
      vi.spyOn(sender, 'sendDirectError').mockResolvedValue();

      await expect(
        runtime.dispatchUserMessage('Will fail', [], 'msg-fail')
      ).rejects.toThrow('Pre-admission error');

      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused']);
      expect(presence.getActiveTurnCount()).toBe(0);
    });

    it('clears all presence on runtime abortAll', async () => {
      mockAgentHandle.dispatch.mockReturnValue(new Promise(() => {})); // Never resolves

      void runtime.dispatchUserMessage('Hanging message', [], 'msg-hang');
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing']);

      await runtime.abortAll();
      expect(presenceUpdates.map((u) => u.type)).toEqual(['composing', 'paused']);
      expect(presence.getActiveTurnCount()).toBe(0);
    });
  });
});
