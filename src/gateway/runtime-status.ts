import fs from 'node:fs';
import path from 'node:path';

export type GatewayRuntimeState = 'connecting' | 'connected' | 'disconnected';

export interface GatewayRuntimeStatus {
  state: GatewayRuntimeState;
  updatedAt: number;
  daemonPid?: number;
  pairedAccount?: string;
  lastConnectedAt?: number;
  reason?: string;
}

export function readGatewayRuntimeStatus(file: string): GatewayRuntimeStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GatewayRuntimeStatus>;
    if (
      !parsed ||
      !['connecting', 'connected', 'disconnected'].includes(parsed.state || '') ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    return {
      state: parsed.state as GatewayRuntimeState,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.daemonPid === 'number' ? { daemonPid: parsed.daemonPid } : {}),
      ...(typeof parsed.pairedAccount === 'string' ? { pairedAccount: parsed.pairedAccount } : {}),
      ...(typeof parsed.lastConnectedAt === 'number' ? { lastConnectedAt: parsed.lastConnectedAt } : {}),
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    };
  } catch {
    return null;
  }
}

export function writeGatewayRuntimeStatus(file: string, status: GatewayRuntimeStatus): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Ignore a failed cleanup of an uncommitted temporary file.
    }
    throw error;
  }
}
