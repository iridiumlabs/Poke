import fs from 'node:fs';
import path from 'node:path';
import { getLogger, redactSecrets } from '../logger/logger.js';
import { providerRequestSignal } from '../providers/fetch.js';
import { withProviderRetry } from '../providers/retry.js';

export const GROQ_STT_MODEL = 'whisper-large-v3';
const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export interface GroqTranscription {
  text: string;
  detectedLanguage?: string;
  requestId?: string;
  quality?: GroqTranscriptionQuality;
}

export type GroqTranscriptionQualityReason =
  | 'high_compression_ratio'
  | 'low_log_probability'
  | 'likely_silence';

/**
 * A conservative signal derived from the same metadata and thresholds used by
 * Whisper's reference decoder to decide whether a segment needs fallback.
 */
export interface GroqTranscriptionQuality {
  requiresVerification: true;
  segmentCount: number;
  affectedSegmentCount: number;
  reasons: GroqTranscriptionQualityReason[];
}

export class GroqTranscriptionError extends Error {
  readonly provider = 'groq';
  readonly model: string;
  readonly attempts: number;
  readonly status?: number;
  readonly requestId?: string;
  readonly cause: unknown;

  constructor(
    message: string,
    details: {
      model: string;
      attempts: number;
      status?: number;
      requestId?: string;
      cause: unknown;
    }
  ) {
    super(message);
    this.name = 'GroqTranscriptionError';
    this.model = details.model;
    this.attempts = details.attempts;
    this.status = details.status;
    this.requestId = details.requestId;
    this.cause = details.cause;
  }
}

function boundedProviderDetail(detail: string): string {
  const cleaned = String(redactSecrets(detail))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 600 ? `${cleaned.slice(0, 597)}...` : cleaned;
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown; statusCode?: unknown } | undefined)?.status
    ?? (error as { statusCode?: unknown } | undefined)?.statusCode;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function errorRequestId(error: unknown): string | undefined {
  const value = (error as { requestId?: unknown } | undefined)?.requestId;
  if (typeof value === 'string' && value) return value;

  const headers = (error as { headers?: { get?: (key: string) => string | null } } | undefined)?.headers;
  return headers?.get?.('x-request-id') || headers?.get?.('x-groq-request-id') || undefined;
}

function filenameForMimeType(mimeType: string): string {
  const mediaType = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'audio/ogg') return 'audio.ogg';
  if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3') return 'audio.mp3';
  if (mediaType === 'audio/mp4' || mediaType === 'audio/m4a') return 'audio.m4a';
  if (mediaType === 'audio/aac') return 'audio.aac';
  if (mediaType === 'audio/wav' || mediaType === 'audio/x-wav') return 'audio.wav';
  if (mediaType === 'audio/webm') return 'audio.webm';
  return 'audio.bin';
}

const WHISPER_COMPRESSION_RATIO_THRESHOLD = 2.4;
const WHISPER_LOGPROB_THRESHOLD = -1.0;
const WHISPER_NO_SPEECH_THRESHOLD = 0.6;

interface GroqVerboseSegment {
  avg_logprob?: unknown;
  compression_ratio?: unknown;
  no_speech_prob?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function assessGroqTranscriptionQuality(segments: unknown): GroqTranscriptionQuality | undefined {
  if (!Array.isArray(segments) || segments.length === 0) return undefined;

  const reasons = new Set<GroqTranscriptionQualityReason>();
  let affectedSegmentCount = 0;

  for (const rawSegment of segments) {
    if (!rawSegment || typeof rawSegment !== 'object') continue;
    const segment = rawSegment as GroqVerboseSegment;
    const avgLogprob = finiteNumber(segment.avg_logprob);
    const compressionRatio = finiteNumber(segment.compression_ratio);
    const noSpeechProb = finiteNumber(segment.no_speech_prob);
    const lowLogProbability = avgLogprob !== undefined && avgLogprob < WHISPER_LOGPROB_THRESHOLD;
    const likelySilence = lowLogProbability
      && noSpeechProb !== undefined
      && noSpeechProb > WHISPER_NO_SPEECH_THRESHOLD;
    const repetitive = compressionRatio !== undefined
      && compressionRatio > WHISPER_COMPRESSION_RATIO_THRESHOLD;

    if (!lowLogProbability && !repetitive) continue;

    affectedSegmentCount++;
    if (likelySilence) {
      reasons.add('likely_silence');
    } else if (lowLogProbability) {
      reasons.add('low_log_probability');
    }
    if (repetitive) reasons.add('high_compression_ratio');
  }

  if (affectedSegmentCount === 0) return undefined;
  return {
    requiresVerification: true,
    segmentCount: segments.length,
    affectedSegmentCount,
    reasons: [...reasons],
  };
}

function requestIdFromResponse(data: unknown, response: Response): string | undefined {
  const bodyRequestId = (data as { x_groq?: { id?: unknown } } | undefined)?.x_groq?.id;
  if (typeof bodyRequestId === 'string' && bodyRequestId) return bodyRequestId;
  return response.headers.get('x-request-id') || response.headers.get('x-groq-request-id') || undefined;
}

async function errorDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') return boundedProviderDetail(parsed.error.message);
  } catch {
    // Keep the bounded raw response below when it is not JSON.
  }
  return boundedProviderDetail(body);
}

export class GroqTranscriptionHandler {
  constructor(private apiKey?: string, private customHome?: string) {}

  async transcribe(audioBuffer: Buffer | string, mimeType = 'audio/ogg'): Promise<GroqTranscription> {
    if (!this.apiKey) {
      throw new Error('Groq API key is not configured. Add it with `poke configure`.');
    }

    const buffer = typeof audioBuffer === 'string' ? fs.readFileSync(audioBuffer) : audioBuffer;
    const filename = typeof audioBuffer === 'string'
      ? path.basename(audioBuffer)
      : filenameForMimeType(mimeType);
    const logger = getLogger(this.customHome);
    logger.info({ model: GROQ_STT_MODEL, mimeType, audioBytes: buffer.length }, 'Transcribing audio with Groq Whisper Large V3');

    let attempts = 0;
    try {
      return await withProviderRetry(async (attempt) => {
        attempts = attempt;
        const form = new FormData();
        form.set('model', GROQ_STT_MODEL);
        form.set('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');
        form.set('temperature', '0');
        // Leave language unset. Whisper selects the language from this one
        // recording instead of treating all Poke voice notes as Urdu or English.
        form.set('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

        const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
          signal: providerRequestSignal(),
        });

        if (!response.ok) {
          const detail = await errorDetail(response);
          const error = new Error(
            detail
              ? `Groq STT returned ${response.status}: ${detail}`
              : `Groq STT returned ${response.status}.`
          );
          (error as Error & { status?: number }).status = response.status;
          (error as Error & { headers?: Headers }).headers = response.headers;
          (error as Error & { requestId?: string }).requestId = requestIdFromResponse(undefined, response);
          throw error;
        }

        const data = await response.json() as {
          text?: unknown;
          language?: unknown;
          segments?: unknown;
          x_groq?: { id?: unknown };
        };
        const quality = assessGroqTranscriptionQuality(data.segments);
        return {
          text: typeof data.text === 'string' ? data.text.trim() : '',
          detectedLanguage: typeof data.language === 'string' ? data.language : undefined,
          requestId: requestIdFromResponse(data, response),
          ...(quality ? { quality } : {}),
        };
      });
    } catch (error: unknown) {
      const retryCount = Math.max(1, attempts);
      const reason = error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error));
      throw new GroqTranscriptionError(
        `Groq ${GROQ_STT_MODEL} transcription failed after ${retryCount} attempt${retryCount === 1 ? '' : 's'}: ${reason}`,
        {
          model: GROQ_STT_MODEL,
          attempts: retryCount,
          status: errorStatus(error),
          requestId: errorRequestId(error),
          cause: error,
        }
      );
    }
  }
}
