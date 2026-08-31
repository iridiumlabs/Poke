import fs from 'fs';
import path from 'path';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  proto,
  WAMessage,
} from '@whiskeysockets/baileys';
import { ConfigManager, normalizePhoneNumber } from '../config/config.js';
import { PokeDatabase } from '../db/database.js';
import { DeepgramHandler } from './deepgram.js';
import { WhatsAppSender } from './sender.js';
import { getLogger } from '../logger/logger.js';
import { resolvePokePaths, ensurePokeDirectories } from '../config/paths.js';

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

export type MessageDispatchFn = (msg: NormalizedInboundMessage) => Promise<void>;
export type StopHandlerFn = () => Promise<void>;

export class WhatsAppGateway {
  private sock: any = null;
  private isConnecting = false;
  private qrCode: string | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private sender: WhatsAppSender;
  private deepgram: DeepgramHandler;

  constructor(
    private configManager: ConfigManager,
    private db: PokeDatabase,
    private onDispatch: MessageDispatchFn,
    private onStop: StopHandlerFn,
    private customHome?: string
  ) {
    const creds = this.configManager.getCredentials();
    this.deepgram = new DeepgramHandler(creds.deepgramApiKey, customHome);
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

  async start(): Promise<void> {
    if (this.sock || this.isConnecting) return;
    this.isConnecting = true;
    this.connectionState = 'connecting';

    const logger = getLogger();
    logger.info('Initializing WhatsApp Baileys gateway');

    const paths = resolvePokePaths(this.customHome);
    ensurePokeDirectories(paths);

    const { state, saveCreds } = await useMultiFileAuthState(paths.whatsappDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
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
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.warn({ statusCode, shouldReconnect }, 'WhatsApp connection closed');
        if (shouldReconnect) {
          setTimeout(() => this.start(), 3000);
        }
      } else if (connection === 'open') {
        this.connectionState = 'connected';
        this.qrCode = null;
        this.isConnecting = false;
        logger.info('WhatsApp connected successfully');

        const ownerPhone = this.configManager.getOwnerPhoneNumber();
        if (ownerPhone) {
          this.sender.setOwnerJid(`${ownerPhone}@s.whatsapp.net`);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async (m: any) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message || msg.key?.fromMe) continue;
        await this.handleIncomingMessage(msg);
      }
    });
  }

  async handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    const logger = getLogger();
    const remoteJid = msg.key?.remoteJid || '';

    // Ignore status broadcasts and groups
    if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) {
      return;
    }

    // Owner check
    const senderNumber = normalizePhoneNumber(remoteJid.replace(/@.*$/, ''));
    const ownerNumber = this.configManager.getOwnerPhoneNumber();

    if (!ownerNumber || senderNumber !== ownerNumber) {
      logger.warn(
        { senderNumber, ownerNumber, remoteJid },
        'Ignoring message from non-owner'
      );
      return;
    }

    const messageId = msg.key?.id || `msg-${Date.now()}`;
    logger.info({ messageId, remoteJid }, 'Received WhatsApp message from owner');

    // Extract text and attachments
    const msgContent = msg.message!;
    let text =
      msgContent.conversation ||
      msgContent.extendedTextMessage?.text ||
      msgContent.imageMessage?.caption ||
      msgContent.videoMessage?.caption ||
      msgContent.documentMessage?.caption ||
      '';

    const trimmedText = text.trim();

    // Check exact /stop command
    if (trimmedText === '/stop') {
      logger.info({ messageId }, 'Received exact /stop command. Triggering emergency brake.');
      try {
        await this.onStop();
        await this.sender.sendDirectNotice('Stopped.');
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed during /stop handling');
        await this.sender.sendDirectNotice('Stopped.');
      }
      return;
    }

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
        const buffer = await downloadMediaMessage(msg as WAMessage, 'buffer', {});
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

        if (isPtt || mime.includes('audio/ogg')) {
          isVoice = true;
          try {
            const transcript = await this.deepgram.transcribe(buffer as Buffer, mime);
            text = `[voice]\n${transcript}`;
          } catch (sttErr: any) {
            logger.error({ err: sttErr.message }, 'Deepgram voice transcription failed');
            await this.sender.sendDirectError(
              `Voice transcription failed: ${sttErr.message}. You can reply in text or send the voice note again.`
            );
            return;
          }
        }
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to download or process audio message');
      }
    }

    // Image message
    if (msgContent.imageMessage) {
      try {
        if (!fs.existsSync(msgInboxDir)) {
          fs.mkdirSync(msgInboxDir, { recursive: true, mode: 0o700 });
        }
        const filePath = path.join(msgInboxDir, 'image.jpg');
        const buffer = await downloadMediaMessage(msg as WAMessage, 'buffer', {});
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
      }
    }

    // Document message
    if (msgContent.documentMessage) {
      try {
        if (!fs.existsSync(msgInboxDir)) {
          fs.mkdirSync(msgInboxDir, { recursive: true, mode: 0o700 });
        }
        const filename = msgContent.documentMessage.fileName || 'document.bin';
        const filePath = path.join(msgInboxDir, filename);
        const buffer = await downloadMediaMessage(msg as WAMessage, 'buffer', {});
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
      }
    }

    // Video message
    if (msgContent.videoMessage) {
      try {
        if (!fs.existsSync(msgInboxDir)) {
          fs.mkdirSync(msgInboxDir, { recursive: true, mode: 0o700 });
        }
        const filePath = path.join(msgInboxDir, 'video.mp4');
        const buffer = await downloadMediaMessage(msg as WAMessage, 'buffer', {});
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
  }

  async stop(): Promise<void> {
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore close error
      }
      this.sock = null;
    }
    this.connectionState = 'disconnected';
  }
}
