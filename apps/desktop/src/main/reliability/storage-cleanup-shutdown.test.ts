import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupQueue, CleanupScheduler, MAX_ATTEMPTS, cleanupBackoffMs, isLockedFileError, isRetryableDeleteError, lockedFolderMessage } from './cleanup-queue.js';
import { groupHolders } from './folder-holders.js';
import { removeSync } from './fs-safe.js';
import { runShutdown } from './shutdown.js';
import { BufferedWriter, StorageErrorReporter } from './storage-errors.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'oide rel ünï 文-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeSync(d);
});

const quiet = { warn: () => {}, info: () => {} };
const diskFull = () => Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' });

describe('event appends when the disk is full', () => {
  it('queue events, tell the user once, write them in order once space is back', () => {
    const notices: string[] = [];
    const written: number[] = [];
    let full = false;
    const reporter = new StorageErrorReporter({ notify: (l, m) => notices.push(`${l}:${m}`), log: quiet });
    const w = new BufferedWriter<number>((n) => {
      if (full) throw diskFull();
      written.push(n);
    }, reporter);
    w.push(1);
    full = true;
    w.push(2);
    w.push(3);
    expect(w.queued).toBe(2);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^error:The disk is full/);
    full = false;
    w.push(4);
    expect(written).toEqual([1, 2, 3, 4]);
    expect(notices[1]).toMatch(/^info:Agent events are being saved again/);
  });

  it('bounded queue drops the oldest; a bad row is dropped, not retried', () => {
    const reporter = new StorageErrorReporter({ notify: () => {}, log: quiet });
    let mode: 'full' | 'bad' = 'full';
    const w = new BufferedWriter<number>(() => {
      throw mode === 'full' ? diskFull() : new Error('FOREIGN KEY constraint failed');
    }, reporter, 3);
    for (let i = 0; i < 5; i++) w.push(i);
    expect([w.queued, w.dropped]).toEqual([3, 2]);
    mode = 'bad';
    expect(w.flush()).toBe(true);
    expect(w.queued).toBe(0);
  });
});

describe('cleanup queue (Windows locked worktree folders)', () => {
  it('classifies lock errors precisely', () => {
    expect(isLockedFileError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true);
    expect(isLockedFileError(Object.assign(new Error("EBUSY: resource busy or locked, rmdir 'C:\\wt'"), { code: 'EBUSY' }))).toBe(true);
    expect(isLockedFileError(new Error('The process cannot access the file because it is being used by another process'))).toBe(true);
    expect(isLockedFileError(new Error('fatal: not a git repository'))).toBe(false);
    // Not locks: fs.rm retries these itself; git's long-path and junction failures never were.
    for (const code of ['ENOTEMPTY', 'EPERM', 'EACCES']) expect(isLockedFileError(Object.assign(new Error(code), { code }))).toBe(false);
    expect(isLockedFileError(new Error("error: unable to delete 'node_modules/x': Filename too long"))).toBe(false);
    expect(isLockedFileError(new Error('fatal: failed to delete: Directory not empty'))).toBe(false);
    expect(isLockedFileError(new Error('Permission denied'))).toBe(false);
    // ...but a denial is still worth retrying later; other errors are not.
    expect(isRetryableDeleteError(Object.assign(new Error('EPERM'), { code: 'EPERM' }))).toBe(true);
    expect(isRetryableDeleteError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true);
    expect(isRetryableDeleteError(new Error('weird'))).toBe(false);
  });

  it('builds the notice from the holders, never with other folders', () => {
    const docker = groupHolders([{ pid: 1, exe: 'com.docker.backend.exe' }]);
    expect(lockedFolderMessage('C:\\wt\\a', true, docker)).toBe('Could not delete the worktree folder C:\\wt\\a. Docker Desktop (com.docker.backend.exe) still has this folder open. Quit it, and oIDE will finish removing the folder.');
    const two = groupHolders([
      { pid: 1, exe: 'Code.exe' },
      { pid: 2, exe: 'node.exe' },
    ]);
    expect(lockedFolderMessage('C:\\wt\\a', true, two)).toBe('Could not delete the worktree folder C:\\wt\\a. VS Code (Code.exe) and Node.js (node.exe) still have this folder open. Quit them, and oIDE will finish removing the folder.');
    expect(lockedFolderMessage('C:\\wt\\a', true)).toMatch(/Close programs using this folder.*keeps trying in the background/);
    expect(lockedFolderMessage('C:\\wt\\a', true, [], false)).toMatch(/denied access/);
    expect(cleanupBackoffMs(1)).toBe(5 * 60_000);
    expect(cleanupBackoffMs(3)).toBe(20 * 60_000);
    expect(cleanupBackoffMs(30)).toBe(2 * 60 * 60_000);
  });

  it('retries in the background every 5 minutes with backoff, and reports a success once', async () => {
    vi.useFakeTimers();
    try {
      const userData = tmp();
      const folder = join(userData, 'worktrees', 'p', 'held');
      mkdirSync(folder, { recursive: true });
      let held = true;
      let tries = 0;
      const rm = async (p: string) => {
        tries++;
        if (held) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        removeSync(p);
      };
      const q = new CleanupQueue(userData, { rm, now: () => Date.now() });
      q.schedule(folder, 'C:\\proj');
      const done: Array<{ path: string; attempts: number }> = [];
      const pruned: string[] = [];
      const s = new CleanupScheduler({ queue: q, afterRemove: async (e) => void pruned.push(e.projectPath!), onRemoved: (e) => done.push({ path: e.path, attempts: e.attempts }) });
      s.start();
      // First background try after 5 minutes (scheduling set nextAttemptAt).
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(tries).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(tries).toBe(1);
      expect(q.list()[0]).toMatchObject({ attempts: 1, lastError: 'locked' });
      // Backoff: the next try waits 5 minutes, the one after 10.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(tries).toBe(2);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(tries).toBe(2);
      held = false;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(tries).toBe(3);
      expect(done).toEqual([{ path: folder, attempts: 3 }]);
      expect(pruned).toEqual(['C:\\proj']);
      expect(q.list()).toEqual([]);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(tries).toBe(3);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Retry now ignores the backoff and acts only on a queued folder', async () => {
    const userData = tmp();
    const a = join(userData, 'a');
    const b = join(userData, 'b');
    mkdirSync(a);
    mkdirSync(b);
    const q = new CleanupQueue(userData);
    q.schedule(a);
    q.schedule(b);
    const s = new CleanupScheduler({ queue: q });
    expect((await s.retryNow(a)).removed).toEqual([a]);
    expect(existsSync(b)).toBe(true);
    expect(q.list().map((e) => e.path)).toEqual([b]);
    expect(q.find(join(userData, 'elsewhere'))).toBeUndefined();
  });

  it('keeps a denied folder for later and gives up after MAX_ATTEMPTS', async () => {
    const userData = tmp();
    const q = new CleanupQueue(userData, { rm: async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); } });
    q.schedule(userData);
    const r = await q.runPending();
    expect(r.stillLocked).toEqual([userData]);
    expect(q.list()[0]!.lastError).toBe('denied');
    for (let i = 1; i < MAX_ATTEMPTS - 1; i++) await q.runPending();
    expect((await q.runPending()).gaveUp).toEqual([userData]);
    expect(q.list()).toEqual([]);
  });

  it('persists scheduled folders and retries them on the next start', async () => {
    const userData = tmp();
    const folder = join(userData, 'worktrees', 'proj', 'agent one ü');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'locked.txt'), 'x');
    let locked = true;
    const rm = async (p: string) => {
      if (locked) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      removeSync(p);
    };
    const q1 = new CleanupQueue(userData, { rm });
    q1.schedule(folder, 'C:\\proj');
    q1.schedule(folder.toUpperCase() === folder ? folder : folder, 'C:\\proj'); // no duplicates
    expect(q1.list()).toHaveLength(1);
    // "Next start", still locked: kept, attempts counted.
    expect(await new CleanupQueue(userData, { rm }).runPending()).toEqual({ removed: [], stillLocked: [folder], gaveUp: [] });
    expect(new CleanupQueue(userData).list()[0]!.attempts).toBe(1);
    locked = false;
    const pruned: string[] = [];
    const r = await new CleanupQueue(userData, { rm }).runPending(async (e) => void pruned.push(e.projectPath!));
    expect(r.removed).toEqual([folder]);
    expect(pruned).toEqual(['C:\\proj']);
    expect(existsSync(folder)).toBe(false);
    expect(new CleanupQueue(userData).list()).toEqual([]);
  });

  it('removeSync deletes non-ASCII trees (some Node rmSync builds silently skip them on Windows)', () => {
    const root = join(tmp(), 'zoë 文档');
    mkdirSync(join(root, 'sub ü'), { recursive: true });
    writeFileSync(join(root, 'sub ü', 'f.txt'), 'x');
    removeSync(root);
    expect(existsSync(root)).toBe(false);
    expect(() => removeSync(root)).not.toThrow();
  });

  it('gives up on non-lock errors', async () => {
    const userData = tmp();
    const q = new CleanupQueue(userData, { rm: async () => { throw new Error('weird'); } });
    q.schedule(userData);
    expect((await q.runPending()).gaveUp).toEqual([userData]);
  });
});

describe('runShutdown', () => {
  it('runs steps in order, survives failures and timeouts, and keeps the last step', async () => {
    const order: string[] = [];
    const res = await runShutdown(
      [
        { name: 'terminals', fn: () => void order.push('terminals') },
        { name: 'broken', fn: () => { throw new Error('x'); } },
        { name: 'hangs', fn: () => new Promise(() => {}), timeoutMs: 30 },
        { name: 'db', fn: async () => void order.push('db') },
      ],
      { totalMs: 2000 },
    );
    expect(order).toEqual(['terminals', 'db']);
    expect(res.map((r) => r.outcome)).toEqual(['ok', 'error', 'timeout', 'ok']);
  });

  it('skips steps once the total budget is spent', async () => {
    let t = 0;
    const res = await runShutdown(
      [
        { name: 'a', fn: () => void (t += 100) },
        { name: 'b', fn: () => {} },
      ],
      { totalMs: 50, now: () => t },
    );
    expect(res.map((r) => r.outcome)).toEqual(['ok', 'skipped']);
  });
});
