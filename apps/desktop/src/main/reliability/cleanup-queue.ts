import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { removeSync } from './fs-safe.js';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Worktree folders that could not be deleted because a program still had a file open in them
 * (Windows: an editor, a terminal, a dev server, an indexer or antivirus). The removal is retried
 * with backoff first (`WorktreeManager.remove`); if the folder is still locked, the user is told
 * which folder and to close programs using it, and the path is written to
 * `<userData>/pending-cleanup.json`. Every start retries the pending folders before agents restore.
 */

export interface PendingCleanup {
  path: string;
  /** Main checkout the worktree belongs to (for `git worktree prune`). */
  projectPath?: string;
  addedAt: number;
  attempts: number;
}

const FILE = 'pending-cleanup.json';
/** Give up on an entry after this many starts (it is then reported once and dropped). */
const MAX_ATTEMPTS = 20;

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const LOCK_TEXT = /resource busy|being used by another process|access is denied|permission denied|directory not empty|unable to (?:unlink|delete|remove)|failed to delete|could not (?:remove|delete)|operation not permitted/i;

/** A delete that failed because something holds a file open (or the OS denied it for now). */
export function isLockedFileError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; stderr?: unknown } | null;
  if (typeof e?.code === 'string' && LOCK_CODES.has(e.code)) return true;
  return LOCK_TEXT.test(`${String(e?.message ?? err)} ${String(e?.stderr ?? '')}`);
}

export function lockedFolderMessage(path: string, scheduled: boolean): string {
  return `Could not delete the worktree folder ${path} because a program is using a file in it. Close programs using this folder (editors, terminals, dev servers, file explorers)${scheduled ? '; oIDE will finish removing it the next time it starts' : ' and try again'}.`;
}

export class CleanupQueue {
  private readonly file: string;

  constructor(
    userDataDir: string,
    private readonly o: { rm?: (path: string) => Promise<void>; now?: () => number } = {},
  ) {
    this.file = join(userDataDir, FILE);
  }

  list(): PendingCleanup[] {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(v)) return [];
      return v.filter((x): x is PendingCleanup => !!x && typeof (x as PendingCleanup).path === 'string');
    } catch {
      return [];
    }
  }

  private save(list: PendingCleanup[]): void {
    try {
      if (!list.length) {
        removeSync(this.file);
        return;
      }
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch {}
  }

  schedule(path: string, projectPath?: string): void {
    const list = this.list();
    if (list.some((e) => samePathLoose(e.path, path))) return;
    list.push({ path, ...(projectPath ? { projectPath } : {}), addedAt: (this.o.now ?? Date.now)(), attempts: 0 });
    this.save(list);
  }

  /**
   * Retry every pending folder. Returns what was removed, what is still locked, and what was
   * given up on. `afterRemove` runs per removed folder (e.g. `git worktree prune`).
   */
  async runPending(afterRemove?: (e: PendingCleanup) => Promise<void>): Promise<{ removed: string[]; stillLocked: string[]; gaveUp: string[] }> {
    const removed: string[] = [];
    const stillLocked: string[] = [];
    const gaveUp: string[] = [];
    const keep: PendingCleanup[] = [];
    const del = this.o.rm ?? ((p: string) => rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
    for (const e of this.list()) {
      try {
        if (existsSync(e.path)) await del(e.path);
        removed.push(e.path);
        await afterRemove?.(e).catch(() => undefined);
      } catch (err) {
        const next = { ...e, attempts: e.attempts + 1 };
        if (next.attempts >= MAX_ATTEMPTS || !isLockedFileError(err)) gaveUp.push(e.path);
        else {
          keep.push(next);
          stillLocked.push(e.path);
        }
      }
    }
    this.save(keep);
    return { removed, stillLocked, gaveUp };
  }
}

function samePathLoose(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** Short label for a folder in notices (its last two segments). */
export function shortFolder(path: string): string {
  return join(basename(dirname(path)), basename(path));
}
