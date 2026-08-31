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
];
