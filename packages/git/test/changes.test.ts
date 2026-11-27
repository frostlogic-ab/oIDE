import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutChanges, discardCheckoutChanges, originalContent, parseNameStatusZ } from '../src/changes.js';
import { cleanup, commitAll, makeRepo, sh, write } from './helpers.js';

afterAll(cleanup);

describe('parseNameStatusZ', () => {
  it('reads statuses and renames', () => {
    expect(parseNameStatusZ('M\0a.ts\0A\0b.ts\0D\0c.ts\0R100\0old.ts\0new.ts\0U\0d.ts\0T\0e\0')).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
      { path: 'c.ts', status: 'deleted' },
      { path: 'new.ts', status: 'renamed', oldPath: 'old.ts' },
      { path: 'd.ts', status: 'conflicted' },
      { path: 'e', status: 'modified' },
    ]);
  });
});

describe('checkoutChanges (main checkout, against HEAD)', () => {
  it('lists modified, deleted, staged-new and untracked files, and discards each', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'src/c.txt': 'c\n' });
    write(repo, 'a.txt', 'a2\n');
    rmSync(join(repo, 'b.txt'));
    write(repo, 'staged.txt', 's\n');
    sh(repo, 'add', 'staged.txt');
    write(repo, 'new/dir/u.txt', 'u\n');
    write(repo, '.gitignore', 'ignored.log\n');
    write(repo, 'ignored.log', 'x\n');

    const { changes, truncated } = await checkoutChanges(repo);
    expect(truncated).toBe(false);
    expect(changes).toEqual([
      { path: '.gitignore', status: 'untracked' },
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'deleted' },
      { path: 'new/dir/u.txt', status: 'untracked' },
      { path: 'staged.txt', status: 'added' },
    ]);

    const reverted = await discardCheckoutChanges(repo, ['a.txt', 'b.txt', 'staged.txt', 'new/dir/u.txt', 'src/c.txt']);
    expect(reverted.sort()).toEqual(['a.txt', 'b.txt', 'new/dir/u.txt', 'staged.txt']);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('b\n');
    expect(existsSync(join(repo, 'staged.txt'))).toBe(false);
    expect(existsSync(join(repo, 'new/dir/u.txt'))).toBe(false);
    expect((await checkoutChanges(repo)).changes).toEqual([{ path: '.gitignore', status: 'untracked' }]);
  });

  it('refuses when none of the paths changed', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    await expect(discardCheckoutChanges(repo, ['a.txt'])).rejects.toThrow(/no changes/);
  });
});

describe('checkoutChanges (agent worktree, against the base branch)', () => {
  it('includes committed branch changes and discards them back to the base', async () => {
    const repo = makeRepo({ 'keep.txt': 'k\n', 'edit.txt': 'e\n', 'gone.txt': 'g\n' });
    sh(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'edit.txt', 'e2\n');
    rmSync(join(repo, 'gone.txt'));
    write(repo, 'added.txt', 'n\n');
    commitAll(repo, 'branch work');
    // main moves on: its own changes are not the branch's.
    sh(repo, 'checkout', '-q', 'main');
    write(repo, 'main-only.txt', 'm\n');
    commitAll(repo, 'main work');
    sh(repo, 'checkout', '-q', 'feature');
    write(repo, 'later.txt', 'l\n');

    const { changes } = await checkoutChanges(repo, 'main');
    expect(changes).toEqual([
      { path: 'added.txt', status: 'added' },
      { path: 'edit.txt', status: 'modified' },
      { path: 'gone.txt', status: 'deleted' },
      { path: 'later.txt', status: 'untracked' },
    ]);
    // Against HEAD only the uncommitted file shows.
    expect((await checkoutChanges(repo)).changes).toEqual([{ path: 'later.txt', status: 'untracked' }]);

    await discardCheckoutChanges(repo, ['added.txt', 'edit.txt', 'gone.txt'], 'main');
    expect(existsSync(join(repo, 'added.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'edit.txt'), 'utf8')).toBe('e\n');
    expect(readFileSync(join(repo, 'gone.txt'), 'utf8')).toBe('g\n');
    expect((await checkoutChanges(repo, 'main')).changes).toEqual([{ path: 'later.txt', status: 'untracked' }]);
  });

  it('treats everything as new before the first commit', async () => {
    const repo = makeRepo();
    const fresh = join(repo, '..', 'fresh');
    sh(join(repo, '..'), 'init', '-q', '-b', 'main', 'fresh');
    write(fresh, 'a.txt', 'a\n');
    sh(fresh, 'add', 'a.txt');
    write(fresh, 'b.txt', 'b\n');
    expect((await checkoutChanges(fresh)).changes).toEqual([
      { path: 'a.txt', status: 'added' },
      { path: 'b.txt', status: 'untracked' },
    ]);
    await discardCheckoutChanges(fresh, ['a.txt', 'b.txt']);
    expect(existsSync(join(fresh, 'a.txt'))).toBe(false);
    expect(existsSync(join(fresh, 'b.txt'))).toBe(false);
  });
});

describe('originalContent', () => {
  it('reads the HEAD version in the main checkout, and the merge-base version in a branch', async () => {
    const repo = makeRepo({ 'a.txt': 'one\n', 'bin.dat': 'x\0y' });
    write(repo, 'a.txt', 'two\n');
    expect(await originalContent(repo, 'a.txt')).toEqual({ kind: 'text', content: 'one\n' });
    expect(await originalContent(repo, 'bin.dat')).toEqual({ kind: 'binary' });
    expect(await originalContent(repo, 'new.txt')).toEqual({ kind: 'missing' });

    sh(repo, 'checkout', '-q', '-b', 'feature');
    commitAll(repo, 'branch work');
    write(repo, 'a.txt', 'three\n');
    // Against HEAD: the branch's commit; against main: what the branch started from.
    expect(await originalContent(repo, 'a.txt')).toEqual({ kind: 'text', content: 'two\n' });
    expect(await originalContent(repo, 'a.txt', 'main')).toEqual({ kind: 'text', content: 'one\n' });
  });

  it('has no original before the first commit', async () => {
    const repo = makeRepo();
    const fresh = join(repo, '..', 'fresh-original');
    sh(join(repo, '..'), 'init', '-q', '-b', 'main', 'fresh-original');
    write(fresh, 'a.txt', 'a\n');
    expect(await originalContent(fresh, 'a.txt')).toEqual({ kind: 'missing' });
  });
});
