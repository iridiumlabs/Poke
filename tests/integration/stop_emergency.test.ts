import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PokeDaemon } from '../../src/daemon/daemon.js';

describe('Integration: Out-of-band /stop Emergency Brake', () => {
  let tempDir: string;
  let daemon: PokeDaemon;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-stop-test-'));
    daemon = new PokeDaemon(tempDir);
    const config = daemon.getConfigManager();
    config.setOwnerPhoneNumber('923001234567');
    config.updateCredentials({
      commandCodeApiKey: 'cmd-test-key',
      exaApiKey: 'exa-test-key',
      deepgramApiKey: 'dg-test-key',
    });
    config.setMainModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('aborts main agent, running workers, and cancels queued workers upon exact /stop', async () => {
    const workerManager = daemon.getWorkerManager();
    const db = daemon.getDatabase();

    // Start 2 running workers and 2 queued workers
    await workerManager.startJob({ name: 'w-1', instruction: 'Work 1' });
    await workerManager.startJob({ name: 'w-2', instruction: 'Work 2' });
    await workerManager.startJob({ name: 'w-3', instruction: 'Work 3' });
    await workerManager.startJob({ name: 'w-4', instruction: 'Work 4' });
    await workerManager.startJob({ name: 'w-5', instruction: 'Work 5' });

    // Trigger /stop via incoming WhatsApp message
    const gateway = daemon.getGateway();
    let directNoticeSent = '';
    vi.spyOn(gateway.getSender(), 'sendDirectNotice').mockImplementation(async (msg) => {
      directNoticeSent = msg;
    });

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'stop-msg' },
      message: { conversation: '/stop' },
    });

    expect(directNoticeSent).toBe('Stopped.');

    // Verify all active jobs are aborted/cancelled in SQLite
    const running = db.getRunningWorkerJobs();
    const queued = db.getQueuedWorkerJobs();

    expect(running.length).toBe(0);
    expect(queued.length).toBe(0);

    const allJobs = db.listWorkerJobs();
    for (const j of allJobs) {
      expect(['aborted', 'cancelled', 'completed', 'failed']).toContain(j.status);
    }
  });

  it('leaves stop, /stop now, and captions as normal messages', async () => {
    const gateway = daemon.getGateway();
    const runtime = daemon.getRuntime();
    const dispatchSpy = vi.spyOn(runtime, 'dispatchUserMessage').mockResolvedValue({} as any);

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-1' },
      message: { conversation: 'stop' },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-2' },
      message: { conversation: '/stop now' },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(2);

    await gateway.handleIncomingMessage({
      key: { remoteJid: '923001234567@s.whatsapp.net', id: 'm-3' },
      message: { imageMessage: { caption: 'Please /stop here' } as any },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(3);
  });
});
