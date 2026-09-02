import { redactSecrets } from '../logger/logger.js';

export const MAX_ERROR_DETAIL_LENGTH = 600;

/**
 * Sanitizes, normalizes whitespace, redacts secrets, and bounds error details or messages to 600 characters.
 */
export function boundedErrorDetail(error: unknown, fallback = ''): string {
  if (error === null || error === undefined) {
    return fallback;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = String(redactSecrets(raw))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > MAX_ERROR_DETAIL_LENGTH) {
    return `${cleaned.slice(0, MAX_ERROR_DETAIL_LENGTH - 3)}...`;
  }
  return cleaned || fallback;
}

export function compactErrorMessage(error: unknown, fallback = 'Unknown error.'): string {
  return boundedErrorDetail(error, fallback);
}
