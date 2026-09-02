import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WhatsAppGateway, unwrapMessageContent } from '../../src/gateway/whatsapp.js';
import { WhatsAppSender, splitLongTextMessage } from '../../src/gateway/sender.js';
import { ConfigManager } from '../../src/config/config.js';
import { PokeDatabase } from '../../src/db/database.js';
import { DeepgramHandler } from '../../src/gateway/deepgram.js';
import { GroqTranscriptionError, GroqTranscriptionHandler } from '../../src/gateway/groq.js';
import { boundedErrorDetail, compactErrorMessage } from '../../src/gateway/error-detail.js';

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

  it('redacts credentials from direct operational WhatsApp errors', async () => {
    const mockSocket = {
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'sent-error' } }),
    };
    const sender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );
    const secret = 'super-secret-token-value';

    await sender.sendDirectError(`Authorization: Bearer ${secret}`);

    expect(mockSocket.sendMessage).toHaveBeenCalledWith(
      '923001234567@s.whatsapp.net',
      { text: expect.not.stringContaining(secret) }
    );
    expect(mockSocket.sendMessage.mock.calls[0][1].text).toContain('Bearer [REDACTED]');
  });

  it('does not replay a delivery whose transport outcome is unknown', async () => {
    const mockSocket = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Connection dropped while sending')),
    };
    const sender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );

    await expect(sender.send({ mode: 'message', text: 'Never duplicate this' }, 'ambiguous-send')).rejects.toThrow(
      'Connection dropped while sending'
    );
    expect(db.getOutgoingDelivery('ambiguous-send:part:0')).toMatchObject({ status: 'pending' });

    await expect(sender.send({ mode: 'message', text: 'Never duplicate this' }, 'ambiguous-send')).rejects.toThrow(
      'outcome is unknown'
    );
    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
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

  it('marks normalized voice transcripts for the main agent', async () => {
    const { formatVoiceTranscript } = await import('../../src/gateway/whatsapp.js');

    expect(formatVoiceTranscript('  Please summarize this.  ')).toBe('[voice] Please summarize this.');
  });

  it('keeps an audio download failure visible to the main agent', async () => {
    const dispatch = vi.fn();
    const gateway = new WhatsAppGateway(
      config,
      db,
      dispatch,
      async () => {},
      tempDir,
      { downloadMedia: vi.fn().mockRejectedValue(new Error('download failed')) }
    );
    const report = vi.spyOn(gateway.getSender(), 'sendDirectError').mockResolvedValue();

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'audio-download-failed' },
      message: { audioMessage: { ptt: true, mimetype: 'audio/ogg' } },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      isVoice: true,
      text: expect.stringContaining('[voice media download failed]'),
    }));
    expect(report).toHaveBeenCalledWith(expect.stringContaining('download failed'));
    expect(db.getLastOperationalError()).toMatchObject({
      source: 'whatsapp_media',
      message: expect.stringContaining('audio-download-failed'),
      details: expect.stringContaining('"stage":"download"'),
    });
  });

  it('prefixes a successfully transcribed voice note before dispatching it', async () => {
    const dispatch = vi.fn();
    const groqMock = {
      transcribe: vi.fn().mockResolvedValue({ text: 'Please summarize this.' }),
    };
    const gateway = new WhatsAppGateway(
      config,
      db,
      dispatch,
      async () => {},
      tempDir,
      {
        downloadMedia: vi.fn().mockResolvedValue(Buffer.from('audio')),
        groq: groqMock as any,
      }
    );

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'voice-transcribed' },
      message: { audioMessage: { ptt: true, mimetype: 'audio/ogg' } },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      isVoice: true,
      text: expect.stringContaining('[voice] Please summarize this.'),
    }));
  });

  it('preserves quoted message ID and preview when transcribing a quoted voice note', async () => {
    const dispatch = vi.fn();
    const groqMock = {
      transcribe: vi.fn().mockResolvedValue({ text: 'Please summarize this.' }),
    };
    const gateway = new WhatsAppGateway(
      config,
      db,
      dispatch,
      async () => {},
      tempDir,
      {
        downloadMedia: vi.fn().mockResolvedValue(Buffer.from('audio')),
        groq: groqMock as any,
      }
    );

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'quoted-voice-transcribed' },
      message: {
        audioMessage: {
          ptt: true,
          mimetype: 'audio/ogg',
          contextInfo: {
            stanzaId: 'original-msg-123',
            quotedMessage: {
              conversation: 'Here is the original text to summarize.',
            },
          },
        },
      },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      isVoice: true,
      text: expect.stringContaining('[Replying to message ID: original-msg-123 "Here is the original text to summarize."]\n\n[voice] Please summarize this.'),
    }));
  });

  it('sends Urdu and mixed Urdu-English voice notes to Groq Whisper Large V3 without pinning a language', async () => {
    const groq = new GroqTranscriptionHandler('test-api-key', tempDir);
    const originalFetch = global.fetch;
    let requestedUrl = '';
    let requestHeaders: RequestInit['headers'];
    let requestForm: FormData | undefined;
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      requestHeaders = init?.headers;
      requestForm = init?.body as FormData;
      return new Response(JSON.stringify({
        text: 'یہ task complete کر دو پھر report send کر دینا',
        language: 'ur',
        x_groq: { id: 'groq-request-1' },
      }), { status: 200 });
    });

    try {
      await expect(
        groq.transcribe(Buffer.from('whatsapp-ogg-opus'), 'audio/ogg; codecs=opus')
      ).resolves.toEqual({
        text: 'یہ task complete کر دو پھر report send کر دینا',
        detectedLanguage: 'ur',
        requestId: 'groq-request-1',
      });

      const url = new URL(requestedUrl);
      expect(url.origin + url.pathname).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(requestForm?.get('model')).toBe('whisper-large-v3');
      expect(requestForm?.get('response_format')).toBe('verbose_json');
      expect(requestForm?.getAll('timestamp_granularities[]')).toEqual(['segment']);
      expect(requestForm?.get('language')).toBeNull();
      const file = requestForm?.get('file') as Blob & { name?: string };
      expect(file.name).toBe('audio.ogg');
      expect(file.type).toBe('audio/ogg; codecs=opus');
      expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('whatsapp-ogg-opus');
      expect((requestHeaders as Record<string, string>)?.Authorization).toBe('Bearer test-api-key');
      expect((requestHeaders as Record<string, string>)?.['Content-Type']).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('retains Groq diagnostics after a permanent transcription failure', async () => {
    const groq = new GroqTranscriptionHandler('test-api-key', tempDir);
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ error: { message: 'Unsupported audio container' } }),
      { status: 415, headers: { 'x-request-id': 'groq-request-123' } }
    ));

    try {
      await expect(groq.transcribe(Buffer.from('bad-audio'), 'audio/unknown')).rejects.toMatchObject({
        name: 'GroqTranscriptionError',
        provider: 'groq',
        model: 'whisper-large-v3',
        attempts: 1,
        status: 415,
        requestId: 'groq-request-123',
        message: expect.stringContaining('Unsupported audio container'),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('withholds a Whisper transcript when Groq reports a documented low-confidence segment', async () => {
    const dispatch = vi.fn();
    const groqMock = {
      transcribe: vi.fn().mockResolvedValue({
        text: 'This text must not become agent context.',
        requestId: 'groq-low-confidence-1',
        detectedLanguage: 'ur',
        quality: {
          requiresVerification: true,
          segmentCount: 2,
          affectedSegmentCount: 1,
          reasons: ['low_log_probability'],
        },
      }),
    };
    const gateway = new WhatsAppGateway(
      config,
      db,
      dispatch,
      async () => {},
      tempDir,
      {
        downloadMedia: vi.fn().mockResolvedValue(Buffer.from('unclear-audio')),
        groq: groqMock as any,
      }
    );
    const report = vi.spyOn(gateway.getSender(), 'sendDirectError').mockResolvedValue();

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'voice-low-confidence' },
      message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      isVoice: true,
      text: expect.stringContaining('[voice transcription low confidence]'),
    }));
    expect(dispatch.mock.calls[0][0].text).not.toContain('This text must not become agent context.');
    expect(report).toHaveBeenCalledWith(expect.stringContaining('low_log_probability'));
    expect(db.getLastOperationalError()).toMatchObject({
      source: 'whatsapp_media',
      details: expect.stringContaining('"stage":"transcription_low_confidence"'),
    });
  });

  it('derives a low-confidence signal from Groq verbose Whisper metadata', async () => {
    const groq = new GroqTranscriptionHandler('test-api-key', tempDir);
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: 'uncertain transcript',
      segments: [
        { avg_logprob: -1.2, compression_ratio: 1.1, no_speech_prob: 0.2 },
        { avg_logprob: -0.1, compression_ratio: 1.1, no_speech_prob: 0.01 },
      ],
    }), { status: 200 }));

    try {
      await expect(groq.transcribe(Buffer.from('unclear-audio'))).resolves.toMatchObject({
        text: 'uncertain transcript',
        quality: {
          requiresVerification: true,
          segmentCount: 2,
          affectedSegmentCount: 1,
          reasons: ['low_log_probability'],
        },
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps a failed transcript explicit without corrupting a neighboring successful voice note', async () => {
    const dispatch = vi.fn();
    const failure = new GroqTranscriptionError(
      'Groq whisper-large-v3 transcription failed after 3 attempts: Groq STT returned 429: Too many requests',
      {
        model: 'whisper-large-v3',
        attempts: 3,
        status: 429,
        requestId: 'groq-rate-limit-1',
        cause: new Error('Too many requests'),
      }
    );
    const groqMock = {
      transcribe: vi.fn(async (audio: Buffer) => {
        if (audio.toString() === 'failed-audio') throw failure;
        return { text: 'یہ successful task ہے' };
      }),
    };
    const gateway = new WhatsAppGateway(
      config,
      db,
      dispatch,
      async () => {},
      tempDir,
      {
        downloadMedia: vi.fn((message: any) =>
          Promise.resolve(Buffer.from(message.key.id === 'voice-failed' ? 'failed-audio' : 'successful-audio'))
        ),
        groq: groqMock as any,
      }
    );
    const report = vi.spyOn(gateway.getSender(), 'sendDirectError').mockResolvedValue();

    await Promise.all([
      gateway.handleIncomingMessage({
        key: { remoteJid: '923001234567@s.whatsapp.net', id: 'voice-failed' },
        message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
      }),
      gateway.handleIncomingMessage({
        key: { remoteJid: '923001234567@s.whatsapp.net', id: 'voice-succeeded' },
        message: { audioMessage: { ptt: false, mimetype: 'audio/ogg; codecs=opus' } },
      }),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map(([message]) => message.messageId)).toEqual(['voice-failed', 'voice-succeeded']);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      isVoice: true,
      text: expect.stringContaining('[voice transcription failed]'),
    });
    expect(dispatch.mock.calls[0][0].text).toContain('Do not infer what it said.');
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      isVoice: true,
      text: expect.stringContaining('[voice] یہ successful task ہے'),
    });
    expect(dispatch.mock.calls[1][0].text).not.toContain('[voice transcription failed]');
    expect(fs.readFileSync(path.join(tempDir, 'inbox', 'voice-failed', 'audio.ogg'), 'utf8')).toBe('failed-audio');
    expect(fs.readFileSync(path.join(tempDir, 'inbox', 'voice-succeeded', 'audio.ogg'), 'utf8')).toBe('successful-audio');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('429'));
    expect(report).toHaveBeenCalledWith(expect.stringContaining('after 3 attempts'));
    expect(db.getLastOperationalError()).toMatchObject({
      source: 'whatsapp_media',
      message: expect.stringContaining('voice-failed'),
      details: expect.stringContaining('"requestId":"groq-rate-limit-1"'),
    });
  });

  it('admits nine rapid voice notes and a following instruction in receipt order even when STT finishes out of order', async () => {
    const dispatch = vi.fn();
    const resolvers = new Map<string, (transcription: { text: string }) => void>();
    const groqMock = {
      transcribe: vi.fn((audio: Buffer) => new Promise<{ text: string }>((resolve) => {
        resolvers.set(audio.toString(), resolve);
      })),
    };
    const gateway = new WhatsAppGateway(
      config,
      db,
      dispatch,
      async () => {},
      tempDir,
      {
        downloadMedia: vi.fn((message: any) => Promise.resolve(Buffer.from(message.key.id))),
        groq: groqMock as any,
      }
    );

    const voiceIds = Array.from({ length: 9 }, (_, index) => `voice-${index + 1}`);
    const voices = voiceIds.map((id) => gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id },
      message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
    }));
    const instruction = gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'task-list' },
      message: { conversation: 'Use everything above to create a task list.' },
    });

    await vi.waitFor(() => expect(groqMock.transcribe).toHaveBeenCalledTimes(9));
    for (const id of [...voiceIds].reverse().slice(0, -1)) {
      resolvers.get(id)!({ text: `transcript for ${id}` });
    }
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();

    resolvers.get(voiceIds[0])!({ text: `transcript for ${voiceIds[0]}` });
    await Promise.all([...voices, instruction]);

    expect(dispatch.mock.calls.map(([message]) => message.messageId)).toEqual([...voiceIds, 'task-list']);
    for (const [index, id] of voiceIds.entries()) {
      expect(dispatch.mock.calls[index][0].text).toContain(`[voice] transcript for ${id}`);
      expect(fs.readFileSync(path.join(tempDir, 'inbox', id, 'audio.ogg'), 'utf8')).toBe(id);
    }
    expect(dispatch.mock.calls.at(-1)?.[0].text).toContain('Use everything above to create a task list.');
  });

  it('targets Deepgram Flux /v2/speak API for WhatsApp-compatible TTS synthesis', async () => {
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
      expect(requestedUrl).toContain('model=flux-alexis-en');
      expect(requestedUrl).toContain('encoding=opus');
      expect(requestedUrl).toContain('container=ogg');
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

  it('unwraps inbound ephemeral and view-once messages properly', async () => {
    let dispatchedText = '';
    const gateway = new WhatsAppGateway(
      config,
      db,
      async (msg) => {
        dispatchedText = msg.text;
      },
      async () => {},
      tempDir
    );

    // Ephemeral message containing text
    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-ephemeral-1' },
      message: {
        ephemeralMessage: {
          message: {
            conversation: 'Secret message from ephemeral chat',
          },
        },
      } as any,
    });

    expect(dispatchedText).toBe('Secret message from ephemeral chat');

    // View-once message containing text
    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-viewonce-1' },
      message: {
        viewOnceMessage: {
          message: {
            extendedTextMessage: {
              text: 'View once text content',
            },
          },
        },
      } as any,
    });

    expect(dispatchedText).toBe('View once text content');
  });

  it('uses Baileys normalization for document-with-caption wrappers', () => {
    const content = unwrapMessageContent({
      documentWithCaptionMessage: {
        message: {
          documentMessage: {
            fileName: 'brief.pdf',
            caption: 'Please summarize this document.',
          },
        },
      },
    } as any);

    expect(content?.documentMessage?.fileName).toBe('brief.pdf');
    expect(content?.documentMessage?.caption).toBe('Please summarize this document.');
  });

  it('extracts quoted/replied-to message context into inbound text', async () => {
    let dispatchedText = '';
    const gateway = new WhatsAppGateway(
      config,
      db,
      async (msg) => {
        dispatchedText = msg.text;
      },
      async () => {},
      tempDir
    );

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-reply-1' },
      message: {
        extendedTextMessage: {
          text: 'What does this mean?',
          contextInfo: {
            stanzaId: 'original-msg-999',
            quotedMessage: {
              conversation: 'Server CPU load at 98%',
            },
          },
        },
      } as any,
    });

    expect(dispatchedText).toContain('[Replying to message ID: original-msg-999 "Server CPU load at 98%"]');
    expect(dispatchedText).toContain('What does this mean?');
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

  it('persists completed parts and refuses to replay an ambiguous later part', async () => {
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

    expect(db.getOutgoingDelivery(`${idempotencyKey}:part:1`)).toMatchObject({ status: 'pending' });

    await expect(sender.send({ mode: 'message', text: longText }, idempotencyKey)).rejects.toThrow(
      'outcome is unknown'
    );
    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(2);
    expect(db.checkIdempotency(idempotencyKey)).toBeNull();
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

  it('sends attachments alongside voice notes in voice mode', async () => {
    const sentMessages: any[] = [];
    const mockSocket = {
      sendMessage: vi.fn().mockImplementation(async (_jid: string, content: any) => {
        sentMessages.push(content);
        return { key: { id: `sent-msg-${sentMessages.length}` } };
      }),
    };

    const dummyAttachmentPath = path.join(tempDir, 'sample.jpg');
    fs.writeFileSync(dummyAttachmentPath, 'fake-image-bytes');

    const fakeAudioPath = path.join(tempDir, 'voice.ogg');
    fs.writeFileSync(fakeAudioPath, 'fake-audio-bytes');

    const fakeDeepgram = {
      synthesizeToAudioFile: vi.fn().mockResolvedValue({
        audioPath: fakeAudioPath,
        mimeType: 'audio/ogg; codecs=opus',
      }),
    } as unknown as DeepgramHandler;

    const sender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      fakeDeepgram
    );

    const res = await sender.send({
      mode: 'voice',
      text: 'Voice note with image',
      attachments: [{ path: dummyAttachmentPath, filename: 'sample.jpg', mimeType: 'image/jpeg' }],
    });

    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(2);
    expect(sentMessages[0].audio).toBeDefined();
    expect(sentMessages[1].image).toBeDefined();
    expect(res.mode).toBe('voice');
  });

  it('sends attachments without sending an empty text message when text is empty', async () => {
    const sentMessages: any[] = [];
    const mockSocket = {
      sendMessage: vi.fn().mockImplementation(async (_jid: string, content: any) => {
        sentMessages.push(content);
        return { key: { id: `sent-msg-${sentMessages.length}` } };
      }),
    };

    const dummyAttachmentPath = path.join(tempDir, 'photo.jpg');
    fs.writeFileSync(dummyAttachmentPath, 'fake-photo-bytes');

    const sender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );

    const res = await sender.send({
      mode: 'message',
      text: '',
      attachments: [{ path: dummyAttachmentPath, filename: 'photo.jpg', mimeType: 'image/jpeg' }],
    });

    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentMessages[0].image).toBeDefined();
    expect(sentMessages[0].text).toBeUndefined();
    expect(res.mode).toBe('message');
  });

  it('uses the real inbound envelope for an attachment-only reply', async () => {
    const mockSocket = {
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'attachment-reply' } }),
    };
    const attachmentPath = path.join(tempDir, 'reply.jpg');
    fs.writeFileSync(attachmentPath, 'fake-photo-bytes');
    const sender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );
    const inbound = {
      key: {
        remoteJid: '923001234567@s.whatsapp.net',
        id: 'source-message-id',
        fromMe: false,
      },
      message: { imageMessage: { caption: 'The original image caption' } },
    } as any;
    sender.registerReplyTarget(inbound);

    await sender.send({
      mode: 'message',
      text: '',
      attachments: [{ path: attachmentPath, filename: 'reply.jpg', mimeType: 'image/jpeg' }],
      reply_to: 'source-message-id',
    });

    expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockSocket.sendMessage.mock.calls[0][2]).toEqual({ quoted: inbound });
  });

  it('restores a quoted inbound envelope after the sender is recreated', async () => {
    const mockSocket = {
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'recovered-reply' } }),
    };
    const firstSender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );
    firstSender.registerReplyTarget({
      key: {
        remoteJid: '923001234567@s.whatsapp.net',
        id: 'durable-source-message',
        fromMe: false,
      },
      message: { conversation: 'Persist this quoted message.' },
    } as any);

    const recoveredSender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );
    await recoveredSender.send({
      mode: 'message',
      text: 'A recovered answer',
      reply_to: 'durable-source-message',
    });

    expect(mockSocket.sendMessage.mock.calls[0][2]?.quoted?.message?.conversation).toBe(
      'Persist this quoted message.'
    );
  });

  it('rejects reuse of a part idempotency key with altered content', async () => {
    let callCount = 0;
    const mockSocket = {
      sendMessage: vi.fn().mockImplementation(async () => {
        callCount++;
        return { key: { id: `sent-part-${callCount}` } };
      }),
    };

    const sender = new WhatsAppSender(
      () => mockSocket,
      '923001234567@s.whatsapp.net',
      db,
      new DeepgramHandler(undefined, tempDir)
    );

    const idempotencyKey = 'part-hash-mismatch-test';

    // Pre-record a part with a different payload hash
    db.recordIdempotency(
      `${idempotencyKey}:part:0`,
      'whatsapp_send_part',
      'old-payload-hash-different-content',
      JSON.stringify({ messageId: 'old-cached-id' })
    );

    await expect(sender.send({ mode: 'message', text: 'Brand new text content' }, idempotencyKey)).rejects.toThrow(
      'different content'
    );
    expect(mockSocket.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects retrying a failed multipart send when the top-level payload was modified', async () => {
    let callCount = 0;
    const mockSocket = {
      sendMessage: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Network failure on part 1');
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

    const idempotencyKey = 'retry-top-level-mismatch-test';
    const initialText = `First chunk: ${'a'.repeat(3000)}\n\nSecond chunk: ${'b'.repeat(3000)}`;

    // First attempt fails at chunk 2
    await expect(
      sender.send({ mode: 'message', text: initialText }, idempotencyKey)
    ).rejects.toThrow('Network failure on part 1');

    expect(callCount).toBe(2);

    // Second attempt with DIFFERENT text under same idempotency key must reject
    const modifiedText = `First chunk: ${'a'.repeat(3000)}\n\nDifferent chunk: ${'c'.repeat(3000)}`;
    await expect(
      sender.send({ mode: 'message', text: modifiedText }, idempotencyKey)
    ).rejects.toThrow('different content');

    // No additional message should be sent
    expect(callCount).toBe(2);
  });

  it('bounds, sanitizes, and redacts error details in shared error-detail helper', () => {
    const raw = 'Bearer super-secret-key-value \u0000 with   lots   of \r\n whitespace\t';
    const cleaned = boundedErrorDetail(raw);
    expect(cleaned).not.toContain('super-secret-key-value');
    expect(cleaned).toContain('Bearer [REDACTED]');
    expect(cleaned).toBe('Bearer [REDACTED] with lots of whitespace');

    const longError = 'x'.repeat(700);
    const bounded = boundedErrorDetail(longError);
    expect(bounded.length).toBe(600);
    expect(bounded.endsWith('...')).toBe(true);

    expect(compactErrorMessage(new Error('something failed'))).toBe('something failed');
    expect(compactErrorMessage('')).toBe('Unknown error.');
    expect(compactErrorMessage(null)).toBe('Unknown error.');
    expect(compactErrorMessage(undefined)).toBe('Unknown error.');
  });

  it('records idempotency without dispatch when incoming media preparation intentionally returns null', async () => {
    let dispatched = false;
    const gateway = new WhatsAppGateway(
      config,
      db,
      async () => {
        dispatched = true;
      },
      async () => {},
      tempDir,
      {
        downloadMedia: vi.fn().mockRejectedValue(new Error('Image download failed')),
      }
    );

    const messageId = 'm-failed-image-no-caption';
    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: messageId },
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          caption: '',
        },
      },
    });

    expect(dispatched).toBe(false);
    expect(db.checkIdempotency(`inbound_msg:${messageId}`)).not.toBeNull();
  });

  it('does not record idempotency when inbound message preparation throws an unhandled rejection', async () => {
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

    // Force prepareIncomingMessage to throw directly
    vi.spyOn(gateway as any, 'prepareIncomingMessage').mockRejectedValue(new Error('Fatal preparation crash'));

    const messageId = 'm-fatal-prep-crash';
    await expect(
      gateway.handleIncomingMessage({
        key: { remoteJid: '923001234567@s.whatsapp.net', id: messageId },
        message: { conversation: 'Hello' },
      })
    ).rejects.toThrow('Fatal preparation crash');

    expect(dispatched).toBe(false);
    expect(db.checkIdempotency(`inbound_msg:${messageId}`)).toBeNull();
  });
});

