import { PokeDatabase, AutomationRecord } from '../db/database.js';
import { computeNextRun } from './timezone.js';
import { getLogger } from '../logger/logger.js';

export type DispatchAutomationSignalFn = (signalBody: string) => Promise<void>;

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private onDispatchSignal: DispatchAutomationSignalFn | null = null;

  constructor(private db: PokeDatabase) {}

  setDispatcher(fn: DispatchAutomationSignalFn): void {
    this.onDispatchSignal = fn;
  }

  start(intervalMs = 2000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const logger = getLogger();
    logger.info('Starting automation scheduler');

    // Startup catch-up logic
    this.reconcileDowntime();

    // Start poll loop
    this.timer = setInterval(() => {
      this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  reconcileDowntime(): void {
    const logger = getLogger();
    const now = Date.now();
    const automations = this.db.listAutomations();

    for (const auto of automations) {
      if (!auto.enabled) continue;

      if (auto.next_run_at && auto.next_run_at < now) {
        if (auto.schedule_type === 'once') {
          // Keep next_run_at so it runs once at next tick
          logger.info({ autoId: auto.id }, 'Found overdue one-time automation, will run once');
        } else {
          // Missed cron or interval occurrences are NOT replayed
          try {
            const nextRun = computeNextRun(auto.schedule_type, auto.schedule_value, now);
            this.db.updateAutomation(auto.id, { next_run_at: nextRun });
            logger.info(
              { autoId: auto.id, type: auto.schedule_type, nextRun },
              'Recomputed next run time for recurring automation after downtime'
            );
          } catch (err: any) {
            logger.error({ autoId: auto.id, err: err.message }, 'Failed to compute next run after downtime');
          }
        }
      } else if (!auto.next_run_at) {
        try {
          const nextRun = computeNextRun(auto.schedule_type, auto.schedule_value, now);
          this.db.updateAutomation(auto.id, { next_run_at: nextRun });
        } catch (err: any) {
          logger.error({ autoId: auto.id, err: err.message }, 'Failed to initialize next run time');
        }
      }
    }
  }

  async tick(): Promise<void> {
    const now = Date.now();
    const dueAutomations = this.db.getDueAutomations(now);

    for (const auto of dueAutomations) {
      await this.triggerAutomation(auto, now);
    }
  }

  private async triggerAutomation(auto: AutomationRecord, triggerTimeMs: number): Promise<void> {
    const logger = getLogger().child({ autoId: auto.id, autoName: auto.name });
    logger.info('Triggering scheduled automation');

    const scheduledDateIso = new Date(auto.next_run_at || triggerTimeMs).toISOString();
    const signalXml = `<automation_trigger id="${auto.id}" name="${auto.name}" scheduled_at="${scheduledDateIso}">\n${auto.instruction}\n</automation_trigger>`;

    // Update next run time BEFORE or WITH dispatch to guarantee idempotency
    let nextRun: number | null = null;
    let newEnabled = auto.enabled;

    if (auto.schedule_type === 'once') {
      nextRun = null;
      newEnabled = 0; // Disabled once finished
    } else {
      try {
        nextRun = computeNextRun(auto.schedule_type, auto.schedule_value, Date.now());
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to compute next run for recurring automation');
      }
    }

    this.db.updateAutomation(auto.id, {
      next_run_at: nextRun,
      last_run_at: triggerTimeMs,
      enabled: newEnabled,
      last_outcome: 'triggered',
    });

    if (this.onDispatchSignal) {
      try {
        await this.onDispatchSignal(signalXml);
        this.db.updateAutomation(auto.id, { last_outcome: 'dispatched' });
        logger.info('Automation trigger dispatched to main agent');
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to dispatch automation signal');
        this.db.updateAutomation(auto.id, { last_outcome: `dispatch_error: ${err.message}` });
      }
    }
  }

  // --- CRUD API ---
  createAutomation(params: {
    name: string;
    instruction: string;
    schedule_type: 'once' | 'cron' | 'interval';
    schedule_value: string;
    enabled?: boolean;
  }): AutomationRecord {
    const nextRun = computeNextRun(params.schedule_type, params.schedule_value, Date.now());
    const id = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return this.db.createAutomation({
      id,
      name: params.name,
      instruction: params.instruction,
      schedule_type: params.schedule_type,
      schedule_value: params.schedule_value,
      enabled: params.enabled !== false,
      next_run_at: nextRun,
    });
  }

  updateAutomation(
    id: string,
    params: Partial<{
      name: string;
      instruction: string;
      schedule_type: 'once' | 'cron' | 'interval';
      schedule_value: string;
      enabled: boolean;
    }>
  ): AutomationRecord {
    const existing = this.db.getAutomation(id);
    if (!existing) {
      throw new Error(`Automation with ID "${id}" not found.`);
    }

    const type = params.schedule_type || existing.schedule_type;
    const val = params.schedule_value || existing.schedule_value;

    let nextRun = existing.next_run_at;
    if (params.schedule_type || params.schedule_value) {
      nextRun = computeNextRun(type, val, Date.now());
    }

    this.db.updateAutomation(id, {
      ...params,
      next_run_at: nextRun,
    });

    return this.db.getAutomation(id)!;
  }

  deleteAutomation(id: string): boolean {
    return this.db.deleteAutomation(id);
  }

  enableAutomation(id: string): AutomationRecord {
    const existing = this.db.getAutomation(id);
    if (!existing) throw new Error(`Automation "${id}" not found.`);

    const nextRun = computeNextRun(existing.schedule_type, existing.schedule_value, Date.now());
    this.db.updateAutomation(id, { enabled: true, next_run_at: nextRun });
    return this.db.getAutomation(id)!;
  }

  disableAutomation(id: string): AutomationRecord {
    const existing = this.db.getAutomation(id);
    if (!existing) throw new Error(`Automation "${id}" not found.`);

    this.db.updateAutomation(id, { enabled: false });
    return this.db.getAutomation(id)!;
  }

  listAutomations(): AutomationRecord[] {
    return this.db.listAutomations();
  }

  getAutomation(id: string): AutomationRecord | null {
    return this.db.getAutomation(id);
  }
}
