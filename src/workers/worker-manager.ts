import { PokeDatabase, WorkerJobRecord } from '../db/database.js';
import { ConfigManager } from '../config/config.js';
import { ExaToolHandler } from '../tools/exa.js';
import { SupermemoryToolHandler } from '../tools/supermemory.js';
import { ComposioToolHandler } from '../tools/composio.js';
import { SkillRegistry } from '../skills/registry.js';
import { WorkerRunner } from './worker-runner.js';
import { getLogger } from '../logger/logger.js';

export const MAX_CONCURRENT_WORKERS = 4;

export type DispatchSignalFn = (signalBody: string) => Promise<void>;

export class WorkerManager {
  private activeRunners = new Map<string, WorkerRunner>();
  private isProcessing = false;
  private isStopped = false;
  private onDispatchCompletion: DispatchSignalFn | null = null;

  constructor(
    private db: PokeDatabase,
    private configManager: ConfigManager,
    private exa: ExaToolHandler,
    private supermemory: SupermemoryToolHandler,
    private composio: ComposioToolHandler,
    private skills: SkillRegistry
  ) {}

  setCompletionDispatcher(fn: DispatchSignalFn): void {
    this.onDispatchCompletion = fn;
  }

  stop(): void {
    this.isStopped = true;
    for (const [, runner] of this.activeRunners.entries()) {
      runner.abort();
    }
    this.activeRunners.clear();
  }

  async startJob(params: {
    name: string;
    instruction: string;
    cwd?: string;
  }): Promise<WorkerJobRecord> {
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  reconcileStartupJobs(): void {
    if (!this.db.isOpen()) return;
    const runningJobs = this.db.getRunningWorkerJobs();
    if (runningJobs.length === 0) return;

    const logger = getLogger();
    logger.warn({ count: runningJobs.length }, 'Reconciling interrupted running workers on startup');

    for (const job of runningJobs) {
      this.db.updateWorkerJob(job.id, {
        status: 'failed',
        error: 'Worker interrupted by daemon restart',
        finished_at: Date.now(),
      });

      if (this.onDispatchCompletion) {
        const signalXml = `<worker_completion id="${job.id}" status="failed" name="${job.name}">\nWorker interrupted by daemon restart\n</worker_completion>`;
        this.onDispatchCompletion(signalXml).catch(() => {});
      }
    }
  }

  async processQueue(): Promise<void> {
    if (this.isProcessing || this.isStopped || !this.db.isOpen()) return;
    this.isProcessing = true;

    try {
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

  private async runJob(job: WorkerJobRecord): Promise<void> {
    if (this.isStopped || !this.db.isOpen()) return;
    const logger = getLogger().child({ jobId: job.id, jobName: job.name });
    logger.info('Assigning slot and starting worker execution');

    this.db.updateWorkerJob(job.id, {
      status: 'running',
      started_at: Date.now(),
    });

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

      // Check if job was aborted in the database (e.g. by /stop)
      const currentCheck = this.db.getWorkerJob(job.id);
      if (currentCheck?.status === 'aborted' || currentCheck?.status === 'cancelled') {
        logger.info({ jobId: job.id }, 'Job was aborted or cancelled; suppressing completion dispatch');
        this.activeRunners.delete(job.id);
        return;
      }

      const finishedAt = Date.now();
      this.db.updateWorkerJob(job.id, {
        status: outcome.status,
        result: outcome.result || null,
        error: outcome.error || null,
        finished_at: finishedAt,
      });

      this.activeRunners.delete(job.id);

      // Deliver completion signal to the main agent unless aborted
      if (outcome.status !== 'aborted' && this.onDispatchCompletion && this.db.isOpen()) {
        const check = this.db.getWorkerJob(job.id);
        if (check && !check.completion_dispatched_at && check.status !== 'aborted') {
          const signalXml = `<worker_completion id="${job.id}" status="${outcome.status}" name="${job.name}">\n${outcome.result || outcome.error || 'Job completed.'}\n</worker_completion>`;

          try {
            await this.onDispatchCompletion(signalXml);
            if (this.db.isOpen()) {
              this.db.updateWorkerJob(job.id, {
                completion_dispatched_at: Date.now(),
              });
            }
            logger.info('Dispatched worker completion signal to main agent');
          } catch (dispatchErr: any) {
            logger.error({ err: dispatchErr.message }, 'Failed to dispatch worker completion signal');
          }
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Unexpected error in worker runner');
      if (this.db.isOpen()) {
        const check = this.db.getWorkerJob(job.id);
        if (check && check.status !== 'aborted' && check.status !== 'cancelled') {
          this.db.updateWorkerJob(job.id, {
            status: 'failed',
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
    for (const [, runner] of this.activeRunners.entries()) {
      runner.abort();
    }
    this.activeRunners.clear();

    if (!this.db.isOpen()) return { abortedCount: 0, cancelledCount: 0 };
    const { abortedIds, cancelledIds } = this.db.abortAllActiveWorkerJobs();
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
