import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent,
  proto,
  WAMessage,
} from '@whiskeysockets/baileys';
import { ConfigManager, normalizePhoneNumber } from '../config/config.js';
import { PokeDatabase } from '../db/database.js';
import { DeepgramHandler } from './deepgram.js';
import {
  GROQ_STT_MODEL,
  GroqTranscriptionError,
  GroqTranscriptionHandler,
} from './groq.js';
import { WhatsAppSender } from './sender.js';
import { WhatsAppPresence, WhatsAppPresenceOptions } from './presence.js';
import { getLogger } from '../logger/logger.js';
import { resolvePokePaths, ensurePokeDirectories } from '../config/paths.js';
import { writeGatewayRuntimeStatus } from './runtime-status.js';
import { compactErrorMessage } from './error-detail.js';
export interface InboundMediaAttachment {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  messageId: string;
  caption?: string;
  isImage?: boolean;
}

export interface NormalizedInboundMessage {
  messageId: string;
  from: string;
  text: string;
  isVoice: boolean;
  attachments: InboundMediaAttachment[];
  rawMessage: proto.IWebMessageInfo;
}

export function formatInboundMessageText(
  text: string,
  attachments: InboundMediaAttachment[]
): string {
  if (attachments.length === 0) {
    return text;
  }

  const lines: string[] = [];
  const cleanText = text.trim();
  if (cleanText) {
    lines.push(cleanText);
    lines.push('');
  }

  lines.push('Attachments:');
  for (const att of attachments) {
    lines.push(`- ${att.path}`);
    lines.push(`  mime: ${att.mimeType}`);
    lines.push(`  size: ${att.size}`);
    lines.push(`  message_id: ${att.messageId}`);
    if (att.filename && att.filename !== path.basename(att.path)) {
      lines.push(`  filename: ${att.filename}`);
    }
  }

  return lines.join('\n');
}

export function formatVoiceTranscript(transcript: string): string {
  return `[voice] ${transcript.trim()}`;
}

export function formatVoiceTranscriptionFailure(): string {
  return '[voice transcription failed]\nPoke has no reliable transcript for this message. Do not infer what it said. Ask the user to resend it or provide text before relying on it.';
}

export function formatVoiceLowConfidenceTranscript(): string {
  return '[voice transcription low confidence]\nPoke deliberately omitted this unreliable transcript. Do not infer what it said. Ask the user to resend it or provide text before relying on it.';
}

export function formatVoiceDownloadFailure(): string {
  return '[voice media download failed]\nPoke has no usable audio or transcript for this message. Do not infer what it said. Ask the user to resend it or provide text before relying on it.';
}

function audioExtension(mimeType: string, isPtt: boolean): string {
  const mediaType = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'audio/ogg') return 'ogg';
  if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3') return 'mp3';
  if (mediaType === 'audio/mp4' || mediaType === 'audio/m4a') return 'm4a';
  if (mediaType === 'audio/aac') return 'aac';
  if (mediaType === 'audio/wav' || mediaType === 'audio/x-wav') return 'wav';
  if (mediaType === 'audio/webm') return 'webm';
  return isPtt ? 'ogg' : 'bin';
}


function transcriptionFailureNotice(messageId: string, error: unknown): string {
  return `Poke could not transcribe voice message ${messageId}. ${compactErrorMessage(error)} Please send it again.`;
}

function appendVoiceFailure(text: string, replyPrefix: string, failure: string): string {
  const caption = text.startsWith(replyPrefix) ? text.slice(replyPrefix.length).trim() : text.trim();
  return `${replyPrefix}${caption ? `${caption}\n\n` : ''}${failure}`;
}

function normalizeQuotedPreview(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 2000 ? `${normalized.slice(0, 1997)}...` : normalized;
}

export function unwrapMessageContent(
  msg: proto.IMessage | null | undefined
): proto.IMessage | undefined {
  return normalizeMessageContent(msg) || undefined;
}

export type MessageDispatchFn = (msg: NormalizedInboundMessage) => Promise<void>;
export type StopHandlerFn = () => Promise<void>;
export type CompactHandlerFn = () => Promise<{
  success: boolean;
  busy?: boolean;
  beforeTokens?: number;
  afterTokens?: number;
  error?: string;
}>;
export type StatusHandlerFn = () => Promise<string>;

export interface WhatsAppGatewayDependencies {
  downloadMedia?: (message: WAMessage) => Promise<Buffer>;
  deepgram?: DeepgramHandler;
  groq?: GroqTranscriptionHandler;
  presence?: WhatsAppPresence;
  presenceOptions?: WhatsAppPresenceOptions;
  onCompact?: CompactHandlerFn;
  onStatus?: StatusHandlerFn;
}

export class WhatsAppGateway {
  private sock: any = null;
  private isConnecting = false;
  private qrCode: string | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private inFlightInbound = new Set<string>();
  // Media downloads and transcription may complete in any order. Admission to
  // the one owner conversation must retain WhatsApp receipt order instead.
  private inboundAdmissionTail: Promise<void> = Promise.resolve();
  private sender: WhatsAppSender;
  private presence: WhatsAppPresence;
  private deepgram: DeepgramHandler;
  private groq: GroqTranscriptionHandler;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isStopped = false;
  private lastConnectedAt: number | undefined;
  private pairedAccount: string | undefined;
  private readonly downloadMedia: (message: WAMessage) => Promise<Buffer>;
  private readonly onCompact?: CompactHandlerFn;
  private readonly onStatus?: StatusHandlerFn;

  constructor(
    private configManager: ConfigManager,
    private db: PokeDatabase,
    private onDispatch: MessageDispatchFn,
    private onStop: StopHandlerFn,
    private customHome?: string,
    dependencies: WhatsAppGatewayDependencies = {}
  ) {
    this.onCompact = dependencies.onCompact;
    this.onStatus = dependencies.onStatus;
    this.downloadMedia = dependencies.downloadMedia || (async (message) =>
      (await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
          logger: getLogger().child({ module: 'baileys-media' }) as any,
          reuploadRequest: (msg: WAMessage) => this.sock?.updateMediaMessage(msg),
        }
      )) as Buffer
    );
    const creds = this.configManager.getCredentials();
    this.deepgram = dependencies.deepgram || new DeepgramHandler(creds.deepgramApiKey, customHome);
    this.groq = dependencies.groq || new GroqTranscriptionHandler(creds.groqApiKey, customHome);
    const ownerPhone = this.configManager.getOwnerPhoneNumber() || '';
    const ownerJid = ownerPhone ? `${ownerPhone}@s.whatsapp.net` : '';
    this.presence = dependencies.presence || new WhatsAppPresence(
      () => this.sock,
      () => this.sender ? this.sender.getOwnerJid() : ownerJid,
      dependencies.presenceOptions
    );
    this.sender = new WhatsAppSender(
      () => this.sock,
      ownerJid,
      this.db,
      this.deepgram,
      this.presence
    );
  }

  getPresence(): WhatsAppPresence {
    return this.presence;
  }

  getSender(): WhatsAppSender {
    return this.sender;
  }

  getConnectionState(): 'disconnected' | 'connecting' | 'connected' {
    return this.connectionState;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  heartbeat(): void {
    this.writeRuntimeStatus();
  }

  async start(): Promise<void> {
    if (this.sock || this.isConnecting) return;
    this.isStopped = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isConnecting = true;
    this.connectionState = 'connecting';
    this.writeRuntimeStatus();

    const logger = getLogger();
    logger.info('Initializing WhatsApp Baileys gateway');

    try {
      const paths = resolvePokePaths(this.customHome);
      ensurePokeDirectories(paths);

      const { state, saveCreds } = await useMultiFileAuthState(paths.whatsappDir);
      const { version } = await fetchLatestBaileysVersion();

      if (this.isStopped) {
        this.isConnecting = false;
        this.connectionState = 'disconnected';
        this.writeRuntimeStatus('Daemon stopped before gateway initialization completed.');
        return;
      }

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: logger.child({ module: 'baileys' }) as any,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          this.qrCode = qr;
          logger.info('WhatsApp QR code generated');
        }

        if (connection === 'close') {
          this.presence.pauseTimer();
          this.connectionState = 'disconnected';
          this.sock = null;
          this.isConnecting = false;
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          this.writeRuntimeStatus(statusCode ? `Connection closed (${statusCode}).` : 'Connection closed.');
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          logger.warn({ statusCode, shouldReconnect }, 'WhatsApp connection closed');
          if (shouldReconnect && !this.isStopped) {
            this.scheduleReconnect();
          }
        } else if (connection === 'open') {
          this.connectionState = 'connected';
          this.qrCode = null;
          this.isConnecting = false;
          this.lastConnectedAt = Date.now();
          const rawAccount = this.sock?.user?.id || '';
          this.pairedAccount = rawAccount
            ? normalizePhoneNumber(rawAccount.replace(/@.*$/, '').split(':')[0])
            : undefined;
          this.writeRuntimeStatus();
          logger.info('WhatsApp connected successfully');

          const ownerPhone = this.configManager.getOwnerPhoneNumber();
          if (ownerPhone) {
            this.sender.setOwnerJid(`${ownerPhone}@s.whatsapp.net`);
          }
          this.presence.resumeTimerIfNeeded();
        }
      });

      this.sock.ev.on('messages.upsert', (m: any) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.message || msg.key?.fromMe) continue;
          void this.handleIncomingMessage(msg).catch((err: any) => {
            logger.error(
              { messageId: msg.key?.id, err: err?.message || String(err) },
              'Failed to process incoming WhatsApp message'
            );
          });
        }
      });
    } catch (err: any) {
      this.isConnecting = false;
      this.connectionState = 'disconnected';
      this.writeRuntimeStatus('Gateway initialization failed.');
      logger.error({ err: err?.message || String(err) }, 'Failed to initialize WhatsApp gateway');
      throw err;
    }
  }

  async handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    const logger = getLogger(this.customHome);
    const remoteJid = msg.key?.remoteJid || '';
    const messageId = msg.key?.id || `msg-${randomUUID()}`;

    // Ignore status broadcasts and groups
    if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) {
      return;
    }

    // Owner check supporting LIDBaileys phone-JID alternative
    const ownerNumber = this.configManager.getOwnerPhoneNumber();
    const rawCandidates = [
      remoteJid,
      (msg.key as any)?.remoteJidAlt,
      msg.key?.participant,
      (msg.key as any)?.participantAlt,
    ].filter(Boolean) as string[];

    const matchedJid = rawCandidates.find((jid) => {
      const num = normalizePhoneNumber(jid.replace(/@.*$/, ''));
      return num === ownerNumber;
    });

    if (!ownerNumber || !matchedJid) {
      logger.warn({ messageId }, 'Ignoring message from non-owner');
      return;
    }

    // Keep the original envelope. Baileys uses it to serialize a valid
    // quoted reply, including the real quotedMessage payload.
    this.sender.registerReplyTarget(msg as WAMessage);

    const senderNumber = normalizePhoneNumber(matchedJid.replace(/@.*$/, ''));
    const idempotencyKey = `inbound_msg:${messageId}`;

    if (this.inFlightInbound.has(idempotencyKey) || (this.db.isOpen() && this.db.checkIdempotency(idempotencyKey))) {
      logger.info({ messageId }, 'Ignoring duplicate inbound message');
      return;
    }

    this.inFlightInbound.add(idempotencyKey);

    logger.info({ messageId }, 'Received WhatsApp message from owner');

    // Extract text and attachments (unwrapping ephemeral / view-once wrappers)
    const msgContent = unwrapMessageContent(msg.message) || {};

    let text =
      msgContent.conversation ||
      msgContent.extendedTextMessage?.text ||
      msgContent.imageMessage?.caption ||
      msgContent.videoMessage?.caption ||
      msgContent.documentMessage?.caption ||
      '';

    const trimmedText = text.trim();

    // Check exact /stop command - only triggers on pure text messages with no media
    const isPureTextMessage =
      (Boolean(msgContent.conversation) || Boolean(msgContent.extendedTextMessage)) &&
      !msgContent.imageMessage &&
      !msgContent.videoMessage &&
      !msgContent.documentMessage &&
      !msgContent.audioMessage;

    if (isPureTextMessage && trimmedText === '/stop') {
      logger.info({ messageId }, 'Received exact /stop command. Triggering emergency brake.');
      this.presence.clear();
      let stopSucceeded = false;
      try {
        await this.onStop();
        if (this.db.isOpen()) {
          this.db.recordIdempotency(idempotencyKey, 'whatsapp_inbound', messageId);
        }
        stopSucceeded = true;
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed during /stop handling');
        try {
          await this.sender.sendDirectError('Unable to stop active work. Please try /stop again.');
        } catch (sendErr: any) {
          logger.error({ err: sendErr.message }, 'Failed to send stop failure notice');
        }
      } finally {
        this.inFlightInbound.delete(idempotencyKey);
      }

      if (stopSucceeded) {
        try {
          await this.sender.sendDirectNotice('Stopped.');
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to send stop confirmation notice');
        }
      }
      return;
    }

    if (isPureTextMessage && trimmedText === '/compact') {
      logger.info({ messageId }, 'Received exact /compact command.');
      let noticeToSend: { type: 'notice' | 'error'; text: string } | null = null;
      try {
        if (this.onCompact) {
          const res = await this.onCompact();
          if (res.busy) {
            noticeToSend = {
              type: 'notice',
              text: 'Main agent is busy with an active turn. Please try /compact again once it finishes.',
            };
          } else if (res.success) {
            const beforeStr = res.beforeTokens !== undefined ? `~${res.beforeTokens.toLocaleString()}` : 'unknown';
            const afterStr = res.afterTokens !== undefined ? `~${res.afterTokens.toLocaleString()}` : 'unknown';
            noticeToSend = {
              type: 'notice',
              text: `Compacted.\nContext: ${beforeStr} → ${afterStr} tokens`,
            };
          } else {
            noticeToSend = {
              type: 'error',
              text: `Compaction failed: ${res.error || 'Unknown error'}`,
            };
          }
        } else {
          noticeToSend = {
            type: 'error',
            text: 'Compaction handler not configured.',
          };
        }
        if (this.db.isOpen()) {
          this.db.recordIdempotency(idempotencyKey, 'whatsapp_inbound', messageId);
        }
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed during /compact handling');
        noticeToSend = {
          type: 'error',
          text: `Compaction failed: ${err?.message || String(err)}`,
        };
      } finally {
        this.inFlightInbound.delete(idempotencyKey);
      }

      if (noticeToSend) {
        try {
          if (noticeToSend.type === 'error') {
            await this.sender.sendDirectError(noticeToSend.text);
          } else {
            await this.sender.sendDirectNotice(noticeToSend.text);
          }
        } catch (sendErr: any) {
          logger.error({ err: sendErr?.message }, 'Failed to send compaction notice/error');
        }
      }
      return;
    }

    if (isPureTextMessage && trimmedText === '/status') {
      logger.info({ messageId }, 'Received exact /status command.');
      let statusText: string | null = null;
      try {
        if (this.onStatus) {
          statusText = await this.onStatus();
        } else {
          statusText = 'Status handler not configured.';
        }
        if (this.db.isOpen()) {
          this.db.recordIdempotency(idempotencyKey, 'whatsapp_inbound', messageId);
        }
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Failed during /status handling');
        statusText = `Failed to get status: ${err?.message || String(err)}`;
      } finally {
        this.inFlightInbound.delete(idempotencyKey);
      }

      if (statusText) {
        try {
          await this.sender.sendDirectNotice(statusText);
        } catch (sendErr: any) {
          logger.error({ err: sendErr?.message }, 'Failed to send status notice');
        }
      }
      return;
    }

    // Extract quoted context from contextInfo if present
    const messageVariantWithContext = Object.values(msgContent as any)
      .find((value: any) => value && typeof value === 'object' && value.contextInfo) as
      | { contextInfo?: any }
      | undefined;
    const contextInfo = (msgContent as any).contextInfo || messageVariantWithContext?.contextInfo;

    let replyPrefix = '';
    if (contextInfo?.quotedMessage) {
      const quoted = unwrapMessageContent(contextInfo.quotedMessage) || {};
      let quotedText =
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        quoted.imageMessage?.caption ||
        quoted.videoMessage?.caption ||
        quoted.documentMessage?.caption ||
        '';
      if (!quotedText) {
        if (quoted.imageMessage) quotedText = '[image]';
        else if (quoted.videoMessage) quotedText = '[video]';
        else if (quoted.documentMessage) quotedText = `[document: ${quoted.documentMessage.fileName || 'file'}]`;
        else if (quoted.audioMessage) quotedText = '[voice note/audio]';
        else quotedText = '[media]';
      }
      const stanzaId = typeof contextInfo.stanzaId === 'string'
        ? contextInfo.stanzaId.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256)
        : '';
      const quotedPreview = JSON.stringify(normalizeQuotedPreview(quotedText));
      replyPrefix = `[Replying to message ID${stanzaId ? `: ${stanzaId}` : ':'} ${quotedPreview}]\n\n`;
      text = replyPrefix + text;
    }

    // Start the potentially slow media work now, then serialize only admission
    // to the single main-agent conversation. This keeps downloads and STT
    // concurrent without letting a faster later message overtake an earlier one.
    const normalizedPromise = this.prepareIncomingMessage({
      msg,
      msgContent,
      messageId,
      from: senderNumber,
      text,
      replyPrefix,
    });
    // The admission queue can be waiting on an earlier voice note. Mark an
    // early preparation failure as handled now, then rethrow it at its own
    // admission slot so it retains normal idempotency and gateway reporting.
    void normalizedPromise.catch(() => undefined);

    try {
      await this.enqueueInboundAdmission(async () => {
        const normalized = await normalizedPromise;
        if (normalized) {
          await this.onDispatch(normalized);
        }

        // Only acknowledge the inbound message after dispatch admission succeeds,
        // so a transient runtime failure can be retried by a redelivery.
        if (this.db.isOpen()) {
          this.db.recordIdempotency(idempotencyKey, 'whatsapp_inbound', messageId);
        }
      });
    } finally {
      this.inFlightInbound.delete(idempotencyKey);
    }
  }

  private enqueueInboundAdmission(operation: () => Promise<void>): Promise<void> {
    const admission = this.inboundAdmissionTail.then(operation, operation);
    this.inboundAdmissionTail = admission.catch(() => undefined);
    return admission;
  }

  private async prepareIncomingMessage(input: {
    msg: proto.IWebMessageInfo;
    msgContent: proto.IMessage;
    messageId: string;
    from: string;
    text: string;
    replyPrefix: string;
  }): Promise<NormalizedInboundMessage | null> {
    const logger = getLogger(this.customHome);
    const { msg, msgContent, messageId, from, replyPrefix } = input;
    let { text } = input;
    const attachments: InboundMediaAttachment[] = [];
    let isVoice = false;

    const paths = resolvePokePaths(this.customHome);
    const msgInboxDir = path.join(paths.inboxDir, messageId);
    const ensureInbox = () => {
      if (!fs.existsSync(msgInboxDir)) {
        fs.mkdirSync(msgInboxDir, { recursive: true, mode: 0o700 });
      }
    };

    // Audio / Voice note
    if (msgContent.audioMessage) {
      isVoice = true;
      const mime = msgContent.audioMessage.mimetype || 'audio/ogg';
      let size: number | undefined;
      try {
        ensureInbox();
        const ext = audioExtension(mime, Boolean(msgContent.audioMessage.ptt));
        const filePath = path.join(msgInboxDir, `audio.${ext}`);
        const buffer = await this.downloadMedia(msg as WAMessage);
        fs.writeFileSync(filePath, buffer as Buffer);
        size = (buffer as Buffer).length;

        attachments.push({
          path: filePath,
          filename: `audio.${ext}`,
          mimeType: mime,
          size,
          messageId,
          caption: text || undefined,
        });

        logger.info(
          { messageId, mimeType: mime, audioBytes: size, provider: 'groq', model: GROQ_STT_MODEL },
          'Transcribing incoming voice note with Groq Whisper Large V3'
        );
        try {
          const transcription = await this.groq.transcribe(buffer as Buffer, mime);
          if (transcription.quality) {
            const notice = `Poke could not reliably transcribe voice message ${messageId}. Groq returned low-confidence segments (${transcription.quality.reasons.join(', ')}). Please send it again.`;
            logger.warn(
              {
                messageId,
                mimeType: mime,
                audioBytes: size,
                provider: 'groq',
                model: GROQ_STT_MODEL,
                requestId: transcription.requestId,
                detectedLanguage: transcription.detectedLanguage,
                quality: transcription.quality,
              },
              'Voice note transcription has low-confidence segments'
            );
            await this.reportInboundMediaFailure(messageId, notice, {
              stage: 'transcription_low_confidence',
              mimeType: mime,
              audioBytes: size,
              provider: 'groq',
              model: GROQ_STT_MODEL,
              requestId: transcription.requestId,
              detectedLanguage: transcription.detectedLanguage,
              quality: transcription.quality,
            });
            text = appendVoiceFailure(text, replyPrefix, formatVoiceLowConfidenceTranscript());
          } else if (transcription.text) {
            text = replyPrefix + formatVoiceTranscript(transcription.text);
            logger.info(
              {
                messageId,
                provider: 'groq',
                model: GROQ_STT_MODEL,
                requestId: transcription.requestId,
                detectedLanguage: transcription.detectedLanguage,
                transcriptLength: transcription.text.length,
              },
              'Voice note transcribed'
            );
          } else {
            const notice = `Poke could not transcribe voice message ${messageId}. Groq returned an empty transcript. Please send it again.`;
            logger.warn(
              { messageId, mimeType: mime, audioBytes: size, provider: 'groq', model: GROQ_STT_MODEL },
              'Voice note transcription was empty'
            );
            await this.reportInboundMediaFailure(messageId, notice, {
              stage: 'transcription',
              mimeType: mime,
              audioBytes: size,
              provider: 'groq',
              model: GROQ_STT_MODEL,
              error: 'Groq returned an empty transcript.',
            });
            text = appendVoiceFailure(text, replyPrefix, formatVoiceTranscriptionFailure());
          }
        } catch (error: unknown) {
          const diagnostic = error instanceof GroqTranscriptionError
            ? {
                provider: error.provider,
                model: error.model,
                attempts: error.attempts,
                status: error.status,
                requestId: error.requestId,
              }
            : { provider: 'groq', model: GROQ_STT_MODEL };
          const notice = transcriptionFailureNotice(messageId, error);
          logger.error(
            {
              messageId,
              mimeType: mime,
              audioBytes: size,
              ...diagnostic,
              err: error,
            },
            'Voice note transcription failed'
          );
          await this.reportInboundMediaFailure(messageId, notice, {
            stage: 'transcription',
            mimeType: mime,
            audioBytes: size,
            ...diagnostic,
            error: compactErrorMessage(error),
          });
          text = appendVoiceFailure(text, replyPrefix, formatVoiceTranscriptionFailure());
        }
      } catch (error: unknown) {
        const notice = `Poke could not download voice message ${messageId}. ${compactErrorMessage(error)} Please send it again.`;
        logger.error(
          { messageId, mimeType: mime, audioBytes: size, err: error },
          'Failed to download or process audio message'
        );
        await this.reportInboundMediaFailure(messageId, notice, {
          stage: 'download',
          mimeType: mime,
          audioBytes: size,
          error: compactErrorMessage(error),
        });
        text = appendVoiceFailure(text, replyPrefix, formatVoiceDownloadFailure());
      }
    }

    // Image message
    if (msgContent.imageMessage) {
      try {
        ensureInbox();
        const filePath = path.join(msgInboxDir, 'image.jpg');
        const buffer = await this.downloadMedia(msg as WAMessage);
        fs.writeFileSync(filePath, buffer as Buffer);

        attachments.push({
          path: filePath,
          filename: 'image.jpg',
          mimeType: msgContent.imageMessage.mimetype || 'image/jpeg',
          size: (buffer as Buffer).length,
          messageId,
          caption: text || undefined,
          isImage: true,
        });
      } catch (error: unknown) {
        const notice = 'Poke could not download the image. Please send it again.';
        logger.error({ messageId, err: error }, 'Failed to download image message');
        await this.reportInboundMediaFailure(messageId, notice, {
          stage: 'download_image',
          error: compactErrorMessage(error),
        });
        if (!text.trim()) return null;
      }
    }

    // Document message with path traversal protection
    if (msgContent.documentMessage) {
      try {
        ensureInbox();
        const rawFilename = msgContent.documentMessage.fileName || 'document.bin';
        const filename = path.basename(rawFilename) || 'document.bin';
        const filePath = path.resolve(msgInboxDir, filename);

        if (!filePath.startsWith(path.resolve(msgInboxDir))) {
          throw new Error(`Invalid document path: ${filePath}`);
        }

        const buffer = await this.downloadMedia(msg as WAMessage);
        fs.writeFileSync(filePath, buffer as Buffer);

        attachments.push({
          path: filePath,
          filename,
          mimeType: msgContent.documentMessage.mimetype || 'application/octet-stream',
          size: (buffer as Buffer).length,
          messageId,
          caption: text || undefined,
        });
      } catch (error: unknown) {
        const notice = 'Poke could not download the document. Please send it again.';
        logger.error({ messageId, err: error }, 'Failed to download document message');
        await this.reportInboundMediaFailure(messageId, notice, {
          stage: 'download_document',
          error: compactErrorMessage(error),
        });
        if (!text.trim()) return null;
      }
    }

    // Video message
    if (msgContent.videoMessage) {
      try {
        ensureInbox();
        const filePath = path.join(msgInboxDir, 'video.mp4');
        const buffer = await this.downloadMedia(msg as WAMessage);
        fs.writeFileSync(filePath, buffer as Buffer);

        attachments.push({
          path: filePath,
          filename: 'video.mp4',
          mimeType: msgContent.videoMessage.mimetype || 'video/mp4',
          size: (buffer as Buffer).length,
          messageId,
          caption: text || undefined,
        });
      } catch (error: unknown) {
        const notice = 'Poke could not download the video. Please send it again.';
        logger.error({ messageId, err: error }, 'Failed to download video message');
        await this.reportInboundMediaFailure(messageId, notice, {
          stage: 'download_video',
          error: compactErrorMessage(error),
        });
        if (!text.trim()) return null;
      }
    }

    return {
      messageId,
      from,
      text: formatInboundMessageText(text, attachments),
      isVoice,
      attachments,
      rawMessage: msg,
    };
  }

  private scheduleReconnect(): void {
    if (this.isStopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isStopped) return;
      try {
        await this.start();
      } catch (err: any) {
        getLogger(this.customHome).error(
          { err: err?.message || String(err) },
          'WhatsApp reconnect attempt failed; rescheduling'
        );
        if (!this.isStopped) {
          this.scheduleReconnect();
        }
      }
    }, 3000);
  }

  private async reportInboundMediaFailure(
    messageId: string,
    notice: string,
    diagnostic?: Record<string, unknown>
  ): Promise<void> {
    try {
      this.db.recordOperationalError(
        'whatsapp_media',
        notice,
        JSON.stringify({ messageId, ...diagnostic })
      );
    } catch (error: unknown) {
      getLogger(this.customHome).error(
        { messageId, err: error },
        'Failed to persist inbound media failure diagnostics'
      );
    }

    try {
      await this.sender.sendDirectError(notice);
    } catch (error: unknown) {
      getLogger(this.customHome).error(
        { messageId, err: error },
        'Failed to report inbound media failure'
      );
    }
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    this.presence.stop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore close error
      }
      this.sock = null;
    }
    this.isConnecting = false;
    this.connectionState = 'disconnected';
    this.writeRuntimeStatus('Daemon stopped.');
  }

  private writeRuntimeStatus(reason?: string): void {
    try {
      const paths = resolvePokePaths(this.customHome);
      writeGatewayRuntimeStatus(paths.runtimeStatusFile, {
        state: this.connectionState,
        updatedAt: Date.now(),
        daemonPid: process.pid,
        ...(this.pairedAccount ? { pairedAccount: this.pairedAccount } : {}),
        ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
        ...(reason ? { reason } : {}),
      });
    } catch (error: any) {
      getLogger().warn({ err: error?.message || String(error) }, 'Failed to update WhatsApp runtime status');
    }
  }
}
