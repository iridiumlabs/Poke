import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PokeDaemon } from '../../src/daemon/daemon.js';
import { runCompact } from '../../src/cli/compact.js';
import { getMobileStatusText } from '../../src/cli/status.js';

describe('Integration: Manual Compaction, WhatsApp /compact, and /status', () => {
  let tempDir: string;
  let daemon: PokeDaemon;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-compact-integ-test-'));
    daemon = new PokeDaemon(tempDir);
    const config = daemon.getConfigManager();
    config.setOwnerPhoneNumber('923001234567');
    config.updateCredentials({
      commandCodeApiKey: 'cmd-test-key',
      exaApiKey: 'exa-test-key',
      deepgramApiKey: 'dg-test-key',
      groqApiKey: 'groq-test-key',
    });
    config.setMainModel({ provider: 'commandcode', model: 'z-ai/glm-5.3-flash' });
    config.setWorkerModel({ provider: 'commandcode', model: 'z-ai/glm-5.3-flash' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('handles WhatsApp /compact out-of-band without invoking model turn', async () => {
    const runtime = daemon.getRuntime();
    const compactionManager = daemon.getCompactionManager();
    compactionManager.setEstimatedTokens(150000);

    const compactSpy = vi.spyOn(runtime, 'compactMainConversation').mockResolvedValue({
      beforeTokens: 150000,
      afterTokens: 20000,
      compacted: true,
    });
    const dispatchSpy = vi.spyOn(runtime, 'dispatchUserMessage').mockResolvedValue({} as any);

    const gateway = daemon.getGateway();
    let noticeSent = '';
    vi.spyOn(gateway.getSender(), 'sendDirectNotice').mockImplementation(async (msg) => {
      noticeSent = msg;
    });

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'compact-msg-1' },
      message: { conversation: '/compact' },
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(compactSpy).toHaveBeenCalledWith('manual');
    expect(noticeSent).toContain('Compacted.');
    expect(noticeSent).toContain('Context: ~150,000 → ~20,000 tokens');
  });

  it('rejects WhatsApp /compact when main agent is busy with an active turn', async () => {
    const runtime = daemon.getRuntime();
    const compactionManager = daemon.getCompactionManager();
    compactionManager.setMainAgentBusy(true);

    const compactSpy = vi.spyOn(runtime, 'compactMainConversation');
    const gateway = daemon.getGateway();
    let noticeSent = '';
    vi.spyOn(gateway.getSender(), 'sendDirectNotice').mockImplementation(async (msg) => {
      noticeSent = msg;
    });

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'compact-msg-2' },
      message: { conversation: '/compact' },
    });

    expect(compactSpy).not.toHaveBeenCalled();
    expect(noticeSent).toContain('Main agent is busy with an active turn.');
  });

  it('handles WhatsApp /status out-of-band as read-only without mutating activity or invoking model', async () => {
    const runtime = daemon.getRuntime();
    const compactionManager = daemon.getCompactionManager();
    const pastActivity = Date.now() - 15 * 60 * 1000;
    compactionManager.setLastActivityTime(pastActivity);
    compactionManager.setEstimatedTokens(125000);

    const dispatchSpy = vi.spyOn(runtime, 'dispatchUserMessage').mockResolvedValue({} as any);
    const gateway = daemon.getGateway();
    let statusNotice = '';
    vi.spyOn(gateway.getSender(), 'sendDirectNotice').mockImplementation(async (msg) => {
      statusNotice = msg;
    });

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'status-msg-1' },
      message: { conversation: '/status' },
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(statusNotice).toContain('*Poke Status*');
    expect(statusNotice).toContain('• Context: ~125,000 tokens');
    expect(statusNotice).toContain('• Active Threshold: 272,000 tokens');
    expect(statusNotice).toContain('• Idle Threshold: 100,000 tokens (after 30m)');
    expect(statusNotice).toContain('• State: Idle');
    expect(statusNotice).toContain('• Main: commandcode / z-ai/glm-5.3-flash');

    // Must not touch last activity time or tokens
    expect(compactionManager.getLastActivityTime()).toBe(pastActivity);
    expect(compactionManager.getEstimatedTokens()).toBe(125000);
  });

  it('poke compact CLI communicates with daemon IPC socket and reports result', async () => {
    const runtime = daemon.getRuntime();
    const compactionManager = daemon.getCompactionManager();
    compactionManager.setEstimatedTokens(180000);

    vi.spyOn(runtime, 'compactMainConversation').mockImplementation(async () => {
      compactionManager.setEstimatedTokens(20000);
      return {
        beforeTokens: 180000,
        afterTokens: 20000,
        compacted: true,
      };
    });

    // Start daemon so IPC socket is active
    const lifecycle = await import('../../src/cli/lifecycle.js');
    vi.spyOn(lifecycle, 'isDaemonRunning').mockReturnValue(true);

    const paths = (daemon as any).configManager.getPaths();
    const { DaemonIpcServer } = await import('../../src/daemon/ipc.js');
    const ipcServer = new DaemonIpcServer(paths.socketFile, runtime, compactionManager);
    await ipcServer.start();

    const consoleLogs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      consoleLogs.push(args.join(' '));
    });

    try {
      await runCompact(tempDir);
      const output = consoleLogs.join('\n');
      expect(output).toContain('✓ Main conversation compacted successfully.');
      expect(output).toContain('Context: ~180,000 → ~20,000 tokens');
    } finally {
      logSpy.mockRestore();
      await ipcServer.stop();
    }
  });

  it('poke compact CLI reports error when daemon is not running', async () => {
    const errorLogs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      errorLogs.push(args.join(' '));
    });

    try {
      await runCompact(tempDir);
      expect(errorLogs.join('\n')).toContain('Error: Poke daemon is not running.');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('owner conversation compaction does not affect running worker jobs', async () => {
    const db = daemon.getDatabase();
    const compactionManager = daemon.getCompactionManager();

    db.createWorkerJob({
      id: 'job-1',
      name: 'worker-a',
      instruction: 'Do work A',
      status: 'running',
    });
    expect(db.getRunningWorkerJobs().length).toBe(1);

    // Compacting owner conversation
    compactionManager.onCompactionSuccess(20000);

    // Worker remains running
    expect(db.getRunningWorkerJobs().length).toBe(1);
    const job = db.getRunningWorkerJobs()[0];
    expect(job.name).toBe('worker-a');
    expect(job.status).toBe('running');
  });
});
