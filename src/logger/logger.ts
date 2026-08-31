import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { resolvePokePaths, ensurePokeDirectories } from '../config/paths.js';

export const SENSITIVE_KEYS = [
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'authorization',
  'password',
  'secret',
  'token',
  'composioApiKey',
  'supermemoryApiKey',
  'exaApiKey',
  'deepgramApiKey',
  'fireworksApiKey',
  'commandCodeApiKey',
];

export function redactSecrets(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Redact Bearer tokens and potential API keys in strings
    let cleaned = obj.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]');
    cleaned = cleaned.replace(/(?:sk-|dg-|fw-|cm_)[A-Za-z0-9_\-]{16,}/gi, '[REDACTED_KEY]');
    return cleaned;
  }
  if (Array.isArray(obj)) {
    return obj.map(redactSecrets);
  }
  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s.toLowerCase()))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSecrets(value);
      }
    }
    return result;
  }
  return obj;
}

let rootLogger: pino.Logger | null = null;

export function getLogger(customHome?: string): pino.Logger {
  if (rootLogger) {
    return rootLogger;
  }

  const paths = resolvePokePaths(customHome);
  ensurePokeDirectories(paths);

  const logFile = path.join(paths.logsDir, 'poke.log');

  const fileStream = pino.destination({
    dest: logFile,
    sync: false,
    mkdir: true,
  });

  const redactPaths = SENSITIVE_KEYS.map((k) => `*.${k}`);
  redactPaths.push(...SENSITIVE_KEYS.map((k) => `*.credentials.${k}`));
  redactPaths.push(...SENSITIVE_KEYS);

  rootLogger = pino(
    {
      level: process.env.POKE_LOG_LEVEL || 'info',
      redact: {
        paths: redactPaths,
        censor: '[REDACTED]',
      },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    fileStream
  );

  return rootLogger;
}

export interface LogContext {
  whatsappMessageId?: string;
  submissionId?: string;
  jobId?: string;
  automationId?: string;
  providerCallId?: string;
  [key: string]: any;
}

export function createChildLogger(context: LogContext, customHome?: string): pino.Logger {
  const base = getLogger(customHome);
  return base.child(context);
}
