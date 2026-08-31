import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WhatsAppGateway } from '../../src/gateway/whatsapp.js';
import { WhatsAppSender, splitLongTextMessage } from '../../src/gateway/sender.js';
import { ConfigManager } from '../../src/config/config.js';
import { PokeDatabase } from '../../src/db/database.js';
import { DeepgramHandler } from '../../src/gateway/deepgram.js';

describe('WhatsApp Gateway & Sender', () => {
  let tempDir: string;
  let db: PokeDatabase;
  let config: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-gw-test-'));
    db = new PokeDatabase(tempDir);
    config = new ConfigManager(tempDir);
    config.setOwnerPhoneNumber('+92 300 1234567'); // Saved as 923001234567
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('splits long text messages preserving code blocks and paragraphs', () => {
    const shortText = 'Hello world';
    expect(splitLongTextMessage(shortText)).toEqual(['Hello world']);

    const longText = `Paragraph 1: ${'a'.repeat(2500)}\n\nParagraph 2: ${'b'.repeat(2500)}`;
    const chunks = splitLongTextMessage(longText, 3000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain('Paragraph 1:');
    expect(chunks[1]).toContain('Paragraph 2:');
  });

  it('never produces an empty or oversized chunk near an incomplete code-block boundary', () => {
    const text = `\`\`\`\n${'x'.repeat(95)}\n\`\`\`\n${'y'.repeat(100)}`;
    const chunks = splitLongTextMessage(text, 100);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 100)).toBe(true);
  });

  it('enforces owner-only message intake: rejects unknown senders and groups', async () => {
    let dispatchedCount = 0;
    let stoppedCount = 0;

    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {
        dispatchedCount++;
      },
      async () => {
        stoppedCount++;
      },
      tempDir
    );

    // Message from non-owner
    await gateway.handleIncomingMessage({
      key: { remoteJid: '923009999999@s.whatsapp.net', id: 'm-1' },
      message: { conversation: 'Hello stranger' },
    });
    expect(dispatchedCount).toBe(0);

    // Group message
    await gateway.handleIncomingMessage({
      key: { remoteJid: '12345-67890@g.us', id: 'm-2' },
      message: { conversation: 'Hello group' },
    });
    expect(dispatchedCount).toBe(0);

    // Status broadcast
    await gateway.handleIncomingMessage({
      key: { remoteJid: 'status@broadcast', id: 'm-3' },
      message: { conversation: 'Status update' },
    });
    expect(dispatchedCount).toBe(0);

    // Message from owner
    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-4' },
      message: { conversation: 'Hello Poke' },
    });
    expect(dispatchedCount).toBe(1);
  });

  it('handles exact /stop as emergency brake without agent dispatch', async () => {
    let dispatchedCount = 0;
    let stoppedCount = 0;

    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {
        dispatchedCount++;
      },
      async () => {
        stoppedCount++;
      },
      tempDir
    );

    // Exact /stop
    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-stop' },
      message: { conversation: '/stop' },
    });

    expect(stoppedCount).toBe(1);
    expect(dispatchedCount).toBe(0);

    // Normal messages containing the word stop are NOT intercepted
    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-normal-1' },
      message: { conversation: 'stop' },
    });
    expect(dispatchedCount).toBe(1);

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-normal-2' },
      message: { conversation: '/stop now' },
    });
    expect(dispatchedCount).toBe(2);
  });

  it('guarantees idempotent sends via WhatsAppSender', async () => {
    const mockSocket = {
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'sent-123' } }),
    };

    const sender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );

    const idempotencyKey = 'turn-1-tool-send-part-0';

    const res1 = await sender.send(
      { mode: 'message', text: 'Hello owner' },
      idempotencyKey
    );
    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);

    // Second call with same idempotency key
    const res2 = await sender.send(
      { mode: 'message', text: 'Hello owner' },
      idempotencyKey
    );
    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1); // Not called again!
    expect(res2.messageId).toBe(res1.messageId);
  });

  it('formats inbound media attachments with standardized metadata block per POKE.md §5.2', async () => {
    const { formatInboundMessageText } = await import('../../src/gateway/whatsapp.js');

    const attachments = [
      {
        path: '/home/arham/.poke/inbox/ABC123/image.jpg',
        filename: 'image.jpg',
        mimeType: 'image/jpeg',
        size: 482193,
        messageId: 'ABC123',
      },
    ];

    const result = formatInboundMessageText('Can you look at this?', attachments);
    expect(result).toContain('Can you look at this?');
    expect(result).toContain('Attachments:');
    expect(result).toContain('- /home/arham/.poke/inbox/ABC123/image.jpg');
    expect(result).toContain('mime: image/jpeg');
    expect(result).toContain('size: 482193');
    expect(result).toContain('message_id: ABC123');
  });

  it('targets Deepgram Aura-2 /v1/speak API for TTS synthesis', async () => {
    const dg = new DeepgramHandler('test-api-key', tempDir);

    let requestedUrl = '';
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: any) => {
      requestedUrl = url.toString();
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('fake-audio-data'),
      };
    });

    try {
      const res = await dg.synthesizeToAudioFile('Hello from Deepgram Aura-2');
      expect(requestedUrl).toContain('https://api.deepgram.com/v1/speak');
      expect(requestedUrl).toContain('model=aura-2-thalia-en');
      expect(requestedUrl).toContain('encoding=opus');
      expect(res.mimeType).toContain('audio/ogg');
      expect(fs.existsSync(res.audioPath)).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('matches owner messages when sent with Baileys LID and remoteJidAlt', async () => {
    let dispatched = false;
    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {
        dispatched = true;
      },
      async () => {},
      tempDir
    );

    // LID message with remoteJidAlt matching owner
    await gateway.handleIncomingMessage({
      key: {
        remoteJid: '25482348912345@lid',
        remoteJidAlt: '923001234567@s.whatsapp.net',
        id: 'm-lid-1',
      } as any,
      message: { conversation: 'Hello from LID' },
    });

    expect(dispatched).toBe(true);
  });

  it('deduplicates redelivered inbound messages using idempotency', async () => {
    let dispatchCount = 0;
    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {
        dispatchCount++;
      },
      async () => {},
      tempDir
    );

    const msg = {
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-duplicate-test' },
      message: { conversation: 'Testing idempotency' },
    };

    await gateway.handleIncomingMessage(msg);
    expect(dispatchCount).toBe(1);

    // Redelivery
    await gateway.handleIncomingMessage(msg);
    expect(dispatchCount).toBe(1);
  });

  it('prevents concurrent duplicate dispatches during in-flight processing', async () => {
    let dispatchCount = 0;
    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {
        dispatchCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      async () => {},
      tempDir
    );

    const msg = {
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-concurrent-test' },
      message: { conversation: 'Testing concurrent inbound idempotency' },
    };

    await Promise.all([
      gateway.handleIncomingMessage(msg),
      gateway.handleIncomingMessage(msg),
      gateway.handleIncomingMessage(msg),
    ]);

    expect(dispatchCount).toBe(1);
    expect(db.checkIdempotency('inbound_msg:m-concurrent-test')).not.toBeNull();
  });

  it('does not acknowledge an inbound message when dispatch admission fails', async () => {
    let shouldFail = true;
    let dispatchCount = 0;
    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {
        dispatchCount++;
        if (shouldFail) throw new Error('runtime is starting');
      },
      async () => {},
      tempDir
    );
    const msg = {
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-retry-dispatch' },
      message: { conversation: 'Retry me' },
    };

    await expect(gateway.handleIncomingMessage(msg)).rejects.toThrow('runtime is starting');
    expect(db.checkIdempotency('inbound_msg:m-retry-dispatch')).toBeNull();

    shouldFail = false;
    await gateway.handleIncomingMessage(msg);
    expect(dispatchCount).toBe(2);
    expect(db.checkIdempotency('inbound_msg:m-retry-dispatch')).not.toBeNull();
  });

  it('does not acknowledge /stop until the emergency action succeeds', async () => {
    let stopAttempts = 0;
    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {},
      async () => {
        stopAttempts++;
        if (stopAttempts === 1) throw new Error('abort failed');
      },
      tempDir
    );
    const msg = {
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-retry-stop' },
      message: { conversation: '/stop' },
    };

    await gateway.handleIncomingMessage(msg);
    expect(db.checkIdempotency('inbound_msg:m-retry-stop')).toBeNull();

    await gateway.handleIncomingMessage(msg);
    expect(stopAttempts).toBe(2);
    expect(db.checkIdempotency('inbound_msg:m-retry-stop')).not.toBeNull();
  });

  it('records stop idempotency and does not send error when confirmation notice fails', async () => {
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

    const sender = gateway.getSender();
    vi.spyOn(sender, 'sendDirectNotice').mockRejectedValue(new Error('Network disconnected'));
    const errorSpy = vi.spyOn(sender, 'sendDirectError').mockResolvedValue();

    const msg = {
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-stop-notice-fail' },
      message: { conversation: '/stop' },
    };

    await gateway.handleIncomingMessage(msg);
    expect(stopped).toBe(true);
    expect(db.checkIdempotency('inbound_msg:m-stop-notice-fail')).not.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('resets connectionState and isConnecting when start() throws', async () => {
    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {},
      async () => {},
      tempDir
    );

    // Mock resolvePokePaths or similar to throw in start
    const pathsModule = await import('../../src/config/paths.js');
    const spy = vi.spyOn(pathsModule, 'ensurePokeDirectories').mockImplementationOnce(() => {
      throw new Error('Disk error');
    });

    await expect(gateway.start()).rejects.toThrow('Disk error');
    expect(gateway.getConnectionState()).toBe('disconnected');
    expect((gateway as any).isConnecting).toBe(false);
  });

  it('persists progress before sending next WhatsApp part and does not resend completed parts on retry', async () => {
    let callCount = 0;
    const mockSocket = {
      sendMessage: vi.fn().mockImplementation(async (_jid: string, content: any) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Network error on second part');
        }
        return { key: { id: `sent-part-${callCount}` } };
      }),
    };

    const sender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );

    const idempotencyKey = 'turn-retry-multipart-send';
    const longText = `First chunk: ${'a'.repeat(3000)}\n\nSecond chunk: ${'b'.repeat(3000)}`;

    // First attempt fails at chunk 2 (callCount === 2)
    await expect(
      sender.send({ mode: 'message', text: longText }, idempotencyKey)
    ).rejects.toThrow('Network error on second part');

    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(2);
    // Part 0 is recorded in DB
    expect(db.checkIdempotency(`${idempotencyKey}:part:0`)).not.toBeNull();
    // Part 1 is not recorded in DB
    expect(db.checkIdempotency(`${idempotencyKey}:part:1`)).toBeNull();
    // Top-level key is not recorded yet
    expect(db.checkIdempotency(idempotencyKey)).toBeNull();

    // Second attempt (retry with same idempotency key) should skip part 0 and only send part 1
    const res = await sender.send({ mode: 'message', text: longText }, idempotencyKey);
    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(3); // Called once more for part 1 only!
    expect(db.checkIdempotency(`${idempotencyKey}:part:1`)).not.toBeNull();
    expect(db.checkIdempotency(idempotencyKey)).not.toBeNull();
    expect(res.messageId).toBe('sent-part-3');
  });

  it('handles rejection from reconnect timer start() without unhandled rejection and reschedules reconnect', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new WhatsAppGateway(
        config,
        db,
        async () => {},
        async () => {},
        tempDir
      );

      let startAttempts = 0;
      vi.spyOn(gateway, 'start').mockImplementation(async () => {
        startAttempts++;
        if (startAttempts === 1) {
          throw new Error('Connection refused during reconnect');
        }
      });

      // Trigger reconnect
      (gateway as any).scheduleReconnect();
      expect((gateway as any).reconnectTimer).not.toBeNull();

      // Fast-forward first reconnect timer -> start() fails
      await vi.advanceTimersByTimeAsync(3000);
      expect(startAttempts).toBe(1);
      // It should have caught the error and rescheduled another reconnect timer
      expect((gateway as any).reconnectTimer).not.toBeNull();

      // Fast-forward second reconnect timer -> start() succeeds
      await vi.advanceTimersByTimeAsync(3000);
      expect(startAttempts).toBe(2);

      await gateway.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

