import net from 'node:net';
import fs from 'node:fs';
import { PokeRuntime } from '../agent/runtime.js';
import { CompactionManager } from '../context/compaction-manager.js';
import { getLogger } from '../logger/logger.js';

export interface DaemonIpcRequest {
  command: string;
  [key: string]: unknown;
}

export interface DaemonIpcResponse {
  success: boolean;
  busy?: boolean;
  beforeTokens?: number;
  afterTokens?: number;
  error?: string;
  [key: string]: unknown;
}

export class DaemonIpcServer {
  private server: net.Server | null = null;
  private isListening = false;

  constructor(
    private socketFile: string,
    private runtime: PokeRuntime,
    private compactionManager: CompactionManager
  ) {}

  async start(): Promise<void> {
    if (this.isListening) return;

    if (fs.existsSync(this.socketFile)) {
      try {
        fs.unlinkSync(this.socketFile);
      } catch (err: any) {
        getLogger().warn({ socketFile: this.socketFile, err: err?.message }, 'Failed to remove old socket file');
      }
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let req: DaemonIpcRequest;
            try {
              req = JSON.parse(trimmed);
            } catch (err: any) {
              socket.write(JSON.stringify({ success: false, error: `Invalid JSON: ${err?.message}` }) + '\n');
              socket.end();
              continue;
            }
            void this.handleCommand(req, socket);
          }
        });
      });

      server.on('error', (err) => {
        getLogger().error({ err: err?.message }, 'Daemon IPC server error');
        if (!this.isListening) {
          reject(err);
        }
      });

      server.listen(this.socketFile, () => {
        this.server = server;
        this.isListening = true;
        try {
          if (process.platform !== 'win32') {
            fs.chmodSync(this.socketFile, 0o600);
          }
        } catch {}
        getLogger().info({ socketFile: this.socketFile }, 'Daemon IPC server listening');
        resolve();
      });
    });
  }

  private async handleCommand(req: DaemonIpcRequest, socket: net.Socket): Promise<void> {
    if (req.command === 'compact') {
      if (this.compactionManager.isBusy()) {
        socket.write(
          JSON.stringify({
            success: false,
            busy: true,
            error: 'Main agent is currently busy processing a turn.',
          }) + '\n'
        );
        socket.end();
        return;
      }

      try {
        const result = await this.runtime.compactMainConversation('manual');
        socket.write(
          JSON.stringify({
            success: true,
            beforeTokens: result.beforeTokens,
            afterTokens: result.afterTokens,
          }) + '\n'
        );
      } catch (err: any) {
        socket.write(
          JSON.stringify({
            success: false,
            error: err?.message || String(err),
          }) + '\n'
        );
      } finally {
        socket.end();
      }
      return;
    }

    socket.write(JSON.stringify({ success: false, error: `Unknown command: ${req.command}` }) + '\n');
    socket.end();
  }

  async stop(): Promise<void> {
    if (!this.isListening && !this.server) return;
    this.isListening = false;

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          try {
            if (fs.existsSync(this.socketFile)) {
              fs.unlinkSync(this.socketFile);
            }
          } catch {}
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

export async function sendDaemonCommand(
  socketFile: string,
  request: DaemonIpcRequest,
  timeoutMs = 60000
): Promise<DaemonIpcResponse> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const socket = net.createConnection(socketFile);

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        reject(new Error('Timed out waiting for response from Poke daemon'));
      }
    }, timeoutMs);

    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(line);
            resolve(parsed);
          } catch (err: any) {
            reject(new Error(`Malformed response from daemon: ${err?.message}`));
          } finally {
            socket.end();
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    socket.on('close', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (buffer.trim()) {
          try {
            resolve(JSON.parse(buffer.trim()));
            return;
          } catch {}
        }
        reject(new Error('Connection to Poke daemon closed unexpectedly'));
      }
    });
  });
}
