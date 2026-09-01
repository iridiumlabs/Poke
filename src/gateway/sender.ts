import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { PokeDatabase } from '../db/database.js';
import { DeepgramHandler } from './deepgram.js';
import { getLogger, redactSecrets } from '../logger/logger.js';

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

function computePayloadHash(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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

  private getCompletedPartMessageId(
    key: string,
    actionType: string,
    payloadHash: string
  ): string | null {
    const delivery = this.db.getOutgoingDelivery(key);
    if (delivery) {
      if (delivery.action_type !== actionType || delivery.payload_hash !== payloadHash) {
        throw new Error('This WhatsApp delivery key is already associated with different content.');
      }
      if (delivery.status === 'pending') {
        throw new Error(
          'WhatsApp delivery outcome is unknown. Refusing to replay the message automatically.'
        );
      }
      return this.parseMessageId(delivery.response_data, key);
    }

    // Installations upgraded from the pre-outbox sender may have a completed
    // idempotency record without a matching delivery row. It is safe to honor
    // that terminal response, but never to infer a missing response as sent.
    const legacy = this.db.checkIdempotency(key);
    if (!legacy) return null;
    if (legacy.action_type !== actionType || legacy.payload_hash !== payloadHash) {
      throw new Error('This WhatsApp delivery key is already associated with different content.');
    }
    if (!legacy.response_data) {
      throw new Error(
        'WhatsApp delivery outcome is unknown. Refusing to replay the message automatically.'
      );
    }
    return this.parseMessageId(legacy.response_data, key);
  }

  private parseMessageId(responseData: string | null | undefined, key: string): string {
    try {
      const parsed = JSON.parse(responseData || '') as { messageId?: unknown };
      if (typeof parsed.messageId === 'string' && parsed.messageId) return parsed.messageId;
    } catch {
      // Fall through to the safe error below.
    }
    throw new Error(`Completed WhatsApp delivery ${key} has no usable message ID.`);
  }

  private async sendPart(
    key: string,
    actionType: string,
    payloadHash: string,
    fallbackMessageId: string,
    send: () => Promise<any>
  ): Promise<string> {
    const completed = this.getCompletedPartMessageId(key, actionType, payloadHash);
    if (completed) return completed;

    const reservation = this.db.reserveOutgoingDelivery(key, actionType, payloadHash);
    if (!reservation.created) {
      const completedPart = this.getCompletedPartMessageId(key, actionType, payloadHash);
      if (!completedPart) {
        throw new Error('WhatsApp delivery outcome is unknown. Refusing to replay the message automatically.');
      }
      return completedPart;
    }

    // The pending record intentionally remains when the transport rejects or
    // this process dies after the request. WhatsApp does not offer an
    // idempotency key, so replaying that ambiguous message could duplicate it.
    const message = await send();
    const messageId = message?.key?.id || fallbackMessageId;
    this.db.completeOutgoingDelivery(
      key,
      actionType,
      payloadHash,
      JSON.stringify({ messageId })
    );
    return messageId;
  }

  async send(params: SendParams, idempotencyKey?: string): Promise<SendResult> {
    const logger = getLogger();
    const topPayloadHash = computePayloadHash(params);

    if (idempotencyKey) {
      const existing = this.db.checkIdempotency(idempotencyKey);
      if (existing && existing.payload_hash !== topPayloadHash) {
        throw new Error('This WhatsApp send key is already associated with different content.');
      }
      if (existing?.response_data) {
        logger.info({ idempotencyKey }, 'Returning cached WhatsApp send response due to idempotency');
        return JSON.parse(existing.response_data) as SendResult;
      }
    }

    const sock = this.getSocket();
    if (!sock) {
      throw new Error('WhatsApp gateway is not connected.');
    }

    const targetJid = this.ownerJid;
    const deliveryKey = idempotencyKey || `send:${crypto.randomUUID()}`;
    let messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let partIndex = 0;

    if (params.mode === 'voice') {
      const voicePartPayload = {
        mode: 'voice',
        text: params.text,
        reply_to: params.reply_to,
      };
      const partPayloadHash = computePayloadHash(voicePartPayload);
      const partKey = `${deliveryKey}:part:${partIndex}`;
      const cachedPart = this.getCompletedPartMessageId(
        partKey,
        'whatsapp_send_part',
        partPayloadHash
      );

      if (cachedPart) {
        messageId = cachedPart;
      } else {
        logger.info('Synthesizing and sending voice note');
        const { audioPath, mimeType } = await this.deepgram.synthesizeToAudioFile(params.text);
        const audioBuffer = fs.readFileSync(audioPath);
        messageId = await this.sendPart(
          partKey,
          'whatsapp_send_part',
          partPayloadHash,
          messageId,
          () => sock.sendMessage(
            targetJid,
            {
              audio: audioBuffer,
              mimetype: mimeType,
              ptt: true,
            },
            params.reply_to
              ? {
                  quoted: {
                    key: { remoteJid: targetJid, id: params.reply_to },
                    message: { conversation: '' },
                  },
                }
              : undefined
          )
        );
      }
      partIndex++;
    } else {
      // mode === "message"
      const chunks = splitLongTextMessage(params.text);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isFirst = i === 0;
        const chunkPartPayload = {
          mode: 'message',
          chunk,
          reply_to: isFirst ? params.reply_to : undefined,
        };
        const partPayloadHash = computePayloadHash(chunkPartPayload);
        const partKey = `${deliveryKey}:part:${partIndex}`;
        messageId = await this.sendPart(
          partKey,
          'whatsapp_send_part',
          partPayloadHash,
          messageId,
          () => sock.sendMessage(
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
          )
        );
        partIndex++;
      }
    }

    // Send attachments if present
    if (params.attachments && params.attachments.length > 0) {
      for (const att of params.attachments) {
        const attPartPayload = {
          attachment: {
            path: att.path,
            filename: att.filename,
            mimeType: att.mimeType,
          },
        };
        const partPayloadHash = computePayloadHash(attPartPayload);
        const partKey = `${deliveryKey}:part:${partIndex}`;
        const cachedPart = this.getCompletedPartMessageId(
          partKey,
          'whatsapp_send_part',
          partPayloadHash
        );
        if (cachedPart) {
          messageId = cachedPart;
          partIndex++;
          continue;
        }

        if (!fs.existsSync(att.path)) {
          throw new Error(`Attachment file not found: ${att.path}`);
        }

        const buffer = fs.readFileSync(att.path);
        const mime = att.mimeType || 'application/octet-stream';
        const filename = att.filename || path.basename(att.path);
        messageId = await this.sendPart(
          partKey,
          'whatsapp_send_part',
          partPayloadHash,
          messageId,
          () => {
            if (mime.startsWith('image/')) {
              return sock.sendMessage(targetJid, {
                image: buffer,
                caption: filename !== path.basename(att.path) ? filename : undefined,
              });
            }
            if (mime.startsWith('video/')) {
              return sock.sendMessage(targetJid, { video: buffer, caption: filename });
            }
            if (mime.startsWith('audio/')) {
              return sock.sendMessage(targetJid, { audio: buffer, mimetype: mime });
            }
            return sock.sendMessage(targetJid, {
              document: buffer,
              mimetype: mime,
              fileName: filename,
            });
          }
        );
        partIndex++;
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
        topPayloadHash,
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
    return await this.sendDirectNotice(`Poke error\n\n${redactSecrets(errorMessage)}`);
  }
}
