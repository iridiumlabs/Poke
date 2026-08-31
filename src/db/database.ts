import Database from 'better-sqlite3';
import { resolvePokePaths, ensurePokeDirectories, PokePaths } from '../config/paths.js';
import { runMigrations } from './migrations.js';

export interface WorkerJobRecord {
  id: string;
  name: string;
  instruction: string;
  cwd?: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'aborted';
  result?: string | null;
  error?: string | null;
  created_at: number;
  started_at?: number | null;
  finished_at?: number | null;
  completion_dispatched_at?: number | null;
}

export interface AutomationRecord {
  id: string;
  name: string;
  instruction: string;
  schedule_type: 'once' | 'cron' | 'interval';
  schedule_value: string;
  enabled: number; // 1 or 0
  next_run_at?: number | null;
  last_run_at?: number | null;
  last_outcome?: string | null;
  created_at: number;
  updated_at: number;
}

export interface IdempotencyRecord {
  key: string;
  action_type: string;
  payload_hash: string;
  response_data?: string | null;
  created_at: number;
}

export interface OperationalErrorRecord {
  id: string;
  source: string;
  message: string;
  details?: string | null;
  created_at: number;
}

export class PokeDatabase {
  private db: Database.Database;
  private paths: PokePaths;

  constructor(customHome?: string, inMemory = false) {
    this.paths = resolvePokePaths(customHome);
    if (!inMemory) {
      ensurePokeDirectories(this.paths);
      this.db = new Database(this.paths.sqliteFile);
      this.db.pragma('journal_mode = WAL');
    } else {
      this.db = new Database(':memory:');
    }
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
  }

  isOpen(): boolean {
    try {
      return Boolean(this.db && this.db.open);
    } catch {
      return false;
    }
  }

  getRawDb(): Database.Database {
    return this.db;
  }

  close(): void {
    if (this.isOpen()) {
      this.db.close();
    }
  }

  // --- State KV ---
  getState(key: string): string | null {
    if (!this.isOpen()) return null;
    const row = this.db.prepare('SELECT value FROM state_kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setState(key: string, value: string): void {
    if (!this.isOpen()) return;
    this.db
      .prepare(
        `INSERT INTO state_kv (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, Date.now());
  }

  deleteState(key: string): void {
    if (!this.isOpen()) return;
    this.db.prepare('DELETE FROM state_kv WHERE key = ?').run(key);
  }

  // --- Worker Jobs ---
  createWorkerJob(job: {
    id: string;
    name: string;
    instruction: string;
    cwd?: string;
    status?: WorkerJobRecord['status'];
  }): WorkerJobRecord {
    const now = Date.now();
    const record: WorkerJobRecord = {
      id: job.id,
      name: job.name,
      instruction: job.instruction,
      cwd: job.cwd || null,
      status: job.status || 'queued',
      result: null,
      error: null,
      created_at: now,
      started_at: job.status === 'running' ? now : null,
      finished_at: null,
      completion_dispatched_at: null,
    };

    if (!this.isOpen()) return record;

    this.db
      .prepare(
        `INSERT INTO worker_jobs (id, name, instruction, cwd, status, result, error, created_at, started_at, finished_at, completion_dispatched_at)
         VALUES (@id, @name, @instruction, @cwd, @status, @result, @error, @created_at, @started_at, @finished_at, @completion_dispatched_at)`
      )
      .run(record);

    return record;
  }

  getWorkerJob(id: string): WorkerJobRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db.prepare('SELECT * FROM worker_jobs WHERE id = ?').get(id) as
      | WorkerJobRecord
      | undefined;
    return row || null;
  }

  listWorkerJobs(limit = 50): WorkerJobRecord[] {
    if (!this.isOpen()) return [];
    return this.db
      .prepare('SELECT * FROM worker_jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as WorkerJobRecord[];
  }

  getRunningWorkerJobs(): WorkerJobRecord[] {
    if (!this.isOpen()) return [];
    return this.db
      .prepare("SELECT * FROM worker_jobs WHERE status = 'running' ORDER BY started_at ASC")
      .all() as WorkerJobRecord[];
  }

  getQueuedWorkerJobs(): WorkerJobRecord[] {
    if (!this.isOpen()) return [];
    return this.db
      .prepare("SELECT * FROM worker_jobs WHERE status = 'queued' ORDER BY created_at ASC")
      .all() as WorkerJobRecord[];
  }

  getUndeliveredFinishedWorkerJobs(): WorkerJobRecord[] {
    if (!this.isOpen()) return [];
    return this.db
      .prepare(
        "SELECT * FROM worker_jobs WHERE status IN ('completed', 'failed') AND completion_dispatched_at IS NULL ORDER BY finished_at ASC"
      )
      .all() as WorkerJobRecord[];
  }

  updateWorkerJob(
    id: string,
    updates: Partial<{
      status: WorkerJobRecord['status'];
      result: string | null;
      error: string | null;
      started_at: number | null;
      finished_at: number | null;
      completion_dispatched_at: number | null;
    }>
  ): void {
    if (!this.isOpen()) return;
    const fields: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }

    if (fields.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE worker_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  abortAllActiveWorkerJobs(): { abortedIds: string[]; cancelledIds: string[] } {
    if (!this.isOpen()) return { abortedIds: [], cancelledIds: [] };
    const running = this.getRunningWorkerJobs();
    const queued = this.getQueuedWorkerJobs();
    const now = Date.now();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE worker_jobs SET status = 'aborted', finished_at = ? WHERE status = 'running'"
        )
        .run(now);
      this.db
        .prepare(
          "UPDATE worker_jobs SET status = 'cancelled', finished_at = ? WHERE status = 'queued'"
        )
        .run(now);
    });
    tx();

    return {
      abortedIds: running.map((r) => r.id),
      cancelledIds: queued.map((q) => q.id),
    };
  }

  // --- Automations ---
  createAutomation(auto: {
    id: string;
    name: string;
    instruction: string;
    schedule_type: 'once' | 'cron' | 'interval';
    schedule_value: string;
    enabled?: boolean;
    next_run_at?: number | null;
  }): AutomationRecord {
    const now = Date.now();
    const record: AutomationRecord = {
      id: auto.id,
      name: auto.name,
      instruction: auto.instruction,
      schedule_type: auto.schedule_type,
      schedule_value: auto.schedule_value,
      enabled: auto.enabled !== false ? 1 : 0,
      next_run_at: auto.next_run_at ?? null,
      last_run_at: null,
      last_outcome: null,
      created_at: now,
      updated_at: now,
    };

    if (!this.isOpen()) return record;

    this.db
      .prepare(
        `INSERT INTO automations (id, name, instruction, schedule_type, schedule_value, enabled, next_run_at, last_run_at, last_outcome, created_at, updated_at)
         VALUES (@id, @name, @instruction, @schedule_type, @schedule_value, @enabled, @next_run_at, @last_run_at, @last_outcome, @created_at, @updated_at)`
      )
      .run(record);

    return record;
  }

  getAutomation(id: string): AutomationRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as
      | AutomationRecord
      | undefined;
    return row || null;
  }

  listAutomations(): AutomationRecord[] {
    if (!this.isOpen()) return [];
    return this.db
      .prepare('SELECT * FROM automations ORDER BY created_at DESC')
      .all() as AutomationRecord[];
  }

  updateAutomation(
    id: string,
    updates: Partial<{
      name: string;
      instruction: string;
      schedule_type: 'once' | 'cron' | 'interval';
      schedule_value: string;
      enabled: boolean | number;
      next_run_at: number | null;
      last_run_at: number | null;
      last_outcome: string | null;
    }>
  ): void {
    if (!this.isOpen()) return;
    const fields: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'enabled') {
        fields.push('enabled = ?');
        values.push(value ? 1 : 0);
      } else {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    fields.push('updated_at = ?');
    values.push(Date.now());

    values.push(id);
    this.db.prepare(`UPDATE automations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteAutomation(id: string): boolean {
    if (!this.isOpen()) return false;
    const result = this.db.prepare('DELETE FROM automations WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getDueAutomations(nowMs: number): AutomationRecord[] {
    if (!this.isOpen()) return [];
    return this.db
      .prepare(
        'SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC'
      )
      .all(nowMs) as AutomationRecord[];
  }

  getNextDueAutomation(): AutomationRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare(
        'SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at ASC LIMIT 1'
      )
      .get() as AutomationRecord | undefined;
    return row || null;
  }

  // --- Idempotency ---
  checkIdempotency(key: string): IdempotencyRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db.prepare('SELECT * FROM idempotency WHERE key = ?').get(key) as
      | IdempotencyRecord
      | undefined;
    return row || null;
  }

  recordIdempotency(
    key: string,
    actionType: string,
    payloadHash: string,
    responseData?: string
  ): void {
    if (!this.isOpen()) return;
    this.db
      .prepare(
        `INSERT INTO idempotency (key, action_type, payload_hash, response_data, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET response_data = excluded.response_data`
      )
      .run(key, actionType, payloadHash, responseData || null, Date.now());
  }

  // --- Operational Errors ---
  recordOperationalError(source: string, message: string, details?: string): OperationalErrorRecord {
    const record: OperationalErrorRecord = {
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      source,
      message,
      details: details || null,
      created_at: Date.now(),
    };

    if (!this.isOpen()) return record;

    this.db
      .prepare(
        `INSERT INTO operational_errors (id, source, message, details, created_at)
         VALUES (@id, @source, @message, @details, @created_at)`
      )
      .run(record);

    return record;
  }

  getLastOperationalError(): OperationalErrorRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare('SELECT * FROM operational_errors ORDER BY created_at DESC LIMIT 1')
      .get() as OperationalErrorRecord | undefined;
    return row || null;
  }
}
