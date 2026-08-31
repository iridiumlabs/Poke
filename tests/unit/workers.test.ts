import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkerManager, MAX_CONCURRENT_WORKERS } from '../../src/workers/worker-manager.js';
import { PokeDatabase } from '../../src/db/database.js';
import { ConfigManager } from '../../src/config/config.js';
import { ExaToolHandler } from '../../src/tools/exa.js';
import { SupermemoryToolHandler } from '../../src/tools/supermemory.js';
import { ComposioToolHandler } from '../../src/tools/composio.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { WorkerRunner } from '../../src/workers/worker-runner.js';

describe('WorkerManager', () => {
  let tempDir: string;
  let db: PokeDatabase;
  let config: ConfigManager;
  let workerManager: WorkerManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-worker-test-'));
    db = new PokeDatabase(tempDir);
    config = new ConfigManager(tempDir);
    config.setMainModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });

    workerManager = new WorkerManager(
      db,
      config,
      new ExaToolHandler(),
      new SupermemoryToolHandler(),
      new ComposioToolHandler(),
      new SkillRegistry(path.join(tempDir, 'skills'))
    );
  });

  afterEach(() => {
    workerManager.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('runs up to 4 concurrent workers and queues the 5th', async () => {
    const jobs = [];
    for (let i = 1; i <= 6; i++) {
      const job = await workerManager.startJob({
        name: `job-${i}`,
        instruction: `Execute task ${i}`,
      });
      jobs.push(job);
    }

    expect(jobs.length).toBe(6);

    // Initial check: all 6 were created and queued in DB
    const list = workerManager.listJobs();
    expect(list.length).toBe(6);

    // After processing, at most 4 are running concurrently
    const running = db.getRunningWorkerJobs();
    const queued = db.getQueuedWorkerJobs();

    expect(running.length).toBeLessThanOrEqual(MAX_CONCURRENT_WORKERS);
    expect(queued.length).toBeGreaterThanOrEqual(1);
  });

  it('dispatches structured completion signal exactly once', async () => {
    const dispatchedSignals: string[] = [];
    workerManager.setCompletionDispatcher(async (signal) => {
      dispatchedSignals.push(signal);
    });

    const job = await workerManager.startJob({
      name: 'research-task',
      instruction: 'Exhaustively check pricing information.',
    });

    // Wait a brief tick for completion
    await new Promise((r) => setTimeout(r, 100));

    const updated = db.getWorkerJob(job.id);
    expect(updated).not.toBeNull();
    if (updated?.status === 'completed') {
      expect(dispatchedSignals.length).toBe(1);
      expect(dispatchedSignals[0]).toContain('<worker_completion');
      expect(dispatchedSignals[0]).toContain(`id="${job.id}"`);
      expect(dispatchedSignals[0]).toContain('name="research-task"');
      expect(updated.completion_dispatched_at).not.toBeNull();
    }
  });

  it('cancels queued or running job on request', async () => {
    const job = await workerManager.startJob({
      name: 'cancel-me',
      instruction: 'Do long work',
    });

    const cancelled = workerManager.cancelJob(job.id);
    expect(cancelled).toBe(true);

    const updated = db.getWorkerJob(job.id);
    expect(updated?.status).toBe('cancelled');
  });

  it('aborts all running and queued jobs when abortAll is invoked', async () => {
    for (let i = 1; i <= 5; i++) {
      await workerManager.startJob({
        name: `job-abort-${i}`,
        instruction: 'Run task',
      });
    }

    const { abortedCount, cancelledCount } = workerManager.abortAll();
    expect(abortedCount + cancelledCount).toBe(5);

    const running = db.getRunningWorkerJobs();
    const queued = db.getQueuedWorkerJobs();
    expect(running.length).toBe(0);
    expect(queued.length).toBe(0);
  });

  it('reconciles interrupted running jobs on startup recovery', async () => {
    // Manually create a worker in running state (as if daemon crashed mid-execution)
    const crashedJob = db.createWorkerJob({
      id: 'job-crashed-1',
      name: 'crashed-job',
      instruction: 'Do heavy work',
      status: 'running',
    });

    expect(db.getRunningWorkerJobs().length).toBe(1);

    // Run startup reconciliation
    workerManager.reconcileStartupJobs();

    const updated = db.getWorkerJob(crashedJob.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.error).toContain('Worker interrupted by daemon restart');
    expect(db.getRunningWorkerJobs().length).toBe(0);
  });

  it('persists a terminal worker outcome even when no completion dispatcher is attached', async () => {
    vi.spyOn(WorkerRunner.prototype, 'run').mockResolvedValue({
      status: 'completed',
      result: 'Finished without an agent dispatcher.',
    });

    const job = await workerManager.startJob({
      name: 'durable-result',
      instruction: 'Complete this task.',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const updated = db.getWorkerJob(job.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.result).toBe('Finished without an agent dispatcher.');
    expect(updated?.completion_dispatched_at).toBeNull();
  });

  it('releases a worker slot when the runner reports an abort', async () => {
    vi.spyOn(WorkerRunner.prototype, 'run').mockResolvedValue({ status: 'aborted' });

    const job = await workerManager.startJob({
      name: 'self-aborted',
      instruction: 'Abort this task.',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(db.getWorkerJob(job.id)?.status).toBe('aborted');
    expect(db.getRunningWorkerJobs()).toHaveLength(0);
  });

  it('retries an undelivered startup completion and escapes worker-controlled XML', async () => {
    const dispatched: string[] = [];
    workerManager.setCompletionDispatcher(async (signal) => {
      dispatched.push(signal);
    });
    const crashedJob = db.createWorkerJob({
      id: 'job-"<&',
      name: 'crashed "worker" & task',
      instruction: 'Do heavy work',
      status: 'running',
    });

    workerManager.reconcileStartupJobs();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updated = db.getWorkerJob(crashedJob.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.completion_dispatched_at).not.toBeNull();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain('id="job-&quot;&lt;&amp;"');
    expect(dispatched[0]).toContain('name="crashed &quot;worker&quot; &amp; task"');
  });
});
