import fs from 'fs';
import path from 'path';
import { PokeDatabase } from '../db/database.js';
import { DeepgramHandler } from './deepgram.js';
import { getLogger } from '../logger/logger.js';

export interface SendParams {
  mode: 'message' | 'voice';
  text: string;
  attachments?: Array<{
    path: string;
    filename?: string;
    mimeType?: string;
  }>;
  reply_to?: string;
}

export interface SendResult {
  messageId: string;
  mode: 'message' | 'voice';
  timestamp: number;
}

export interface WhatsAppSocketLike {
  sendMessage(
    jid: string,
    content: any,
    options?: any
  ): Promise<any>;
}

export function splitLongTextMessage(text: string, maxLength = 4000): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer.');
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Prefer a complete code block when its closing fence fits in this message.
    let splitIdx = remaining.lastIndexOf('\n```', maxLength);
    if (splitIdx > maxLength / 2) {
      const closingLineEnd = remaining.indexOf('\n', splitIdx + 1);
      splitIdx = closingLineEnd > 0 && closingLineEnd <= maxLength ? closingLineEnd : -1;
    }

    if (splitIdx < maxLength / 3) {
      // Try paragraph, line, then word boundaries.
      splitIdx = remaining.lastIndexOf('\n\n', maxLength);
      if (splitIdx === -1 || splitIdx < maxLength / 3) {
        splitIdx = remaining.lastIndexOf('\n', maxLength);
      }
      if (splitIdx === -1 || splitIdx < maxLength / 3) {
        splitIdx = remaining.lastIndexOf(' ', maxLength);
      }
    }

    if (splitIdx <= 0 || splitIdx > maxLength) {
      splitIdx = maxLength;
    }

    let chunk = remaining.slice(0, splitIdx).trimEnd();
    if (!chunk) {
      // Whitespace-only boundaries must still make progress.
      splitIdx = Math.min(maxLength, remaining.length);
      chunk = remaining.slice(0, splitIdx);
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

export class WhatsAppSender {
  constructor(
    private getSocket: () => WhatsAppSocketLike | null,
    private ownerJid: string,
    private db: PokeDatabase,
    private deepgram: DeepgramHandler
  ) {}

  setOwnerJid(jid: string): void {
    this.ownerJid = jid;
  }

  async send(params: SendParams, idempotencyKey?: string): Promise<SendResult> {
    const logger = getLogger();

    // Idempotency check
    if (idempotencyKey) {
      const existing = this.db.checkIdempotency(idempotencyKey);
      if (existing && existing.response_data) {
        logger.info({ idempotencyKey }, 'Returning cached WhatsApp send response due to idempotency');
        return JSON.parse(existing.response_data);
      }
    }

    const sock = this.getSocket();
    if (!sock) {
      throw new Error('WhatsApp gateway is not connected.');
    }

    const targetJid = this.ownerJid;
    let messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let partIndex = 0;

    if (params.mode === 'voice') {
      const partKey = idempotencyKey ? `${idempotencyKey}:part:${partIndex}` : undefined;
      const cachedPart = partKey ? this.db.checkIdempotency(partKey) : null;

      if (cachedPart && cachedPart.response_data) {
        try {
          const parsed = JSON.parse(cachedPart.response_data);
          if (parsed.messageId) messageId = parsed.messageId;
        } catch {
          // ignore
        }
      } else {
        logger.info('Synthesizing and sending voice note');
        const { audioPath, mimeType } = await this.deepgram.synthesizeToAudioFile(params.text);
        const audioBuffer = fs.readFileSync(audioPath);

        const msg = await sock.sendMessage(
          targetJid,
          {
            audio: audioBuffer,
            mimetype: mimeType,
            ptt: true, // Send as WhatsApp voice note
          },
          params.reply_to
            ? {
                quoted: {
                  key: { remoteJid: targetJid, id: params.reply_to },
                  message: { conversation: '' },
                },
              }
            : undefined
        );

        if (msg?.key?.id) {
          messageId = msg.key.id;
        }

        if (partKey) {
          this.db.recordIdempotency(
            partKey,
            'whatsapp_send_part',
            '',
            JSON.stringify({ messageId })
          );
        }
      }
    } else {
      // mode === "message"
      const chunks = splitLongTextMessage(params.text);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isFirst = i === 0;
        const partKey = idempotencyKey ? `${idempotencyKey}:part:${partIndex}` : undefined;
        const cachedPart = partKey ? this.db.checkIdempotency(partKey) : null;

        if (cachedPart && cachedPart.response_data) {
          try {
            const parsed = JSON.parse(cachedPart.response_data);
            if (parsed.messageId) messageId = parsed.messageId;
          } catch {
            // ignore
          }
        } else {
          const msg = await sock.sendMessage(
            targetJid,
            { text: chunk },
            isFirst && params.reply_to
              ? {
                  quoted: {
                    key: { remoteJid: targetJid, id: params.reply_to },
                    message: { conversation: '' },
                  },
                }
              : undefined
          );
          if (msg?.key?.id) {
            messageId = msg.key.id;
          }

          if (partKey) {
            this.db.recordIdempotency(
              partKey,
              'whatsapp_send_part',
              '',
              JSON.stringify({ messageId })
            );
          }
        }
        partIndex++;
      }

      // Send attachments if present
      if (params.attachments && params.attachments.length > 0) {
        for (const att of params.attachments) {
          const partKey = idempotencyKey ? `${idempotencyKey}:part:${partIndex}` : undefined;
          const cachedPart = partKey ? this.db.checkIdempotency(partKey) : null;

          if (cachedPart && cachedPart.response_data) {
            try {
              const parsed = JSON.parse(cachedPart.response_data);
              if (parsed.messageId) messageId = parsed.messageId;
            } catch {
              // ignore
            }
          } else {
            if (!fs.existsSync(att.path)) {
              throw new Error(`Attachment file not found: ${att.path}`);
            }

            const buffer = fs.readFileSync(att.path);
            const mime = att.mimeType || 'application/octet-stream';
            const filename = att.filename || path.basename(att.path);

            let msg: any;
            if (mime.startsWith('image/')) {
              msg = await sock.sendMessage(targetJid, {
                image: buffer,
                caption: filename !== path.basename(att.path) ? filename : undefined,
              });
            } else if (mime.startsWith('video/')) {
              msg = await sock.sendMessage(targetJid, {
                video: buffer,
                caption: filename,
              });
            } else if (mime.startsWith('audio/')) {
              msg = await sock.sendMessage(targetJid, {
                audio: buffer,
                mimetype: mime,
              });
            } else {
              msg = await sock.sendMessage(targetJid, {
                document: buffer,
                mimetype: mime,
                fileName: filename,
              });
            }

            if (msg?.key?.id) {
              messageId = msg.key.id;
            }

            if (partKey) {
              this.db.recordIdempotency(
                partKey,
                'whatsapp_send_part',
                '',
                JSON.stringify({ messageId })
              );
            }
          }
          partIndex++;
        }
      }
    }

    const result: SendResult = {
      messageId,
      mode: params.mode,
      timestamp: Date.now(),
    };

    if (idempotencyKey) {
      this.db.recordIdempotency(
        idempotencyKey,
        'whatsapp_send',
        JSON.stringify(params),
        JSON.stringify(result)
      );
    }

    return result;
  }

  async sendDirectNotice(notice: string): Promise<void> {
    const sock = this.getSocket();
    if (!sock || !this.ownerJid) return;

    try {
      await sock.sendMessage(this.ownerJid, { text: notice });
    } catch (err: any) {
      getLogger().error({ err: err.message }, 'Failed to send direct notice to WhatsApp');
    }
  }

  async sendDirectError(errorMessage: string): Promise<void> {
    return await this.sendDirectNotice(`Poke error\n\n${errorMessage}`);
  }
}
