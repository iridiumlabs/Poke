import { PokeDatabase, WorkerJobRecord } from '../db/database.js';
import { ConfigManager } from '../config/config.js';
import { ExaToolHandler } from '../tools/exa.js';
import { SupermemoryToolHandler } from '../tools/supermemory.js';
import { ComposioToolHandler } from '../tools/composio.js';
import { SkillRegistry } from '../skills/registry.js';
import { WorkerRunner } from './worker-runner.js';
import { getLogger } from '../logger/logger.js';
import { createWorkerCompletionSignal, SignalPayload } from '../agent/signals.js';
import crypto from 'node:crypto';

export const MAX_CONCURRENT_WORKERS = 4;

export type DispatchSignalFn = (signal: SignalPayload) => Promise<{ submissionId: string }>;

export class WorkerManager {
  private activeRunners = new Map<string, WorkerRunner>();
  private abortedJobIds = new Set<string>();
  private isProcessing = false;
  private isStopped = false;
  private onDispatchCompletion: DispatchSignalFn | null = null;
  private completionDispatches = new Set<string>();
  private retryInterval: NodeJS.Timeout | null = null;

  constructor(
    private db: PokeDatabase,
    private configManager: ConfigManager,
    private exa: ExaToolHandler,
    private supermemory: SupermemoryToolHandler,
    private composio: ComposioToolHandler,
    private skills: SkillRegistry
  ) {
    this.retryInterval = setInterval(() => {
      this.processUndeliveredCompletions();
    }, 5000);
    this.retryInterval.unref?.();
  }

  setCompletionDispatcher(fn: DispatchSignalFn): void {
    this.onDispatchCompletion = fn;
    this.processUndeliveredCompletions();
  }

  stop(): void {
    this.isStopped = true;
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
    for (const [, runner] of this.activeRunners.entries()) {
      runner.abort();
    }
    this.activeRunners.clear();
  }

  async startJob(params: {
    name: string;
    instruction: string;
    cwd?: string;
    idempotencyKey?: string;
  }): Promise<WorkerJobRecord> {
    const id = params.idempotencyKey
      ? `job-${crypto.createHash('sha256').update(params.idempotencyKey).digest('hex').slice(0, 24)}`
      : `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = this.db.getWorkerJob(id);
    if (existing) return existing;
    const record = this.db.createWorkerJob({
      id,
      name: params.name,
      instruction: params.instruction,
      cwd: params.cwd,
      status: 'queued',
    });

    const logger = getLogger();
    logger.info({ jobId: id, jobName: params.name }, 'Queued new worker job');

    // Trigger queue processor asynchronously
    if (!this.isStopped && this.db.isOpen()) {
      setTimeout(() => {
        if (!this.isStopped && this.db.isOpen()) {
          this.processQueue();
        }
      }, 0);
    }

    return record;
  }

  processUndeliveredCompletions(): void {
    if (this.isStopped || !this.db.isOpen() || !this.onDispatchCompletion) return;
    const undelivered = this.db.getUndeliveredFinishedWorkerJobs();
    for (const job of undelivered) {
      void this.dispatchCompletion(job);
    }
  }

  reconcileStartupJobs(): void {
    if (!this.db.isOpen()) return;
    const runningJobs = this.db.getRunningWorkerJobs();
    const logger = getLogger();

    if (runningJobs.length > 0) {
      logger.warn({ count: runningJobs.length }, 'Reattaching running workers after startup');

      for (const job of runningJobs) {
        // WorkerRunner dispatches with a stable key and then reads the durable
        // submission. Re-running it therefore reattaches to Flue recovery (or
        // admits work that had not made it to Flue before the crash) instead of
        // inventing a failed completion while Flue may still be executing.
        void this.runJob(job, true);
      }
    }

    this.processUndeliveredCompletions();
  }

  async processQueue(): Promise<void> {
    if (this.isProcessing || this.isStopped || !this.db.isOpen()) return;
    this.isProcessing = true;

    try {
      this.processUndeliveredCompletions();
      if (!this.db.isOpen()) return;
      const runningJobs = this.db.getRunningWorkerJobs();
      const availableSlots = MAX_CONCURRENT_WORKERS - runningJobs.length;

      if (availableSlots <= 0) {
        return;
      }

      const queuedJobs = this.db.getQueuedWorkerJobs();
      const toStart = queuedJobs.slice(0, availableSlots);

      for (const job of toStart) {
        this.runJob(job);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async runJob(job: WorkerJobRecord, recovering = false): Promise<void> {
    if (this.isStopped || !this.db.isOpen()) return;
    if (this.activeRunners.has(job.id)) return;
    const logger = getLogger().child({ jobId: job.id, jobName: job.name });
    logger.info({ recovering }, recovering ? 'Reattaching worker execution' : 'Assigning slot and starting worker execution');

    if (!recovering) {
      this.db.updateWorkerJob(job.id, {
        status: 'running',
        started_at: Date.now(),
      });
    }

    const runner = new WorkerRunner(
      job,
      this.configManager,
      this.exa,
      this.supermemory,
      this.composio,
      this.skills
    );

    this.activeRunners.set(job.id, runner);

    try {
      const outcome = await runner.run();

      if (this.isStopped || !this.db.isOpen()) {
        this.activeRunners.delete(job.id);
        return;
      }

      if (this.abortedJobIds.has(job.id) || outcome.status === 'aborted') {
        this.activeRunners.delete(job.id);
        this.db.completeWorkerJob(job.id, {
          status: 'aborted',
          result: null,
          error: outcome.error ?? null,
          finished_at: Date.now(),
        });
        return;
      }

      // Check if job was aborted in the database (e.g. by /stop)
      const currentCheck = this.db.getWorkerJob(job.id);
      if (currentCheck?.status === 'aborted' || currentCheck?.status === 'cancelled') {
        logger.info({ jobId: job.id }, 'Job was aborted or cancelled; suppressing completion dispatch');
        this.activeRunners.delete(job.id);
        return;
      }

      const finishedAt = Date.now();
      this.activeRunners.delete(job.id);

      const completed = this.db.completeWorkerJob(job.id, {
        status: outcome.status,
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        finished_at: finishedAt,
      });

      if (completed) {
        const completedJob = this.db.getWorkerJob(job.id);
        if (completedJob) {
          await this.dispatchCompletion(completedJob);
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Unexpected error in worker runner');
      if (this.db.isOpen()) {
        const check = this.db.getWorkerJob(job.id);
        if (check && check.status !== 'aborted' && check.status !== 'cancelled') {
          this.db.completeWorkerJob(job.id, {
            status: 'failed',
            result: null,
            error: err.message,
            finished_at: Date.now(),
          });
        }
      }
      this.activeRunners.delete(job.id);
    } finally {
      // Pick up next queued job
      if (!this.isStopped && this.db.isOpen()) {
        setTimeout(() => {
          if (!this.isStopped && this.db.isOpen()) {
            this.processQueue();
          }
        }, 0);
      }
    }
  }

  private async dispatchCompletion(job: WorkerJobRecord, retryAttempt = 0): Promise<void> {
    if (
      !this.onDispatchCompletion ||
      !this.db.isOpen() ||
      job.completion_dispatched_at ||
      job.status === 'aborted' ||
      job.status === 'cancelled' ||
      this.completionDispatches.has(job.id)
    ) {
      return;
    }

    this.completionDispatches.add(job.id);
    const logger = getLogger().child({ jobId: job.id, jobName: job.name });

    try {
      const receipt = await this.onDispatchCompletion(
        createWorkerCompletionSignal({
          id: job.id,
          status: job.status,
          name: job.name,
          body: job.result || job.error || 'Job completed.',
        })
      );
      if (this.db.isOpen()) {
        this.db.markWorkerCompletionDispatched(job.id, receipt.submissionId);
      }
      logger.info('Dispatched worker completion signal to main agent');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to dispatch worker completion signal');
      if (retryAttempt < 3 && !this.isStopped) {
        setTimeout(() => {
          if (!this.isStopped && this.db.isOpen()) {
            const currentJob = this.db.getWorkerJob(job.id);
            if (currentJob && !currentJob.completion_dispatched_at) {
              void this.dispatchCompletion(currentJob, retryAttempt + 1);
            }
          }
        }, Math.min(1000 * (retryAttempt + 1), 5000));
      }
    } finally {
      this.completionDispatches.delete(job.id);
    }
  }

  cancelJob(id: string): boolean {
    if (!this.db.isOpen()) return false;
    const job = this.db.getWorkerJob(id);
    if (!job) return false;

    if (job.status === 'running') {
      const runner = this.activeRunners.get(id);
      if (runner) {
        runner.abort();
        this.activeRunners.delete(id);
      }
      this.db.updateWorkerJob(id, {
        status: 'cancelled',
        finished_at: Date.now(),
      });
      if (!this.isStopped && this.db.isOpen()) {
        setTimeout(() => this.processQueue(), 0);
      }
      return true;
    }

    if (job.status === 'queued') {
      this.db.updateWorkerJob(id, {
        status: 'cancelled',
        finished_at: Date.now(),
      });
      return true;
    }

    return false;
  }

  abortAll(): { abortedCount: number; cancelledCount: number } {
    for (const [id, runner] of this.activeRunners.entries()) {
      this.abortedJobIds.add(id);
      runner.abort();
    }
    this.activeRunners.clear();

    if (!this.db.isOpen()) return { abortedCount: 0, cancelledCount: 0 };
    const { abortedIds, cancelledIds } = this.db.abortAllActiveWorkerJobs();
    for (const id of abortedIds) {
      this.abortedJobIds.add(id);
    }
    for (const id of cancelledIds) {
      this.abortedJobIds.add(id);
    }
    getLogger().info(
      { abortedCount: abortedIds.length, cancelledCount: cancelledIds.length },
      'Aborted all running and cancelled all queued workers'
    );

    return {
      abortedCount: abortedIds.length,
      cancelledCount: cancelledIds.length,
    };
  }

  listJobs(limit = 50): WorkerJobRecord[] {
    if (!this.db.isOpen()) return [];
    return this.db.listWorkerJobs(limit);
  }

  getJob(id: string): WorkerJobRecord | null {
    if (!this.db.isOpen()) return null;
    return this.db.getWorkerJob(id);
  }
}
