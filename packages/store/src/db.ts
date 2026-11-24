import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations.js';

/**
 * One SQLite database per install (`<app-data>/oide.db`) through the built-in `node:sqlite`
 * (ADR 0001). WAL mode, foreign keys on, numbered migrations applied in one transaction each,
 * with a `VACUUM INTO` backup of the file taken before any pending migration runs.
 */

export interface OpenDatabaseOptions {
  /** Override the migration list (tests). */
  migrations?: Migration[];
  /** Folder for pre-migration backups; default next to the database file. */
  backupDir?: string;
  /** How many backups to keep (default 3). */
  keepBackups?: number;
}

export interface Database {
  readonly db: DatabaseSync;
  readonly file: string;
  /** Run `fn` in a transaction (nested calls use savepoints). */
  transaction<T>(fn: () => T): T;
  /** Schema version after migrations. */
  readonly version: number;
  /** Path of the backup taken before migrating, if one was taken. */
  readonly backupPath?: string;
  close(): void;
}

let savepointSeq = 0;

export function openDatabase(file: string, opts: OpenDatabaseOptions = {}): Database {
  const memory = file === ':memory:';
  if (!memory) mkdirSync(dirname(file), { recursive: true });
  const existed = !memory && existsSync(file) && statSync(file).size > 0;
  const db = new DatabaseSync(file);
  try {
    return setUp(db, file, memory, existed, opts);
  } catch (err) {
    // Never keep a handle on a file we could not open: on Windows it would stay locked, and the
    // app could not move a damaged database aside (apps/desktop reliability/db-recovery.ts).
    try {
      if (db.isOpen) db.close();
    } catch {}
    throw err;
  }
}

function setUp(db: DatabaseSync, file: string, memory: boolean, existed: boolean, opts: OpenDatabaseOptions): Database {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (!memory) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }

  let depth = 0;
  const transaction = <T>(fn: () => T): T => {
    if (depth > 0) {
      const sp = `sp_${++savepointSeq}`;
      db.exec(`SAVEPOINT ${sp}`);
      depth++;
      try {
        const r = fn();
        db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const migrations = [...(opts.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version);
  checkMigrations(migrations);
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
  const pending = migrations.filter((m) => !applied.has(m.version));
  const current = Math.max(0, ...applied);
  const newest = migrations.length ? migrations[migrations.length - 1]!.version : 0;
  if (current > newest) {
    throw new Error(`Database ${file} is at schema version ${current}, newer than this build (${newest}). Update oIDE.`);
  }

  let backupPath: string | undefined;
  if (pending.length && existed && applied.size > 0) {
    const dir = opts.backupDir ?? dirname(file);
    mkdirSync(dir, { recursive: true });
    backupPath = join(dir, `${basename(file)}.v${current}.${Date.now()}.bak`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    pruneBackups(dir, basename(file), opts.keepBackups ?? 3);
  }

  for (const m of pending) {
    transaction(() => {
      if (typeof m.up === 'string') db.exec(m.up);
      else m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
    });
  }

  const version = Math.max(current, ...pending.map((m) => m.version));
  return {
    db,
    file,
    transaction,
    version,
    backupPath,
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}

function checkMigrations(ms: Migration[]): void {
  const seen = new Set<number>();
  for (const m of ms) {
    if (!Number.isInteger(m.version) || m.version < 1) throw new Error(`Bad migration version ${m.version}`);
    if (seen.has(m.version)) throw new Error(`Duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
}

function pruneBackups(dir: string, base: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(base + '.v') && f.endsWith('.bak'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  // unlinkSync, not rmSync: some Node releases' rmSync silently skips non-ASCII paths on Windows.
  for (const { f } of files.slice(keep)) {
    try {
      unlinkSync(join(dir, f));
    } catch {}
  }
}

/** JSON helpers for TEXT columns. */
export function toJson(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}
export function fromJson<T = unknown>(s: unknown): T | undefined {
  if (typeof s !== 'string' || s === '') return undefined;
  return JSON.parse(s) as T;
}
