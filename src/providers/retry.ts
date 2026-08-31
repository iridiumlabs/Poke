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

export function isTransientError(error: any): boolean {
  if (error instanceof NonRetryableError) {
    return false;
  }

  const status = error.status || error.statusCode || error.response?.status;
  if (status) {
    // 429 Too Many Requests, 5xx Server Errors are transient
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
    // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, etc. are NOT transient
    if (status >= 400 && status < 500) {
      return false;
    }
  }

  // Network / connection errors
  const code = error.code || error.cause?.code;
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

  const msg = (error.message || '').toLowerCase();
  if (
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('timeout') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout') ||
    msg.includes('bad gateway') ||
    msg.includes('temporarily unavailable')
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
