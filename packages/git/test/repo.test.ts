import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Git, GitError } from '../src/git.js';
import { parseStatusV2, status, syncState } from '../src/status.js';
import { changedFiles, diffStat, fileDiffs, parseNumstatZ } from '../src/diff.js';
import { fileHistory, log } from '../src/log.js';
import { mergeLocal, predictConflicts } from '../src/merge.js';
import { commit, discard } from '../src/commit.js';
import { fetch, pull, push } from '../src/remote.js';
import { cleanup, commitAll, makeRepo, sh, tempDir, write } from './helpers.js';

afterAll(cleanup);

describe('Git runner', () => {
  it('runs git, reports stderr on failure, and never prompts', async () => {
    const repo = makeRepo();
    const git = new Git({ cwd: repo });
    expect(await git.isRepo()).toBe(true);
    expect(await git.currentBranch()).toBe('main');
    await expect(git.run(['rev-parse', '--verify', 'nope'])).rejects.toBeInstanceOf(GitError);
    try {
      await git.run(['checkout', 'does-not-exist']);
    } catch (e) {
      expect((e as GitError).stderr).toMatch(/did not match|pathspec/);
      expect((e as GitError).exitCode).not.toBe(0);
    }
    expect(await git.revParse('HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.revParse('nope')).toBeUndefined();
  });
});

describe('status', () => {
  it('parses porcelain v2 with branch, renames, unmerged and untracked', () => {
    const text = [
      '# branch.oid abc',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 a b src/my file.ts',
      '2 R. N... 100644 100644 100644 a b R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? untracked dir/f.txt',
      '',
    ].join('\0');
    const s = parseStatusV2(text);
    expect(s).toMatchObject({ branch: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 3, detached: false });
    expect(s.entries.map((e) => [e.path, e.kind, e.staged, e.unstaged])).toEqual([
      ['src/my file.ts', 'changed', false, true],
      ['new name.ts', 'renamed', true, false],
      ['conflict.ts', 'unmerged', true, true],
      ['untracked dir/f.txt', 'untracked', false, true],
    ]);
    expect(s.entries[1]!.origPath).toBe('old name.ts');
  });

  it('reads a real checkout with upstream ahead/behind', async () => {
    const origin = makeRepo({ 'a.txt': 'a\n' });
    const clone = join(tempDir(), 'clone');
    sh(origin, 'clone', '-q', origin, clone);
    write(origin, 'b.txt', 'b\n');
    commitAll(origin, 'origin moves');
    write(clone, 'c.txt', 'c\n');
    commitAll(clone, 'local work');
    write(clone, 'dirty.txt', 'x');
    write(clone, 'a.txt', 'changed\n');
    await fetch(clone);
    const st = await syncState(clone, { lastFetchAt: 5 });
    expect(st).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 1, lastFetchAt: 5 });
    expect(st.dirtyFiles.sort()).toEqual(['a.txt', 'dirty.txt']);
    const full = await status(clone);
    expect(full.oid).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('diff', () => {
  it('counts committed + uncommitted + untracked changes against the merge-base once', async () => {
    const repo = makeRepo({ 'a.txt': '1\n2\n3\n', 'del.txt': 'gone\n', 'ren.txt': 'r1\nr2\nr3\nr4\nr5\n' });
    sh(repo, 'checkout', '-q', '-b', 'oide/x');
    write(repo, 'a.txt', '1\nTWO\n3\n');
    commitAll(repo, 'commit on branch');
    // main moves on; must not show up in the agent diff
    sh(repo, 'checkout', '-q', 'main');
    write(repo, 'main-only.txt', 'm\n');
    commitAll(repo, 'main moves');
    sh(repo, 'checkout', '-q', 'oide/x');
    // uncommitted edits on top of the commit
    write(repo, 'a.txt', '1\nTWO\n3\n4\n');
    rmSync(join(repo, 'del.txt'));
    sh(repo, 'mv', 'ren.txt', 'renamed.txt');
    write(repo, 'new dir/new file.txt', 'n1\nn2\n');
    write(repo, 'bin.dat', Buffer.from([0, 1, 2, 3, 0]));

    const stat = await diffStat(repo, 'main');
    const files = await fileDiffs(repo, 'main');
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'bin.dat', 'del.txt', 'new dir/new file.txt', 'renamed.txt']);
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byPath['del.txt']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(byPath['renamed.txt']).toMatchObject({ status: 'renamed', oldPath: 'ren.txt' });
    expect(byPath['new dir/new file.txt']).toMatchObject({ status: 'added', additions: 2, binary: false });
    expect(byPath['new dir/new file.txt']!.patch).toBe('@@ -0,0 +1,2 @@\n+n1\n+n2\n');
    expect(byPath['bin.dat']).toMatchObject({ status: 'added', binary: true });
    expect(stat).toEqual({ files: 5, additions: 4, deletions: 2 });

    expect(await changedFiles(repo, 'main')).toEqual(['a.txt', 'bin.dat', 'del.txt', 'new dir/new file.txt', 'renamed.txt']);
    expect(await changedFiles(repo, 'main', { includeUncommitted: false })).toEqual(['a.txt']);
    expect(await diffStat(repo, 'main', { includeUncommitted: false })).toEqual({ files: 1, additions: 1, deletions: 1 });
  });

  it('parses numstat -z renames', () => {
    expect(parseNumstatZ('1\t2\ta.txt\0' + '0\t0\t\0old.txt\0new.txt\0' + '-\t-\tb.png\0')).toEqual([
      { path: 'a.txt', additions: 1, deletions: 2, binary: false },
      { path: 'new.txt', oldPath: 'old.txt', additions: 0, deletions: 0, binary: false },
      { path: 'b.png', additions: 0, deletions: 0, binary: true },
    ]);
  });
});

describe('log and commit', () => {
  it('commits selected files with the Oide-Agent trailer and reads it back', async () => {
    const repo = makeRepo({ 'keep.txt': 'k\n', 'gone.txt': 'g\n' });
    write(repo, 'picked.txt', 'p\n');
    write(repo, 'not-picked.txt', 'n\n');
    rmSync(join(repo, 'gone.txt'));
    const c = await commit(repo, { message: 'Add picked\n\nLonger body.', files: ['picked.txt', 'gone.txt'], agent: 'Scaffold agent' });
    expect(c).toMatchObject({ message: 'Add picked', author: 'Test User', agent: 'Scaffold agent' });
    expect(c.body).toContain('Longer body.');
    const st = await status(repo);
    expect(st.entries.map((e) => e.path)).toEqual(['not-picked.txt']);

    const all = await commit(repo, { message: 'Everything else' });
    expect(all.agent).toBeUndefined();
    const commits = await log(repo, 'HEAD', 10);
    expect(commits.map((x) => x.message)).toEqual(['Everything else', 'Add picked', 'init']);
    expect(commits[1]!.ts).toBeGreaterThan(1_600_000_000_000);
    const hist = await fileHistory(repo, 'picked.txt');
    expect(hist.map((x) => x.message)).toEqual(['Add picked']);
  });

  it('reverts picked changes: edits, deletions, staged and untracked files and renames', async () => {
    const repo = makeRepo({ 'edit.txt': 'e\n', 'gone.txt': 'g\n', 'keep.txt': 'k\n', 'old.txt': 'o\n', 'a b.txt': 'x\n' });
    write(repo, 'edit.txt', 'changed\n');
    write(repo, 'keep.txt', 'mine\n');
    write(repo, 'a b.txt', 'spaced\n');
    rmSync(join(repo, 'gone.txt'));
    write(repo, 'new/staged.txt', 's\n');
    write(repo, 'new/untracked[1].txt', 'u\n');
    sh(repo, 'add', 'new/staged.txt');
    sh(repo, 'mv', 'old.txt', 'renamed.txt');

    const reverted = await discard(repo, {
      files: ['edit.txt', 'gone.txt', 'new/staged.txt', 'new/untracked[1].txt', 'renamed.txt', 'a b.txt', 'not-a-change.txt', '../outside.txt'],
    });
    expect(reverted.sort()).toEqual(['a b.txt', 'edit.txt', 'gone.txt', 'new/staged.txt', 'new/untracked[1].txt', 'renamed.txt']);
    expect((await status(repo)).entries.map((e) => e.path)).toEqual(['keep.txt']);
    expect(readFileSync(join(repo, 'edit.txt'), 'utf8')).toBe('e\n');
    expect(existsSync(join(repo, 'gone.txt'))).toBe(true);
    expect(existsSync(join(repo, 'old.txt'))).toBe(true);
    expect(existsSync(join(repo, 'renamed.txt'))).toBe(false);
    expect(existsSync(join(repo, 'new/staged.txt'))).toBe(false);
    expect(existsSync(join(repo, 'new/untracked[1].txt'))).toBe(false);

    expect(await discard(repo)).toEqual(['keep.txt']);
    expect((await status(repo)).entries).toEqual([]);
    await expect(discard(repo)).rejects.toThrow(/no uncommitted changes/);
    await expect(discard(repo, { files: [] })).rejects.toThrow(/No files selected/);
  });

  it('returns no commits for an unborn branch', async () => {
    const dir = join(tempDir(), 'empty');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main');
    expect(await log(dir)).toEqual([]);
    const st = await syncState(dir);
    expect(st.branch).toBe('main');
  });
});

describe('merge', () => {
  function conflicting() {
    const repo = makeRepo({ 'f.txt': 'a\nb\nc\n', 'other.txt': 'o\n' });
    sh(repo, 'checkout', '-q', '-b', 'oide/x');
    write(repo, 'f.txt', 'a\nX\nc\n');
    commitAll(repo, 'x');
    sh(repo, 'checkout', '-q', '-b', 'oide/y', 'main');
    write(repo, 'f.txt', 'a\nY\nc\n');
    commitAll(repo, 'y');
    sh(repo, 'checkout', '-q', '-b', 'oide/z', 'main');
    write(repo, 'other.txt', 'z\n');
    commitAll(repo, 'z');
    sh(repo, 'checkout', '-q', 'main');
    return repo;
  }

  it('predicts conflicts with merge-tree', async () => {
    const repo = conflicting();
    expect(await predictConflicts(repo, 'oide/x', 'oide/y')).toMatchObject({ conflicts: true, files: ['f.txt'] });
    const clean = await predictConflicts(repo, 'oide/x', 'oide/z');
    expect(clean.conflicts).toBe(false);
    expect(clean.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('merges with --no-ff and aborts on conflicts', async () => {
    const repo = conflicting();
    const ok = await mergeLocal(repo, 'oide/x');
    expect(ok.ok).toBe(true);
    expect(sh(repo, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ')).toHaveLength(3);
    const bad = await mergeLocal(repo, 'oide/y');
    expect(bad).toMatchObject({ ok: false, conflicts: ['f.txt'] });
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(sh(repo, 'status', '--porcelain').trim()).toBe('');
    expect((await mergeLocal(repo, 'nope')).error).toMatch(/Unknown branch/);
  });
});

describe('remote', () => {
  it('pulls fast-forward only and pushes with upstream', async () => {
    const bare = join(tempDir(), 'origin.git');
    sh(tempDir(), 'init', '-q', '--bare', '-b', 'main', bare);
    const a = makeRepo({ 'x.txt': '1\n' });
    sh(a, 'remote', 'add', 'origin', bare);
    await push(a);
    const b = join(tempDir(), 'b');
    sh(a, 'clone', '-q', bare, b);
    write(a, 'y.txt', '2\n');
    commitAll(a, 'second');
    await push(a);
    await pull(b);
    expect(existsSync(join(b, 'y.txt'))).toBe(true);
    // diverged: ff-only refuses instead of merging
    write(a, 'z.txt', '3\n');
    commitAll(a, 'third');
    await push(a);
    write(b, 'w.txt', '4\n');
    commitAll(b, 'local');
    await expect(pull(b)).rejects.toBeInstanceOf(GitError);
    writeFileSync(join(b, 'unused'), '');
  });
});
