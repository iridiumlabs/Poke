import { getLogger } from '../logger/logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  delaysMs?: number[];
  jitter?: boolean;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_PROVIDER_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];
export const MAX_PROVIDER_RETRY_DELAY_MS = 60_000;

export class NonRetryableError extends Error {
  constructor(message: string, public readonly statusCode?: number, public readonly cause?: unknown) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export function extractHttpStatus(error: any, rawMsg?: string): number | undefined {
  const status = error?.status || error?.statusCode || error?.response?.status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    return status;
  }
  const text = rawMsg !== undefined ? rawMsg : (typeof error === 'string' ? error : (error?.message || ''));
  if (!text) return undefined;

  // Strip Flue submission IDs (sub_...) and long hex strings to avoid false matches
  // on IDs that happen to contain status codes like 401 or 500
  const sanitized = text
    .replace(/\bsub_[a-zA-Z0-9_]+\b/g, '')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, '');

  // Look for explicit HTTP status code patterns:
  // 1. Prefix: "500: {...}" or "failed: 500: {...}"
  // 2. Explicit keyword: "http 500", "status 500", "status code: 500", "returned 500", "error 500"
  const match = sanitized.match(
    /(?:(?:^|failed:\s*)(\d{3}):|(?:\bhttp|\bstatus(?:\s*code)?|\breturned|\berror(?:\s*code)?)\s*[:=]?\s*(\d{3})\b)/i
  );
  if (match) {
    const code = Number(match[1] || match[2]);
    if (code >= 100 && code < 600) {
      return code;
    }
  }
  return undefined;
}

export function isTransientError(error: any): boolean {
  if (error instanceof NonRetryableError) {
    return false;
  }

  const rawMsg = typeof error === 'string' ? error : (error?.message || '');
  const parsedStatus = extractHttpStatus(error, rawMsg);

  if (parsedStatus) {
    // 429 Too Many Requests, 5xx Server Errors are transient
    if (parsedStatus === 429 || (parsedStatus >= 500 && parsedStatus < 600)) {
      return true;
    }
    // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, etc. are NOT transient
    if (parsedStatus >= 400 && parsedStatus < 500) {
      return false;
    }
  }

  // Network / connection errors
  const code = error?.code || error?.cause?.code;
  if (code) {
    const transientCodes = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ];
    if (transientCodes.includes(code)) {
      return true;
    }
  }

  const msg = rawMsg
    .replace(/\bsub_[a-zA-Z0-9_]+\b/g, '')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, '')
    .toLowerCase();

  // Authentication and client errors are not transient
  if (
    parsedStatus === 401 ||
    parsedStatus === 403 ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key')
  ) {
    return false;
  }

  if (
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('timeout') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout') ||
    msg.includes('bad gateway') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('internal_server_error') ||
    msg.includes('internal server error') ||
    msg.includes('server_error')
  ) {
    return true;
  }

  return false;
}

export function isUserActionableError(error: any): boolean {
  if (isTransientError(error)) {
    return false;
  }
  const rawMsg = typeof error === 'string' ? error : (error?.message || '');
  const parsedStatus = extractHttpStatus(error, rawMsg);
  if (parsedStatus === 401 || parsedStatus === 403) {
    return true;
  }
  const msg = rawMsg
    .replace(/\bsub_[a-zA-Z0-9_]+\b/g, '')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, '')
    .toLowerCase();

  if (
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key') ||
    msg.includes('authentication failed') ||
    msg.includes('poke login') ||
    msg.includes('not authenticated')
  ) {
    return true;
  }
  return false;
}

export function extractRetryAfterMs(error: any): number | null {
  const headers = error.headers || error.response?.headers;
  if (!headers) return null;

  const retryAfterHeader =
    headers.get?.('retry-after') || headers['retry-after'] || headers['Retry-After'];
  if (!retryAfterHeader) return null;

  const seconds = Number(retryAfterHeader);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfterHeader);
  if (!isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : null;
  }

  return null;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Provider retry aborted.');
}

function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withProviderRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const delays = options?.delaysMs || DEFAULT_PROVIDER_RETRY_DELAYS_MS;
  const maxAttempts = options?.maxAttempts || delays.length + 1; // 1 initial + 4 retries = 5 attempts
  const logger = getLogger();

  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options?.signal?.aborted) {
      throw abortError(options.signal);
    }

    try {
      return await operation(attempt);
    } catch (err: any) {
      lastError = err;

      if (options?.signal?.aborted) {
        throw abortError(options.signal);
      }

      if (!isTransientError(err)) {
        logger.warn(
          { attempt, error: err.message, status: err.status || err.statusCode },
          'Encountered non-retryable provider error'
        );
        throw err;
      }

      if (attempt >= maxAttempts) {
        logger.error(
          { totalAttempts: maxAttempts, error: err.message },
          'Provider retry attempts exhausted'
        );
        throw err;
      }

      const retryAfterMs = extractRetryAfterMs(err);
      const maxDelayMs = options?.maxDelayMs ?? MAX_PROVIDER_RETRY_DELAY_MS;
      if (retryAfterMs !== null && retryAfterMs > maxDelayMs) {
        logger.warn(
          { attempt, retryAfterMs, maxDelayMs, error: err.message },
          'Provider Retry-After exceeds maximum allowed delay'
        );
        const error = new NonRetryableError(
          `Provider retry-after delay (${retryAfterMs}ms) exceeds maximum allowed delay (${maxDelayMs}ms): ${err.message}`
        );
        (error as any).status = err.status || err.statusCode;
        (error as any).headers = err.headers;
        throw error;
      }
      let delayMs = Math.min(retryAfterMs !== null ? retryAfterMs : delays[attempt - 1] || 20000, maxDelayMs);

      if (options?.jitter !== false) {
        // Add up to ±10% jitter
        const jitter = (Math.random() * 0.2 - 0.1) * delayMs;
        delayMs = Math.min(maxDelayMs, Math.max(100, Math.round(delayMs + jitter)));
      }

      logger.info(
        { attempt, nextAttempt: attempt + 1, delayMs, error: err.message },
        'Transient provider error, scheduling retry'
      );

      await waitForRetryDelay(delayMs, options?.signal);
    }
  }

  throw lastError;
}
