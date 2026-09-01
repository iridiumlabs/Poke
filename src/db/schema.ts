export interface Migration {
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: '001_initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS state_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        instruction TEXT NOT NULL,
        cwd TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        completion_dispatched_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_worker_jobs_status_created 
        ON worker_jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        instruction TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_outcome TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automations_enabled_next_run 
        ON automations(enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_data TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operational_errors (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    name: '002_outgoing_deliveries',
    up: `
      CREATE TABLE IF NOT EXISTS outgoing_deliveries (
        key TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
        response_data TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outgoing_deliveries_status_updated
        ON outgoing_deliveries(status, updated_at);
    `,
  },
  {
    name: '003_runtime_handoffs',
    up: `
      ALTER TABLE worker_jobs ADD COLUMN completion_submission_id TEXT;
      ALTER TABLE automations ADD COLUMN last_submission_id TEXT;

      CREATE TABLE IF NOT EXISTS submission_deliveries (
        source_key TEXT PRIMARY KEY,
        submission_id TEXT UNIQUE,
        source TEXT NOT NULL,
        whatsapp_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'completed', 'failed', 'aborted')),
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_submission_deliveries_pending
        ON submission_deliveries(status, submission_id);

      CREATE TABLE IF NOT EXISTS whatsapp_reply_targets (
        message_id TEXT PRIMARY KEY,
        envelope BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_reply_targets_created
        ON whatsapp_reply_targets(created_at);

      CREATE TABLE IF NOT EXISTS automation_occurrences (
        automation_id TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'admitted')),
        submission_id TEXT,
        claimed_at INTEGER NOT NULL,
        admitted_at INTEGER,
        PRIMARY KEY (automation_id, scheduled_at)
      );
    `,
  },
];
