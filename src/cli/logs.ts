import fs from 'fs';
import path from 'path';
import { resolvePokePaths } from '../config/paths.js';
import { redactSecrets } from '../logger/logger.js';

export async function runLogs(options: { follow?: boolean; lines?: number }, customHome?: string): Promise<void> {
  const paths = resolvePokePaths(customHome);
  const logFile = path.join(paths.logsDir, 'poke.log');

  if (!fs.existsSync(logFile)) {
    console.log(`No log file found at ${logFile}`);
    return;
  }

  const numLines = options.lines || 100;
  const content = fs.readFileSync(logFile, 'utf8');
  const allLines = content.trim().split('\n');
  const tailLines = allLines.slice(-numLines);

  for (const line of tailLines) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      const safe = redactSecrets(parsed);
      const time = safe.time || new Date().toISOString();
      const level = safe.level ? (safe.level >= 50 ? 'ERROR' : safe.level >= 40 ? 'WARN' : 'INFO') : 'INFO';
      const msg = safe.msg || '';
      console.log(`[${time}] [${level}] ${msg}`);
    } catch {
      console.log(redactSecrets(line));
    }
  }

  if (options.follow) {
    console.log('\n--- Following log output (Ctrl+C to stop) ---\n');
    let currentSize = fs.statSync(logFile).size;

    const watcher = fs.watch(logFile, () => {
      try {
        const newStat = fs.statSync(logFile);
        if (newStat.size > currentSize) {
          const stream = fs.createReadStream(logFile, {
            start: currentSize,
            end: newStat.size,
          });
          stream.on('data', (chunk) => {
            const lines = chunk.toString().trim().split('\n');
            for (const line of lines) {
              if (!line) continue;
              try {
                const parsed = JSON.parse(line);
                const safe = redactSecrets(parsed);
                const time = safe.time || new Date().toISOString();
                const level = safe.level ? (safe.level >= 50 ? 'ERROR' : safe.level >= 40 ? 'WARN' : 'INFO') : 'INFO';
                const msg = safe.msg || '';
                console.log(`[${time}] [${level}] ${msg}`);
              } catch {
                console.log(redactSecrets(line));
              }
            }
          });
          currentSize = newStat.size;
        }
      } catch {
        // File may be rotated
      }
    });

    process.on('SIGINT', () => {
      watcher.close();
      process.exit(0);
    });
  }
}
