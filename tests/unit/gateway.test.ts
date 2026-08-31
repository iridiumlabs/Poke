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

  it('targets Deepgram Flux /v2/speak API for TTS synthesis', async () => {
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
      const res = await dg.synthesizeToAudioFile('Hello from Deepgram Flux');
      expect(requestedUrl).toContain('https://api.deepgram.com/v2/speak');
      expect(requestedUrl).toContain('model=flux');
      expect(requestedUrl).toContain('encoding=opus');
      expect(res.mimeType).toContain('audio/ogg');
      expect(fs.existsSync(res.audioPath)).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
