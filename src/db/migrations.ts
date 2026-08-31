import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema.js';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT name FROM migrations').all() as { name: string }[];
  const appliedNames = new Set(appliedRows.map((r) => r.name));

  for (const migration of MIGRATIONS) {
    if (!appliedNames.has(migration.name)) {
      const applyTx = db.transaction(() => {
        db.exec(migration.up);
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
          migration.name,
          Date.now()
        );
      });
      applyTx();
    }
  }
}

export function getPendingMigrations(db: Database.Database): string[] {
  try {
    const appliedRows = db.prepare('SELECT name FROM migrations').all() as { name: string }[];
    const appliedNames = new Set(appliedRows.map((r) => r.name));
    return MIGRATIONS.filter((m) => !appliedNames.has(m.name)).map((m) => m.name);
  } catch {
    return MIGRATIONS.map((m) => m.name);
  }
}
