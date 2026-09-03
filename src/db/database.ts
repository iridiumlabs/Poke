import Database from 'better-sqlite3';
import { resolvePokePaths, ensurePokeDirectories, PokePaths } from '../config/paths.js';
import { redactSecrets } from '../logger/logger.js';
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
  completion_submission_id?: string | null;
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
  last_submission_id?: string | null;
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

export interface OutgoingDeliveryRecord {
  key: string;
  action_type: string;
  payload_hash: string;
  status: 'pending' | 'sent';
  response_data?: string | null;
  created_at: number;
  updated_at: number;
}

export interface SubmissionDeliveryRecord {
  source_key: string;
  submission_id?: string | null;
  source: 'whatsapp' | 'automation' | 'worker';
  whatsapp_message_id?: string | null;
  status: 'pending' | 'completed' | 'failed' | 'aborted';
  error_message?: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationOccurrenceRecord {
  automation_id: string;
  scheduled_at: number;
  status: 'claimed' | 'admitted';
  submission_id?: string | null;
  claimed_at: number;
  admitted_at?: number | null;
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

  /**
   * Flue commits compaction as a durable conversation record before emitting
   * its live observer event. This lets Poke reconcile its own post-compaction
   * state after a process dies between those two operations.
   */
  getLatestFlueCompactionEntry(agentName: string, instanceId: string): string | null {
    if (!this.isOpen()) return null;
    const streamPath = `agents/${agentName}/${instanceId}`;
    try {
      // Batch data rows can reach Flue's 12MB batch ceiling. Load sequence
      // numbers first and materialize each batch's data only as needed,
      // stopping at the newest compaction record.
      const batchSeqs = this.db
        .prepare(
          `SELECT seq FROM flue_conversation_stream_batches
           WHERE path = ? ORDER BY seq DESC`
        )
        .all(streamPath) as Array<{ seq: number }>;

      for (const { seq } of batchSeqs) {
        const batch = this.db
          .prepare(
            `SELECT data FROM flue_conversation_stream_batches
             WHERE path = ? AND seq = ?`
          )
          .get(streamPath, seq) as { data: string } | undefined;
        if (!batch) continue;
        let data = batch.data;
        if (data.startsWith('{')) {
          const chunks = this.db
            .prepare(
              `SELECT data FROM flue_conversation_stream_batch_chunks
               WHERE path = ? AND seq = ? ORDER BY chunk_index ASC`
            )
            .all(streamPath, seq) as Array<{ data: string }>;
          if (chunks.length === 0) continue;
          data = chunks.map((chunk) => chunk.data).join('');
        }
        const records = JSON.parse(data) as unknown[];
        for (let index = records.length - 1; index >= 0; index--) {
          const record = records[index] as { type?: unknown; entryId?: unknown };
          if (record?.type === 'compaction' && typeof record.entryId === 'string') {
            return record.entryId;
          }
        }
      }
    } catch {
      // The Flue tables may not exist before the runtime initializes. The
      // caller will retry via the live event or at the next startup.
    }
    return null;
  }

  /**
   * Estimates the current token size of the active conversation for an agent instance,
   * taking into account any recent compaction summary and subsequent conversation records.
   */
  getActiveConversationTokenEstimate(agentName: string, instanceId: string): number | null {
    if (!this.isOpen()) return null;
    const streamPath = `agents/${agentName}/${instanceId}`;
    try {
      const batchSeqs = this.db
        .prepare(
          `SELECT seq FROM flue_conversation_stream_batches
           WHERE path = ? ORDER BY seq DESC`
        )
        .all(streamPath) as Array<{ seq: number }>;

      if (batchSeqs.length === 0) return null;

      const activeRecords: any[] = [];

      for (const { seq } of batchSeqs) {
        const batch = this.db
          .prepare(
            `SELECT data FROM flue_conversation_stream_batches
             WHERE path = ? AND seq = ?`
          )
          .get(streamPath, seq) as { data: string } | undefined;
        if (!batch) continue;
        let data = batch.data;
        if (data.startsWith('{')) {
          const chunks = this.db
            .prepare(
              `SELECT data FROM flue_conversation_stream_batch_chunks
               WHERE path = ? AND seq = ? ORDER BY chunk_index ASC`
            )
            .all(streamPath, seq) as Array<{ data: string }>;
          if (chunks.length > 0) {
            data = chunks.map((chunk) => chunk.data).join('');
          }
        }
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed.length > 0) {
            let compactionIdx = -1;
            for (let i = parsed.length - 1; i >= 0; i--) {
              if (parsed[i]?.type === 'compaction') {
                compactionIdx = i;
                break;
              }
            }

            if (compactionIdx >= 0) {
              activeRecords.unshift(...parsed.slice(compactionIdx));
              break;
            } else {
              activeRecords.unshift(...parsed);
            }
          }
        } catch {}
      }

      if (activeRecords.length === 0) return null;

      let totalChars = 0;
      for (const rec of activeRecords) {
        if (!rec) continue;
        if (rec.type === 'compaction') {
          if (typeof rec.summary === 'string') totalChars += rec.summary.length;
          if (rec.details) totalChars += JSON.stringify(rec.details).length;
        } else if (rec.type === 'user_message' || rec.type === 'signal') {
          if (typeof rec.content === 'string') totalChars += rec.content.length;
          else if (rec.content) totalChars += JSON.stringify(rec.content).length;
        } else if (rec.type === 'assistant_text_delta') {
          if (typeof rec.delta === 'string') totalChars += rec.delta.length;
        } else if (rec.type === 'assistant_text_completed') {
          if (typeof rec.text === 'string') totalChars += rec.text.length;
        } else if (rec.type === 'tool_outcome' || rec.type === 'tool_results_committed') {
          if (rec.content) totalChars += JSON.stringify(rec.content).length;
        } else if (rec.type === 'assistant_tool_call') {
          if (rec.toolName) totalChars += String(rec.toolName).length;
          if (rec.arguments) totalChars += JSON.stringify(rec.arguments).length;
        }
      }

      // Base overhead estimate for system prompt / instructions
      const estimatedTokens = Math.max(Math.ceil(totalChars / 4), 100);
      return estimatedTokens;
    } catch {
      return null;
    }
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
      completion_submission_id: null,
    };

    if (!this.isOpen()) return record;

    this.db
      .prepare(
        `INSERT INTO worker_jobs (id, name, instruction, cwd, status, result, error, created_at, started_at, finished_at, completion_dispatched_at, completion_submission_id)
         VALUES (@id, @name, @instruction, @cwd, @status, @result, @error, @created_at, @started_at, @finished_at, @completion_dispatched_at, @completion_submission_id)`
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
      completion_submission_id: string | null;
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

  completeWorkerJob(
    id: string,
    outcome: Pick<WorkerJobRecord, 'status' | 'result' | 'error' | 'finished_at'>
  ): boolean {
    if (!this.isOpen()) return false;

    const result = this.db
      .prepare(
        `UPDATE worker_jobs
         SET status = @status, result = @result, error = @error, finished_at = @finished_at
         WHERE id = @id AND status = 'running'`
      )
      .run({
        id,
        status: outcome.status,
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        finished_at: outcome.finished_at ?? Date.now(),
      });

    return result.changes > 0;
  }

  markWorkerCompletionDispatched(id: string, submissionId?: string): boolean {
    if (!this.isOpen()) return false;
    const result = this.db
      .prepare(
        `UPDATE worker_jobs
         SET completion_dispatched_at = ?,
             completion_submission_id = COALESCE(completion_submission_id, ?)
         WHERE id = ?
           AND status IN ('completed', 'failed')
           AND completion_dispatched_at IS NULL`
      )
      .run(Date.now(), submissionId ?? null, id);
    return result.changes > 0;
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
      last_submission_id: null,
      created_at: now,
      updated_at: now,
    };

    if (!this.isOpen()) return record;

    this.db
      .prepare(
        `INSERT INTO automations (id, name, instruction, schedule_type, schedule_value, enabled, next_run_at, last_run_at, last_outcome, last_submission_id, created_at, updated_at)
         VALUES (@id, @name, @instruction, @schedule_type, @schedule_value, @enabled, @next_run_at, @last_run_at, @last_outcome, @last_submission_id, @created_at, @updated_at)`
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
      last_submission_id: string | null;
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

    if (!('last_outcome' in updates)) {
      fields.push('last_outcome = NULL');
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

  getDueAutomations(nowMs: number, retryAfterMs = 0): AutomationRecord[] {
    if (!this.isOpen()) return [];
    const retryBefore = nowMs - retryAfterMs;
    return this.db
      .prepare(
        `SELECT * FROM automations
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
           AND (last_outcome IS NULL OR last_outcome NOT LIKE 'claimed%')
           AND (
             last_outcome IS NULL
             OR last_outcome NOT LIKE 'dispatch_error:%'
             OR last_run_at IS NULL
             OR last_run_at <= ?
           )
         ORDER BY next_run_at ASC`
      )
      .all(nowMs, retryBefore) as AutomationRecord[];
  }

  getNextDueAutomation(): AutomationRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM automations
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND (last_outcome IS NULL OR last_outcome NOT LIKE 'claimed%')
         ORDER BY next_run_at ASC
         LIMIT 1`
      )
      .get() as AutomationRecord | undefined;
    return row || null;
  }

  claimDueAutomation(id: string, scheduledAt: number, claimedAt: number, claimToken?: string): boolean {
    if (!this.isOpen()) return false;
    const token = claimToken || `${claimedAt}-${Math.random().toString(36).slice(2)}`;
    const outcome = `claimed:${token}`;
    const claim = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT status FROM automation_occurrences
           WHERE automation_id = ? AND scheduled_at = ?`
        )
        .get(id, scheduledAt) as { status: AutomationOccurrenceRecord['status'] } | undefined;
      if (existing?.status === 'admitted') return false;

      const result = this.db
        .prepare(
          `UPDATE automations
           SET last_run_at = ?, last_outcome = ?, updated_at = ?
           WHERE id = ?
             AND enabled = 1
             AND next_run_at = ?
             AND (last_outcome IS NULL OR last_outcome NOT LIKE 'claimed%')`
        )
        .run(claimedAt, outcome, claimedAt, id, scheduledAt);
      if (result.changes === 0) return false;

      this.db
        .prepare(
          `INSERT INTO automation_occurrences
            (automation_id, scheduled_at, status, submission_id, claimed_at, admitted_at)
           VALUES (?, ?, 'claimed', NULL, ?, NULL)
           ON CONFLICT(automation_id, scheduled_at) DO UPDATE
             SET status = 'claimed', claimed_at = excluded.claimed_at
             WHERE automation_occurrences.status = 'claimed'`
        )
        .run(id, scheduledAt, claimedAt);
      return true;
    });
    return claim();
  }

  finalizeAutomationDispatch(
    id: string,
    scheduledAt: number,
    submissionId: string,
    updates: { next_run_at: number | null; enabled: number },
    claimToken?: string
  ): boolean {
    if (!this.isOpen()) return false;
    const now = Date.now();
    const conflict = Symbol('automation-finalize-conflict');
    const expectedOutcome = claimToken
      ? (claimToken.startsWith('claimed:') ? claimToken : `claimed:${claimToken}`)
      : null;
    const finalize = this.db.transaction(() => {
      const occurrence = this.db
        .prepare(
          `UPDATE automation_occurrences
           SET status = 'admitted', submission_id = ?, admitted_at = ?
           WHERE automation_id = ? AND scheduled_at = ? AND status = 'claimed'`
        )
        .run(submissionId, now, id, scheduledAt);
      if (occurrence.changes === 0) return false;

      const query = expectedOutcome
        ? `UPDATE automations
           SET next_run_at = ?, enabled = ?, last_outcome = 'dispatched',
               last_submission_id = ?, updated_at = ?
           WHERE id = ? AND last_outcome = ?`
        : `UPDATE automations
           SET next_run_at = ?, enabled = ?, last_outcome = 'dispatched',
               last_submission_id = ?, updated_at = ?
           WHERE id = ? AND (last_outcome = 'claimed' OR last_outcome LIKE 'claimed:%')`;

      const params = expectedOutcome
        ? [updates.next_run_at, updates.enabled, submissionId, now, id, expectedOutcome]
        : [updates.next_run_at, updates.enabled, submissionId, now, id];

      const automation = this.db.prepare(query).run(...params);
      if (automation.changes === 0) throw conflict;
      return true;
    });
    try {
      return finalize();
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
  }

  getAutomationOccurrence(id: string, scheduledAt: number): AutomationOccurrenceRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM automation_occurrences
         WHERE automation_id = ? AND scheduled_at = ?`
      )
      .get(id, scheduledAt) as AutomationOccurrenceRecord | undefined;
    return row || null;
  }

  // --- Submission delivery tracking ---
  reserveSubmissionDelivery(input: {
    sourceKey: string;
    source: SubmissionDeliveryRecord['source'];
    whatsappMessageId?: string;
  }): SubmissionDeliveryRecord {
    const now = Date.now();
    const intended: SubmissionDeliveryRecord = {
      source_key: input.sourceKey,
      submission_id: null,
      source: input.source,
      whatsapp_message_id: input.whatsappMessageId || null,
      status: 'pending',
      error_message: null,
      created_at: now,
      updated_at: now,
    };
    if (!this.isOpen()) return intended;

    this.db
      .prepare(
        `INSERT INTO submission_deliveries
          (source_key, submission_id, source, whatsapp_message_id, status, error_message, created_at, updated_at)
         VALUES (@source_key, @submission_id, @source, @whatsapp_message_id, @status, @error_message, @created_at, @updated_at)
         ON CONFLICT(source_key) DO NOTHING`
      )
      .run(intended);
    const existing = this.getSubmissionDeliveryBySourceKey(input.sourceKey);
    if (!existing) throw new Error(`Unable to reserve submission delivery ${input.sourceKey}.`);
    if (existing.source !== input.source || existing.whatsapp_message_id !== (input.whatsappMessageId || null)) {
      throw new Error(`Submission delivery key ${input.sourceKey} is already associated with different input.`);
    }
    return existing;
  }

  attachSubmissionDelivery(sourceKey: string, submissionId: string): SubmissionDeliveryRecord {
    if (!this.isOpen()) {
      return {
        source_key: sourceKey,
        submission_id: submissionId,
        source: 'whatsapp',
        status: 'pending',
        created_at: Date.now(),
        updated_at: Date.now(),
      };
    }
    const result = this.db
      .prepare(
        `UPDATE submission_deliveries
         SET submission_id = ?, updated_at = ?
         WHERE source_key = ?
           AND (submission_id IS NULL OR submission_id = ?)`
      )
      .run(submissionId, Date.now(), sourceKey, submissionId);
    if (result.changes === 0) {
      throw new Error(`Submission delivery ${sourceKey} is already associated with another submission.`);
    }
    const record = this.getSubmissionDeliveryBySourceKey(sourceKey);
    if (!record) throw new Error(`Submission delivery ${sourceKey} disappeared after attachment.`);
    return record;
  }

  getSubmissionDeliveryBySourceKey(sourceKey: string): SubmissionDeliveryRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare('SELECT * FROM submission_deliveries WHERE source_key = ?')
      .get(sourceKey) as SubmissionDeliveryRecord | undefined;
    return row || null;
  }

  getSubmissionDelivery(submissionId: string): SubmissionDeliveryRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare('SELECT * FROM submission_deliveries WHERE submission_id = ?')
      .get(submissionId) as SubmissionDeliveryRecord | undefined;
    return row || null;
  }

  getPendingSubmissionDeliveries(): SubmissionDeliveryRecord[] {
    if (!this.isOpen()) return [];
    return this.db
      .prepare(
        `SELECT * FROM submission_deliveries
         WHERE status = 'pending'
         ORDER BY created_at ASC`
      )
      .all() as SubmissionDeliveryRecord[];
  }

  hasFlueSubmission(submissionId: string): boolean {
    if (!this.isOpen()) return false;
    const row = this.db
      .prepare('SELECT 1 FROM flue_agent_submissions WHERE submission_id = ?')
      .get(submissionId);
    return Boolean(row);
  }

  removeUnattachedSubmissionDelivery(sourceKey: string): void {
    if (!this.isOpen()) return;
    this.db
      .prepare('DELETE FROM submission_deliveries WHERE source_key = ? AND submission_id IS NULL')
      .run(sourceKey);
  }

  saveWhatsAppReplyTarget(messageId: string, envelope: Uint8Array): void {
    if (!this.isOpen()) return;
    this.db
      .prepare(
        `INSERT INTO whatsapp_reply_targets (message_id, envelope, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET envelope = excluded.envelope, created_at = excluded.created_at`
      )
      .run(messageId, Buffer.from(envelope), Date.now());
    // Quoted replies only need a small recent window. Keep it durable for
    // recovered Flue turns without retaining an unbounded WhatsApp archive.
    this.db
      .prepare(
        `DELETE FROM whatsapp_reply_targets
         WHERE message_id NOT IN (
           SELECT message_id FROM whatsapp_reply_targets
           ORDER BY created_at DESC, rowid DESC LIMIT 200
         )`
      )
      .run();
  }

  getWhatsAppReplyTarget(messageId: string): Uint8Array | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare('SELECT envelope FROM whatsapp_reply_targets WHERE message_id = ?')
      .get(messageId) as { envelope?: Buffer | Uint8Array } | undefined;
    if (!row?.envelope) return null;
    return new Uint8Array(row.envelope);
  }

  settleSubmissionDelivery(
    submissionId: string,
    status: Exclude<SubmissionDeliveryRecord['status'], 'pending'>,
    errorMessage?: string
  ): SubmissionDeliveryRecord | null {
    if (!this.isOpen()) return null;
    const result = this.db
      .prepare(
        `UPDATE submission_deliveries
         SET status = ?, error_message = ?, updated_at = ?
         WHERE submission_id = ? AND status = 'pending'`
      )
      .run(status, errorMessage || null, Date.now(), submissionId);
    if (result.changes === 0) return null;
    return this.getSubmissionDelivery(submissionId);
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

  // --- Durable outgoing delivery ---
  getOutgoingDelivery(key: string): OutgoingDeliveryRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare('SELECT * FROM outgoing_deliveries WHERE key = ?')
      .get(key) as OutgoingDeliveryRecord | undefined;
    return row || null;
  }

  reserveOutgoingDelivery(
    key: string,
    actionType: string,
    payloadHash: string
  ): { created: boolean; record: OutgoingDeliveryRecord } {
    const now = Date.now();
    const intended: OutgoingDeliveryRecord = {
      key,
      action_type: actionType,
      payload_hash: payloadHash,
      status: 'pending',
      response_data: null,
      created_at: now,
      updated_at: now,
    };

    if (!this.isOpen()) return { created: true, record: intended };

    const result = this.db
      .prepare(
        `INSERT INTO outgoing_deliveries
          (key, action_type, payload_hash, status, response_data, created_at, updated_at)
         VALUES (@key, @action_type, @payload_hash, @status, @response_data, @created_at, @updated_at)
         ON CONFLICT(key) DO NOTHING`
      )
      .run(intended);
    if (result.changes > 0) return { created: true, record: intended };

    const existing = this.getOutgoingDelivery(key);
    if (!existing) {
      throw new Error(`Unable to reserve outgoing delivery ${key}.`);
    }
    return { created: false, record: existing };
  }

  completeOutgoingDelivery(
    key: string,
    actionType: string,
    payloadHash: string,
    responseData: string
  ): void {
    if (!this.isOpen()) return;
    const now = Date.now();
    const complete = this.db.transaction(() => {
      const update = this.db
        .prepare(
          `UPDATE outgoing_deliveries
           SET status = 'sent', response_data = ?, updated_at = ?
           WHERE key = ?
             AND action_type = ?
             AND payload_hash = ?
             AND status = 'pending'`
        )
        .run(responseData, now, key, actionType, payloadHash);

      if (update.changes === 0) {
        const existing = this.getOutgoingDelivery(key);
        if (
          !existing ||
          existing.action_type !== actionType ||
          existing.payload_hash !== payloadHash ||
          existing.status !== 'sent'
        ) {
          throw new Error(`Outgoing delivery ${key} cannot be completed safely.`);
        }
      }

      this.db
        .prepare(
          `INSERT INTO idempotency (key, action_type, payload_hash, response_data, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET response_data = excluded.response_data`
        )
        .run(key, actionType, payloadHash, responseData, now);
    });
    complete();
  }

  // --- Operational Errors ---
  recordOperationalError(source: string, message: string, details?: string): OperationalErrorRecord {
    const record: OperationalErrorRecord = {
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      source,
      message: redactSecrets(message),
      details: details ? redactSecrets(details) : null,
      created_at: Date.now(),
    };

    if (!this.isOpen()) return record;

    this.db
      .prepare(
        `INSERT INTO operational_errors (id, source, message, details, created_at)
         VALUES (@id, @source, @message, @details, @created_at)`
      )
      .run(record);

    // Keep diagnostic storage bounded by retaining only the recent 100 errors
    this.db
      .prepare(
        `DELETE FROM operational_errors
         WHERE id NOT IN (
           SELECT id FROM operational_errors
           ORDER BY created_at DESC, rowid DESC LIMIT 100
         )`
      )
      .run();

    return record;
  }

  getLastOperationalError(): OperationalErrorRecord | null {
    if (!this.isOpen()) return null;
    const row = this.db
      .prepare('SELECT * FROM operational_errors ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as OperationalErrorRecord | undefined;
    return row || null;
  }
}
