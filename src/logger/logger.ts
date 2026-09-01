import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import { resolvePokePaths, ensurePokeDirectories } from '../config/paths.js';

export const DEFAULT_MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
export const DEFAULT_MAX_LOG_FILES = 5;

export class BoundedLogStream extends Writable {
  private currentSize = 0;
  private fd: number | null = null;

  constructor(
    private logFile: string,
    private maxSize: number = DEFAULT_MAX_LOG_SIZE,
    private maxFiles: number = DEFAULT_MAX_LOG_FILES
  ) {
    super();
    this.openFile();
  }

  private openFile(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }

    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.logFile)) {
      try {
        this.currentSize = fs.statSync(this.logFile).size;
        if (this.currentSize >= this.maxSize) {
          this.rotate();
        }
      } catch {
        this.currentSize = 0;
      }
    } else {
      this.currentSize = 0;
    }

    try {
      this.fd = fs.openSync(this.logFile, 'a');
    } catch {
      this.fd = null;
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }

    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = `${this.logFile}.${i}`;
      const dest = `${this.logFile}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i === this.maxFiles - 1) {
          try {
            fs.unlinkSync(src);
          } catch {}
        } else {
          try {
            fs.renameSync(src, dest);
          } catch {}
        }
      }
    }

    if (fs.existsSync(this.logFile)) {
      try {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      } catch {}
    }

    this.currentSize = 0;
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (this.currentSize + buffer.length > this.maxSize) {
        this.rotate();
        this.openFile();
      } else if (this.fd === null) {
        this.openFile();
      }

      if (this.fd !== null) {
        fs.writeSync(this.fd, buffer, 0, buffer.length);
        this.currentSize += buffer.length;
      }
      callback();
    } catch (err: any) {
      callback(err);
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
    callback();
  }
}

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
    // Errors often carry a provider's response text. Remove common
    // authorization forms before the value reaches logs, status, or WhatsApp.
    let cleaned = obj.replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');
    cleaned = cleaned.replace(/(?:sk-|dg-|fw-|cm_)[A-Za-z0-9_\-]{16,}/gi, '[REDACTED_KEY]');
    cleaned = cleaned.replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token)=)[^&#\s]+/gi,
      '$1[REDACTED]'
    );
    cleaned = cleaned.replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token)\s*([=:])\s*["']?[^,\s"']+/gi,
      '$1$2[REDACTED]'
    );
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

function redactLogError(value: unknown): unknown {
  const serialized = value instanceof Error ? pino.stdSerializers.err(value) : value;
  return redactSecrets(serialized);
}

let rootLogger: pino.Logger | null = null;

export function resetLoggerForTesting(): void {
  rootLogger = null;
}

export function getLogger(customHome?: string): pino.Logger {
  if (rootLogger) {
    return rootLogger;
  }

  const paths = resolvePokePaths(customHome);
  ensurePokeDirectories(paths);

  const logFile = path.join(paths.logsDir, 'poke.log');
  const fileStream = new BoundedLogStream(logFile);

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
        err: redactLogError,
        error: redactLogError,
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
