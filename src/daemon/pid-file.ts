import fs from 'node:fs';
import path from 'node:path';

export interface DaemonPidRecord {
  pid: number;
  startTime?: string;
}

export function sameDaemonPidRecord(a: DaemonPidRecord, b: DaemonPidRecord): boolean {
  return a.pid === b.pid && a.startTime === b.startTime;
}

function isValidPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function readDaemonPidFile(pidFile: string): DaemonPidRecord | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
      const pid = Number(raw);
      return isValidPid(pid) ? { pid } : null;
    }

    const parsed = JSON.parse(raw) as { pid?: unknown; startTime?: unknown };
    if (!isValidPid(parsed.pid)) return null;

    return {
      pid: parsed.pid,
      ...(typeof parsed.startTime === 'string' ? { startTime: parsed.startTime } : {}),
    };
  } catch {
    return null;
  }
}

export function getProcessStartTime(pid: number): string | null {
  if (process.platform !== 'linux') return null;

  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return null;

    // Fields after the command begin at field 3; start time is field 22.
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[19] || null;
  } catch {
    return null;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function getProcessArgs(pid: number): string[] | null {
  if (process.platform !== 'linux') return null;

  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function matchesEntrypoint(value: string, expectedEntrypoint: string): boolean {
  try {
    return path.resolve(value) === path.resolve(expectedEntrypoint);
  } catch {
    return false;
  }
}

export function isLivePokeDaemon(record: DaemonPidRecord, expectedEntrypoint: string): boolean {
  if (!isProcessRunning(record.pid)) return false;

  if (record.startTime && getProcessStartTime(record.pid) !== record.startTime) {
    return false;
  }

  const args = getProcessArgs(record.pid);
  if (!args) {
    return process.platform !== 'linux' ? isProcessRunning(record.pid) : false;
  }

  return (
    args.some((arg) => matchesEntrypoint(arg, expectedEntrypoint)) &&
    args.includes('start') &&
    args.includes('--foreground')
  );
}

export function claimDaemonPidFile(pidFile: string, expectedEntrypoint: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = readDaemonPidFile(pidFile);
    if (existing && isLivePokeDaemon(existing, expectedEntrypoint)) {
      throw new Error(`Poke daemon is already running (PID: ${existing.pid}).`);
    }

    try {
      fs.unlinkSync(pidFile);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const record: DaemonPidRecord = {
      pid: process.pid,
      ...(getProcessStartTime(process.pid) ? { startTime: getProcessStartTime(process.pid)! } : {}),
    };

    try {
      fs.writeFileSync(pidFile, JSON.stringify(record), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }

  throw new Error('Could not claim the Poke daemon PID file.');
}

export function removeOwnedDaemonPidFile(pidFile: string): void {
  const record = readDaemonPidFile(pidFile);
  if (!record || record.pid !== process.pid) return;

  const currentStartTime = getProcessStartTime(process.pid);
  if (record.startTime && currentStartTime !== record.startTime) return;

  try {
    fs.unlinkSync(pidFile);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export function removeDaemonPidFileIfMatches(pidFile: string, expected: DaemonPidRecord): boolean {
  const current = readDaemonPidFile(pidFile);
  if (!current || !sameDaemonPidRecord(current, expected)) return false;

  try {
    fs.unlinkSync(pidFile);
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}
