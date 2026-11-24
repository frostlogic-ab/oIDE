import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { removeSync } from './fs-safe.js';

/**
 * Opening `<userData>/oide.db` safely. When the database cannot be opened, oIDE never deletes or
 * overwrites it silently:
 *
 * - `locked` (another process holds it): Retry or Quit.
 * - `corrupt` (not a database / malformed): the files are copied to `<userData>/backups/` first,
 *   then the user picks Quit, Open backups folder, or Start with a new database (which moves the
 *   damaged files into backups; nothing is deleted).
 * - `newer-schema` (written by a newer oIDE): Quit (update oIDE).
 * - `disk-full`, `permission`, `other`: Retry, Open data folder, or Quit.
 */

export type DbFailureKind = 'locked' | 'corrupt' | 'newer-schema' | 'disk-full' | 'permission' | 'other';

export function classifyDbError(err: unknown): DbFailureKind {
  const e = err as { message?: unknown; code?: unknown; errcode?: unknown; errstr?: unknown } | null;
  const text = `${String(e?.message ?? err)} ${String(e?.code ?? '')} ${String(e?.errstr ?? '')}`;
  if (/newer than this build/i.test(text)) return 'newer-schema';
  if (/database is locked|SQLITE_BUSY|SQLITE_LOCKED|database table is locked/i.test(text)) return 'locked';
  if (/file is not a database|malformed|SQLITE_CORRUPT|SQLITE_NOTADB|file is encrypted/i.test(text)) return 'corrupt';
  if (/SQLITE_FULL|database or disk is full|ENOSPC|no space left/i.test(text)) return 'disk-full';
  if (/EACCES|EPERM|EROFS|SQLITE_CANTOPEN|SQLITE_READONLY|unable to open|readonly database|permission denied/i.test(text)) return 'permission';
  return 'other';
}

const SIDE_FILES = ['', '-wal', '-shm'];

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** Copy the database and its WAL/SHM files into `backupDir`. Returns the copies made. */
export function backupDatabaseFiles(file: string, backupDir: string, now = Date.now(), tag = 'failed'): string[] {
  mkdirSync(backupDir, { recursive: true });
  const out: string[] = [];
  const ts = stamp(now);
  for (const suffix of SIDE_FILES) {
    const src = file + suffix;
    if (!existsSync(src)) continue;
    const dest = join(backupDir, `${basename(file)}.${tag}-${ts}${suffix}`);
    try {
      copyFileSync(src, dest);
      out.push(dest);
    } catch {}
  }
  return out;
}

/** Move the damaged files aside (into `backupDir`) so a new database can be created. */
export function quarantineDatabase(file: string, backupDir: string, now = Date.now()): string[] {
  mkdirSync(backupDir, { recursive: true });
  const out: string[] = [];
  const ts = stamp(now);
  for (const suffix of SIDE_FILES) {
    const src = file + suffix;
    if (!existsSync(src)) continue;
    const dest = join(backupDir, `${basename(file)}.corrupt-${ts}${suffix}`);
    try {
      renameSync(src, dest);
    } catch {
      copyFileSync(src, dest);
      removeSync(src);
    }
    out.push(dest);
  }
  return out;
}

export type OpenResult<S> = { ok: true; store: S } | { ok: false; kind: DbFailureKind; error: Error; backups: string[] };

/** Try to open; on failure classify, and back the files up unless they are merely locked. */
export function tryOpenDatabase<S>(file: string, backupDir: string, open: () => S, now = Date.now()): OpenResult<S> {
  try {
    return { ok: true, store: open() };
  } catch (err) {
    const kind = classifyDbError(err);
    const backups = kind === 'locked' || file === ':memory:' ? [] : backupDatabaseFiles(file, backupDir, now);
    return { ok: false, kind, error: err instanceof Error ? err : new Error(String(err)), backups };
  }
}

export interface DbFailurePrompt {
  title: string;
  message: string;
  detail: string;
  buttons: Array<{ label: string; action: DbAction }>;
  /** Index of the safe default (always Quit or Retry, never the new database). */
  defaultId: number;
  cancelId: number;
}

export type DbAction = 'retry' | 'quit' | 'fresh' | 'open-backups' | 'open-data';

export function dbFailurePrompt(kind: DbFailureKind, error: Error, backups: string[]): DbFailurePrompt {
  const saved = backups.length ? `A copy was saved first:\n${backups[0]}` : '';
  const reason = error.message.slice(0, 300);
  switch (kind) {
    case 'locked':
      return {
        title: 'oIDE',
        message: "oIDE's database is in use by another program.",
        detail: `Another oIDE window or a program reading the database (a backup tool, a database viewer) holds a lock on it. Close it and choose Retry.\n\n${reason}`,
        buttons: [
          { label: 'Retry', action: 'retry' },
          { label: 'Quit', action: 'quit' },
        ],
        defaultId: 0,
        cancelId: 1,
      };
    case 'corrupt':
      return {
        title: 'oIDE',
        message: "oIDE's database is damaged and cannot be opened.",
        detail: `${saved}\n\nStart with a new database to keep working: projects, agent history and settings start fresh, and the damaged files are moved to the backups folder (nothing is deleted). Or quit and restore a backup yourself.\n\n${reason}`,
        buttons: [
          { label: 'Quit', action: 'quit' },
          { label: 'Open backups folder', action: 'open-backups' },
          { label: 'Start with a new database', action: 'fresh' },
        ],
        defaultId: 0,
        cancelId: 0,
      };
    case 'newer-schema':
      return {
        title: 'oIDE',
        message: 'This database was written by a newer version of oIDE.',
        detail: `Update oIDE to open it. Nothing was changed.\n\n${reason}`,
        buttons: [{ label: 'Quit', action: 'quit' }],
        defaultId: 0,
        cancelId: 0,
      };
    case 'disk-full':
      return {
        title: 'oIDE',
        message: 'The disk is full, so oIDE cannot open its database.',
        detail: `Free some space and choose Retry.\n\n${reason}`,
        buttons: [
          { label: 'Retry', action: 'retry' },
          { label: 'Quit', action: 'quit' },
        ],
        defaultId: 0,
        cancelId: 1,
      };
    default:
      return {
        title: 'oIDE',
        message: kind === 'permission' ? "oIDE cannot read or write its database (permission denied)." : "oIDE's database could not be opened.",
        detail: `${saved ? `${saved}\n\n` : ''}Check that oIDE's data folder is writable, then choose Retry.\n\n${reason}`,
        buttons: [
          { label: 'Retry', action: 'retry' },
          { label: 'Open data folder', action: 'open-data' },
          { label: 'Quit', action: 'quit' },
        ],
        defaultId: 0,
        cancelId: 2,
      };
  }
}

export interface OpenWithRecoveryOptions<S> {
  file: string;
  backupDir: string;
  open: () => S;
  /** Show the prompt; resolves the chosen button index. */
  ask(prompt: DbFailurePrompt): Promise<number>;
  openFolder(path: string): void;
  log?: { warn(...a: unknown[]): void; error(...a: unknown[]): void };
  now?: () => number;
  /** Safety cap on prompt rounds (default 20). */
  maxRounds?: number;
}

/** Open the store, asking the user how to recover on failure. Resolves null when they quit. */
export async function openWithRecovery<S>(o: OpenWithRecoveryOptions<S>): Promise<S | null> {
  const now = o.now ?? Date.now;
  for (let round = 0; round < (o.maxRounds ?? 20); round++) {
    const r = tryOpenDatabase(o.file, o.backupDir, o.open, now());
    if (r.ok) return r.store;
    o.log?.error('database open failed', { kind: r.kind, error: r.error, backups: r.backups.length });
    // Re-prompt for the same failure until the user picks an action that changes something.
    for (;;) {
      const prompt = dbFailurePrompt(r.kind, r.error, r.backups);
      const idx = await o.ask(prompt);
      const action = prompt.buttons[idx]?.action ?? prompt.buttons[prompt.cancelId]!.action;
      if (action === 'quit') return null;
      if (action === 'open-backups') {
        o.openFolder(o.backupDir);
        continue;
      }
      if (action === 'open-data') {
        o.openFolder(join(o.file, '..'));
        continue;
      }
      if (action === 'fresh') {
        const moved = quarantineDatabase(o.file, o.backupDir, now());
        o.log?.warn('damaged database moved aside; starting with a new one', { files: moved.length });
      }
      break; // retry or fresh: open again
    }
  }
  return null;
}
