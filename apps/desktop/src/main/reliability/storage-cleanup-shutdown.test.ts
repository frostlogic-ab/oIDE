import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CleanupQueue, isLockedFileError, lockedFolderMessage } from './cleanup-queue.js';
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
  it('classifies lock errors', () => {
    expect(isLockedFileError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true);
    expect(isLockedFileError(new Error('The process cannot access the file because it is being used by another process'))).toBe(true);
    expect(isLockedFileError(new Error('fatal: not a git repository'))).toBe(false);
    expect(lockedFolderMessage('C:\\wt\\a', true)).toMatch(/Close programs using this folder.*next time it starts/);
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
