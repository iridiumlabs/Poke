import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Runs an inspection against an ephemeral SQLite copy without touching WAL files. */
export async function inspectReadOnlyDatabase<T>(
  sqliteFile: string,
  inspect: (db: Database.Database) => T
): Promise<T | null> {
  if (!fs.existsSync(sqliteFile)) return null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-readonly-'));
  const copy = path.join(directory, 'state.sqlite');
  let source: Database.Database | undefined;
  let database: Database.Database | undefined;
  try {
    source = new Database(sqliteFile, { readonly: true, fileMustExist: true });
    await source.backup(copy);
    source.close();
    source = undefined;
    database = new Database(copy, { readonly: true, fileMustExist: true });
    return inspect(database);
  } catch {
    return null;
  } finally {
    try {
      source?.close();
    } catch {}
    try {
      database?.close();
    } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
