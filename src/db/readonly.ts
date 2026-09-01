import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Runs an inspection against an ephemeral SQLite copy without touching WAL files. */
export function inspectReadOnlyDatabase<T>(sqliteFile: string, inspect: (db: Database.Database) => T): T | null {
  if (!fs.existsSync(sqliteFile)) return null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-readonly-'));
  const copy = path.join(directory, 'state.sqlite');
  let database: Database.Database | undefined;
  try {
    fs.copyFileSync(sqliteFile, copy);
    for (const suffix of ['-wal', '-shm']) {
      const source = `${sqliteFile}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${copy}${suffix}`);
    }
    database = new Database(copy, { readonly: true, fileMustExist: true });
    return inspect(database);
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
