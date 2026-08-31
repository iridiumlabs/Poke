import fs from 'fs';
import path from 'path';
import { resolvePokePaths } from '../config/paths.js';
import { redactSecrets } from '../logger/logger.js';

const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

function printLogLine(line: string): void {
  if (!line) return;

  try {
    const safe = redactSecrets(JSON.parse(line));
    const time = safe.time || new Date().toISOString();
    const level = safe.level ? (safe.level >= 50 ? 'ERROR' : safe.level >= 40 ? 'WARN' : 'INFO') : 'INFO';
    console.log(`[${time}] [${level}] ${safe.msg || ''}`);
  } catch {
    console.log(redactSecrets(line));
  }
}

export function readLogTail(logFile: string, requestedLines: number): string[] {
  const lineCount = Math.max(1, Math.floor(requestedLines) || 100);
  const stat = fs.statSync(logFile);
  if (stat.size === 0) return [];

  const fd = fs.openSync(logFile, 'r');
  const chunks: Buffer[] = [];
  let position = stat.size;
  let bytesRead = 0;
  let newlines = 0;

  try {
    while (position > 0 && bytesRead < MAX_TAIL_BYTES && newlines <= lineCount) {
      const length = Math.min(TAIL_CHUNK_BYTES, position, MAX_TAIL_BYTES - bytesRead);
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, position - length);
      chunks.unshift(chunk);
      position -= length;
      bytesRead += length;

      for (const byte of chunk) {
        if (byte === 10) newlines += 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-lineCount);
}

function readLogRange(logFile: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(logFile, { start, end });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function signature(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

export async function runLogs(options: { follow?: boolean; lines?: number }, customHome?: string): Promise<void> {
  const paths = resolvePokePaths(customHome);
  const logFile = path.join(paths.logsDir, 'poke.log');

  if (!fs.existsSync(logFile)) {
    console.log(`No log file found at ${logFile}`);
    return;
  }

  const numLines = Math.max(1, Math.floor(options.lines || 100));
  for (const line of readLogTail(logFile, numLines)) {
    printLogLine(line);
  }

  if (!options.follow) return;

  console.log('\n--- Following log output (Ctrl+C to stop) ---\n');
  const initialStat = fs.statSync(logFile);
  let currentSize = initialStat.size;
  let currentSignature = signature(initialStat);
  let partialLine = '';
  let reading = false;
  let pending = false;

  const readUpdates = async (): Promise<void> => {
    if (reading) {
      pending = true;
      return;
    }

    reading = true;
    try {
      do {
        pending = false;
        let nextStat: fs.Stats;
        try {
          nextStat = fs.statSync(logFile);
        } catch {
          continue;
        }

        const nextSignature = signature(nextStat);
        if (nextSignature !== currentSignature || nextStat.size < currentSize) {
          currentSize = 0;
          currentSignature = nextSignature;
          partialLine = '';
        }

        if (nextStat.size <= currentSize) continue;

        const start = currentSize;
        const end = nextStat.size - 1;
        currentSize = nextStat.size;
        const appended = await readLogRange(logFile, start, end);
        const lines = `${partialLine}${appended}`.split(/\r?\n/);
        partialLine = lines.pop() || '';
        for (const line of lines) {
          printLogLine(line);
        }
      } while (pending);
    } catch {
      // A rotation can race the read. The directory watcher will schedule the next pass.
    } finally {
      reading = false;
    }
  };

  // A rotated log replaces its inode, so watch the directory rather than the file.
  const watcher = fs.watch(paths.logsDir, (_event, filename) => {
    if (!filename || filename.toString() === path.basename(logFile)) {
      void readUpdates();
    }
  });

  process.once('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}
