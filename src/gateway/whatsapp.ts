import fs from 'fs';
import path from 'path';
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
import { WhatsAppSender } from './sender.js';
import { getLogger } from '../logger/logger.js';
import { resolvePokePaths, ensurePokeDirectories } from '../config/paths.js';
import { writeGatewayRuntimeStatus } from './runtime-status.js';

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

export interface WhatsAppGatewayDependencies {
  downloadMedia?: (message: WAMessage) => Promise<Buffer>;
  deepgram?: DeepgramHandler;
}

export class WhatsAppGateway {
  private sock: any = null;
  private isConnecting = false;
  private qrCode: string | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private inFlightInbound = new Set<string>();
  private sender: WhatsAppSender;
  private deepgram: DeepgramHandler;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isStopped = false;
  private lastConnectedAt: number | undefined;
  private pairedAccount: string | undefined;
  private readonly downloadMedia: (message: WAMessage) => Promise<Buffer>;

  constructor(
    private configManager: ConfigManager,
    private db: PokeDatabase,
    private onDispatch: MessageDispatchFn,
    private onStop: StopHandlerFn,
    private customHome?: string,
    dependencies: WhatsAppGatewayDependencies = {}
  ) {
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
    const ownerPhone = this.configManager.getOwnerPhoneNumber() || '';
    const ownerJid = ownerPhone ? `${ownerPhone}@s.whatsapp.net` : '';
    this.sender = new WhatsAppSender(
      () => this.sock,
      ownerJid,
      this.db,
      this.deepgram
    );
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
        }
      });

      this.sock.ev.on('messages.upsert', (m: any) => {
        if (m.type !== 'notify') return;

        void (async () => {
          for (const msg of m.messages) {
            if (!msg.message || msg.key?.fromMe) continue;
            try {
              await this.handleIncomingMessage(msg);
            } catch (err: any) {
              logger.error({ err: err?.message || String(err) }, 'Failed to process incoming WhatsApp message');
            }
          }
        })();
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
    const logger = getLogger();
    const remoteJid = msg.key?.remoteJid || '';
    const messageId = msg.key?.id || `msg-${Date.now()}`;

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

    try {
      // Handle Media & Attachments
      const attachments: InboundMediaAttachment[] = [];
      let isVoice = false;

      const paths = resolvePokePaths(this.customHome);
      const msgInboxDir = path.join(paths.inboxDir, messageId);

      // Audio / Voice note
      if (msgContent.audioMessage) {
        try {
          if (!fs.existsSync(msgInboxDir)) {
            fs.mkdirSync(msgInboxDir, { recursive: true, mode: 0o700 });
          }
          const isPtt = Boolean(msgContent.audioMessage.ptt);
          const ext = isPtt ? 'ogg' : 'mp3';
          const filePath = path.join(msgInboxDir, `audio.${ext}`);
          const buffer = await this.downloadMedia(msg as WAMessage);
          fs.writeFileSync(filePath, buffer as Buffer);

          const mime = msgContent.audioMessage.mimetype || 'audio/ogg';
          const size = (buffer as Buffer).length;

          attachments.push({
            path: filePath,
            filename: `audio.${ext}`,
            mimeType: mime,
            size,
            messageId,
            caption: text || undefined,
          });

          // Transcribe voice note via Deepgram
          if (this.deepgram) {
            logger.info('Transcribing incoming voice note with Deepgram Nova-3');
            try {
              const transcript = await this.deepgram.transcribe(buffer as Buffer, mime);
              if (transcript) {
                text = replyPrefix + formatVoiceTranscript(transcript);
                isVoice = true;
                logger.info({ messageId, transcriptLength: transcript.length }, 'Voice note transcribed');
              } else {
                logger.warn({ messageId }, 'Voice note transcription was empty');
                await this.reportInboundMediaFailure(
                  messageId,
                  'Poke could not transcribe the voice message. Please send it again.'
                );
                if (!text.trim() || text === replyPrefix) return;
              }
            } catch (sttErr: any) {
              logger.error({ err: sttErr.message }, 'Voice note transcription failed');
              await this.reportInboundMediaFailure(
                messageId,
                'Poke could not transcribe the voice message. Please send it again.'
              );
              if (!text.trim() || text === replyPrefix) return;
            }
          }
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to download or process audio message');
          await this.reportInboundMediaFailure(
            messageId,
            'Poke could not download the audio message. Please send it again.'
          );
          if (!text.trim() || text === replyPrefix) return;
        }
      }

      // Image message
      if (msgContent.imageMessage) {
        try {
          if (!fs.existsSync(msgInboxDir)) {
            fs.mkdirSync(msgInboxDir, { recursive: true, mode: 0o700 });
          }
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
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to download image message');
          await this.reportInboundMediaFailure(
            messageId,
            'Poke could not download the image. Please send it again.'
          );
          if (!text.trim()) return;
        }
      }

      // Document message with path traversal protection
      if (msgContent.documentMessage) {
        try {
          if (!fs.existsSync(msgInboxDir)) {
            fs.mkdirSync(msgInboxDir, { recursive: true, mode: 0o700 });
          }
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
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to download document message');
          await this.reportInboundMediaFailure(
            messageId,
            'Poke could not download the document. Please send it again.'
          );
          if (!text.trim()) return;
        }
      }

      // Video message
      if (msgContent.videoMessage) {
        try {
          if (!fs.existsSync(msgInboxDir)) {
            fs.mkdirSync(msgInboxDir, { recursive: true, mode: 0o700 });
          }
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
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to download video message');
          await this.reportInboundMediaFailure(
            messageId,
            'Poke could not download the video. Please send it again.'
          );
          if (!text.trim()) return;
        }
      }

      // Build normalized message
      const formattedText = formatInboundMessageText(text, attachments);
      const normalized: NormalizedInboundMessage = {
        messageId,
        from: senderNumber,
        text: formattedText,
        isVoice,
        attachments,
        rawMessage: msg,
      };

      // Dispatch immediately into the main agent
      await this.onDispatch(normalized);

      // Only acknowledge the inbound message after dispatch admission succeeds, so a
      // transient runtime failure can be retried by a redelivery.
      if (this.db.isOpen()) {
        this.db.recordIdempotency(idempotencyKey, 'whatsapp_inbound', messageId);
      }
    } finally {
      this.inFlightInbound.delete(idempotencyKey);
    }
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
        getLogger().error(
          { err: err?.message || String(err) },
          'WhatsApp reconnect attempt failed; rescheduling'
        );
        if (!this.isStopped) {
          this.scheduleReconnect();
        }
      }
    }, 3000);
  }

  private async reportInboundMediaFailure(messageId: string, notice: string): Promise<void> {
    try {
      await this.sender.sendDirectError(notice);
    } catch (error: unknown) {
      getLogger().error(
        { messageId, err: error instanceof Error ? error.message : String(error) },
        'Failed to report inbound media failure'
      );
    }
  }

  async stop(): Promise<void> {
    this.isStopped = true;
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
