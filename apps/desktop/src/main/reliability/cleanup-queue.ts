import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isLockError, plainFsPromises } from '@oide/git';
import { removeSync } from './fs-safe.js';
import { basename, dirname, join } from 'node:path';
import { describeHolders, type FolderHolder } from './folder-holders.js';

// Not node:fs: in Electron it treats `*.asar` files as folders and keeps them open (@oide/git plain-fs).
const { rm } = plainFsPromises;

/**
 * Worktree folders that could not be deleted (docs/wiki/pages/git-worktrees.md, "Why a worktree
 * can't be deleted on Windows"). `WorktreeManager.remove` already deleted what it could with
 * `fs.rm` and its retries; what is left is a folder some program still holds open (an editor, a
 * terminal, a dev server, Docker Desktop keeping it as its current directory) or one Windows denied
 * for now. The path is written to `<userData>/pending-cleanup.json`; `CleanupScheduler` retries it
 * at every start and every 5 minutes while oIDE runs, with backoff, and gives up after
 * MAX_ATTEMPTS tries.
 */

export interface PendingCleanup {
  path: string;
  /** Main checkout the worktree belongs to (for `git worktree prune`). */
  projectPath?: string;
  addedAt: number;
  attempts: number;
  /** Earliest next background try (start-up tries ignore it). */
  nextAttemptAt?: number;
  /** Why the last try failed. */
  lastError?: 'locked' | 'denied';
  /** Friendly names of the programs last seen holding it (`Docker Desktop`), never paths. */
  holders?: string[];
}

const FILE = 'pending-cleanup.json';
/** Give up on an entry after this many tries (it is then reported once and dropped). */
export const MAX_ATTEMPTS = 20;
/** Background retry tick. */
export const CLEANUP_INTERVAL_MS = 5 * 60_000;
/** Backoff cap between background tries of one folder. */
export const CLEANUP_MAX_BACKOFF_MS = 2 * 60 * 60_000;

/** Errors `fs.rm` retries itself and that may clear up later (a file being written, a running exe). */
const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

/**
 * A delete that failed because a program holds a file or folder open: `EBUSY`, or Windows'
 * sharing-violation text ("being used by another process"). Not `ENOTEMPTY`, `EPERM` or git's
 * "Directory not empty" / "Filename too long" (those were never locks).
 */
export function isLockedFileError(err: unknown): boolean {
  return isLockError(err);
}

/** Worth keeping in the queue: a lock, or a denial that `fs.rm` gave up on for now. */
export function isRetryableDeleteError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return isLockedFileError(err) || (typeof code === 'string' && RETRYABLE_CODES.has(code));
}

/** Background backoff after `attempts` failed tries: 5, 10, 20, 40 … minutes, at most 2 hours. */
export function cleanupBackoffMs(attempts: number): number {
  return Math.min(CLEANUP_MAX_BACKOFF_MS, CLEANUP_INTERVAL_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * The notice for a folder that could not be deleted yet. With holders it names them
 * ("Docker Desktop (com.docker.backend.exe) still has this folder open. Quit it, and oIDE will
 * finish removing the folder."); without, the generic advice. Only the worktree's own path appears.
 */
export function lockedFolderMessage(path: string, scheduled: boolean, holders: readonly FolderHolder[] = [], locked = true): string {
  const later = scheduled ? 'oIDE will finish removing the folder' : 'then try again';
  if (holders.length) {
    const many = holders.length > 1;
    return `Could not delete the worktree folder ${path}. ${describeHolders(holders)} still ${many ? 'have' : 'has'} this folder open. Quit ${many ? 'them' : 'it'}, and ${later}.`;
  }
  if (!locked) {
    return `Could not delete the worktree folder ${path} yet: Windows denied access to a file in it.${scheduled ? ' oIDE keeps trying in the background and at the next start.' : ' Try again in a moment.'}`;
  }
  return `Could not delete the worktree folder ${path} because a program is using a file in it. Close programs using this folder (editors, terminals, dev servers, Docker Desktop, file explorers)${scheduled ? '; oIDE keeps trying in the background and at the next start' : ' and try again'}.`;
}

export interface RunResult {
  removed: string[];
  stillLocked: string[];
  gaveUp: string[];
}

export class CleanupQueue {
  private readonly file: string;

  constructor(
    userDataDir: string,
    private readonly o: { rm?: (path: string) => Promise<void>; now?: () => number } = {},
  ) {
    this.file = join(userDataDir, FILE);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
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

  /** The queued entry for `path`, if any (IPC commands only act on queued folders). */
  find(path: string): PendingCleanup | undefined {
    return this.list().find((e) => samePathLoose(e.path, path));
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

  schedule(path: string, projectPath?: string, info: { lastError?: PendingCleanup['lastError'] } = {}): void {
    const list = this.list();
    if (list.some((e) => samePathLoose(e.path, path))) return;
    list.push({ path, ...(projectPath ? { projectPath } : {}), addedAt: this.now(), attempts: 0, nextAttemptAt: this.now() + CLEANUP_INTERVAL_MS, ...(info.lastError ? { lastError: info.lastError } : {}) });
    this.save(list);
  }

  /** Remember who held the folder (friendly names only), for Settings › Diagnostics. */
  noteHolders(path: string, holders: readonly FolderHolder[]): void {
    const list = this.list();
    const e = list.find((x) => samePathLoose(x.path, path));
    if (!e) return;
    e.holders = holders.map((h) => h.label).slice(0, 6);
    this.save(list);
  }

  /**
   * Retry pending folders: all of them (`dueOnly` false, at start or "Retry now"), only those
   * whose backoff has passed (`dueOnly`), or only `only`. Returns what was removed, what is still
   * held, and what was given up on. `afterRemove` runs per removed folder (`git worktree prune`).
   */
  async runPending(afterRemove?: (e: PendingCleanup) => Promise<void>, opts: { dueOnly?: boolean; only?: string } = {}): Promise<RunResult> {
    const removed: string[] = [];
    const stillLocked: string[] = [];
    const gaveUp: string[] = [];
    // One try per round (fs.rm's own maxRetries compounds per directory level and can hang for minutes).
    const del = this.o.rm ?? ((p: string) => rm(p, { recursive: true, force: true, maxRetries: 0 }));
    const now = this.now();
    const outcome = new Map<string, PendingCleanup | null>();
    for (const e of this.list()) {
      if (opts.only !== undefined && !samePathLoose(e.path, opts.only)) continue;
      if (opts.dueOnly && (e.nextAttemptAt ?? 0) > now) continue;
      try {
        if (existsSync(e.path)) await del(e.path);
        removed.push(e.path);
        outcome.set(e.path, null);
        await afterRemove?.({ ...e, attempts: e.attempts + 1 }).catch(() => undefined);
      } catch (err) {
        const attempts = e.attempts + 1;
        if (attempts >= MAX_ATTEMPTS || !isRetryableDeleteError(err)) {
          gaveUp.push(e.path);
          outcome.set(e.path, null);
        } else {
          stillLocked.push(e.path);
          outcome.set(e.path, { ...e, attempts, nextAttemptAt: this.now() + cleanupBackoffMs(attempts), lastError: isLockedFileError(err) ? 'locked' : 'denied' });
        }
      }
    }
    // Re-read: a folder scheduled while this ran must not be lost.
    const next = this.list().flatMap((e) => {
      const key = [...outcome.keys()].find((k) => samePathLoose(k, e.path));
      if (key === undefined) return [e];
      const o = outcome.get(key);
      return o ? [o] : [];
    });
    this.save(next);
    return { removed, stillLocked, gaveUp };
  }
}

export interface CleanupSchedulerOptions {
  queue: CleanupQueue;
  /** After a folder is gone (`git worktree prune` of its project). */
  afterRemove?: (e: PendingCleanup) => Promise<void>;
  /** A folder was removed by a retry (`attempts` includes this try). */
  onRemoved?: (e: PendingCleanup) => void;
  onGaveUp?: (path: string) => void;
  intervalMs?: number;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
}

/**
 * Retries the queue every `intervalMs` (5 min) while oIDE runs; each folder waits out its own
 * backoff (`cleanupBackoffMs`). `retryNow` (Settings › Diagnostics › Retry now) ignores the backoff.
 * One run at a time.
 */
export class CleanupScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<RunResult> | undefined;

  constructor(private readonly o: CleanupSchedulerOptions) {}

  get queue(): CleanupQueue {
    return this.o.queue;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? CLEANUP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One background round: only folders whose backoff has passed. */
  tick(): Promise<RunResult> {
    return this.run({ dueOnly: true });
  }

  /** Every queued folder now (or just `path`). */
  retryNow(path?: string): Promise<RunResult> {
    return this.run(path !== undefined ? { only: path } : {});
  }

  private async run(opts: { dueOnly?: boolean; only?: string }): Promise<RunResult> {
    if (this.running) await this.running.catch(() => undefined);
    if (!this.o.queue.list().length) return { removed: [], stillLocked: [], gaveUp: [] };
    const removedEntries: PendingCleanup[] = [];
    const p = this.o.queue.runPending(async (e) => {
      removedEntries.push(e);
      await this.o.afterRemove?.(e);
    }, opts);
    this.running = p;
    try {
      const r = await p;
      for (const e of removedEntries) this.o.onRemoved?.(e);
      for (const g of r.gaveUp) this.o.onGaveUp?.(g);
      if (r.removed.length || r.gaveUp.length) this.o.log?.debug('worktree cleanup', { removed: r.removed.length, stillLocked: r.stillLocked.length, gaveUp: r.gaveUp.length });
      return r;
    } finally {
      if (this.running === p) this.running = undefined;
    }
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

/** The folder's own name, for "Finished removing <name>". */
export function folderName(path: string): string {
  return basename(path.replace(/[\\/]+$/, '')) || path;
}
