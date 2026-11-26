import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WorktreeManager, defaultBranch, isLockError, parseWorktreeList, pushState, removeTree, slugify } from '../src/worktrees.js';
import { detectOverlaps, intersectChangedFiles } from '../src/overlaps.js';
import { isInside, samePath } from '../src/paths.js';
import { parsePrView, GhCli } from '../src/gh.js';
import { cleanup, commitAll, makeRepo, sh, tempDir, write } from './helpers.js';

afterAll(cleanup);

describe('pushState (Push to PR)', () => {
  it('counts commits the PR branch lacks and uncommitted files, ignoring an upstream that is the base', async () => {
    const remote = join(tempDir(), 'remote.git');
    sh(dirname(remote), 'init', '-q', '--bare', remote);
    const repo = makeRepo();
    sh(repo, 'remote', 'add', 'origin', remote);
    sh(repo, 'push', '-q', 'origin', 'main');
    sh(repo, 'fetch', '-q', 'origin');
    // Like a worktree made from origin/main: the branch tracks origin/main, not its own remote branch.
    sh(repo, 'checkout', '-q', '-b', 'oide/feature', '--track', 'origin/main');
    write(repo, 'a.txt', 'a\n');
    commitAll(repo, 'a');
    expect(await pushState(repo, 'oide/feature')).toEqual({ uncommitted: 0 });
    // Opened the PR: the branch is pushed and now tracks origin/oide/feature.
    sh(repo, 'push', '-q', '--set-upstream', 'origin', 'oide/feature');
    expect(await pushState(repo, 'oide/feature')).toEqual({ unpushed: 0, uncommitted: 0 });
    // Follow-up work: one new commit, then a new file and an edit not committed yet.
    write(repo, 'b.txt', 'b\n');
    commitAll(repo, 'b');
    write(repo, 'c.txt', 'c\n');
    write(repo, 'a.txt', 'changed\n');
    expect(await pushState(repo, 'oide/feature')).toEqual({ unpushed: 1, uncommitted: 2 });
    // Tracking the base again: origin/<branch> is still found.
    sh(repo, 'branch', '--set-upstream-to', 'origin/main');
    expect(await pushState(repo, 'oide/feature')).toEqual({ unpushed: 1, uncommitted: 2 });
  });
});

describe('worktree helpers', () => {
  it('slugifies', () => {
    expect(slugify('Build the window shell layout!')).toBe('build-the-window-shell-layout');
    expect(slugify('Café  über')).toBe('cafe-uber');
    expect(slugify('***')).toBe('agent');
    expect(slugify('x'.repeat(80))).toHaveLength(48);
  });

  it('parses worktree list -z', () => {
    const text = ['worktree C:/r', 'HEAD aaa', 'branch refs/heads/main', '', 'worktree C:/w/one', 'HEAD bbb', 'detached', 'locked', 'prunable gitdir file points to non-existent location', '', ''].join('\0');
    const list = parseWorktreeList(text);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ branch: 'main', main: true });
    expect(list[1]).toMatchObject({ detached: true, locked: true, prunable: true, main: false });
  });

  it('compares paths', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/..foo')).toBe(true);
    expect(samePath('/a/b/', '/a/b')).toBe(true);
  });

  it('parses gh pr view', () => {
    expect(parsePrView('{"state":"OPEN","isDraft":true,"number":18,"url":"https://github.com/o/r/pull/18"}')).toEqual({ state: 'draft', number: 18, url: 'https://github.com/o/r/pull/18' });
    expect(parsePrView('{"state":"MERGED","isDraft":false,"number":2}')).toMatchObject({ state: 'merged' });
    expect(parsePrView('nope')).toBeUndefined();
  });

  it('gh wrapper is undefined when the binary is missing', async () => {
    const gh = new GhCli({ ghBinary: 'definitely-not-gh-oide' });
    expect(await gh.available()).toBe(false);
    expect(await gh.prView(process.cwd(), 'main')).toBeUndefined();
  });

  it('intersects changed files pairwise', () => {
    const r = intersectChangedFiles(
      [
        { agentId: 'a', files: ['src/X.ts', 'b.ts'] },
        { agentId: 'b', files: ['src/x.ts'] },
        { agentId: 'c', files: ['b.ts', 'src/x.ts'] },
      ],
      true,
    );
    expect(r).toEqual([
      { agentIds: ['a', 'b'], files: ['src/X.ts'] },
      { agentIds: ['a', 'c'], files: ['b.ts', 'src/X.ts'] },
      { agentIds: ['b', 'c'], files: ['src/x.ts'] },
    ]);
    expect(intersectChangedFiles([{ agentId: 'a', files: ['A'] }, { agentId: 'b', files: ['a'] }], false)).toEqual([]);
  });
});

describe('WorktreeManager', () => {
  it('creates unique worktrees from main, current or a ref, lists, measures and removes them', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n', 'shared.txt': '1\n2\n3\n' });
    const appData = tempDir('oide-appdata-');
    const wm = new WorktreeManager({ appDataDir: appData, sleep: async () => {} });
    expect(await wm.defaultBranch(repo)).toBe('main');

    sh(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'feature.txt', 'f\n');
    commitAll(repo, 'feature commit');

    const one = await wm.create({ projectPath: repo, projectId: 'p1', agentSlug: 'Fix the flaky test', base: 'main' });
    expect(one.branch).toBe('oide/fix-the-flaky-test');
    expect(one.baseRef).toBe('main');
    expect(samePath(one.path, join(appData, 'worktrees', 'p1', 'fix-the-flaky-test'))).toBe(true);
    expect(existsSync(join(one.path, 'feature.txt'))).toBe(false);

    const two = await wm.create({ projectPath: repo, projectId: 'p1', agentSlug: 'Fix the flaky test', base: 'current' });
    expect(two.slug).toBe('fix-the-flaky-test-2');
    expect(two.baseRef).toBe('feature');
    expect(existsSync(join(two.path, 'feature.txt'))).toBe(true);

    const sib = await wm.create({ projectPath: repo, projectId: 'p1', agentSlug: 'sib', base: 'main', location: 'sibling' });
    expect(samePath(dirname(sib.path), join(dirname(repo), `${basename(repo)}.worktrees`))).toBe(true);

    const list = await wm.list(repo);
    expect(list).toHaveLength(4);
    expect(list[0]!.main).toBe(true);
    expect(list.some((w) => samePath(w.path, one.path) && w.branch === one.branch)).toBe(true);

    // Work in worktree one: commit + uncommitted; main moves on meanwhile.
    write(one.path, 'shared.txt', '1\nONE\n3\n');
    commitAll(one.path, 'one edits shared');
    write(one.path, 'scratch.txt', 's\n');
    sh(repo, 'checkout', '-q', 'main');
    write(repo, 'main2.txt', 'm\n');
    commitAll(repo, 'main moves');

    expect(await wm.aheadBehind(one.path, 'HEAD', 'main')).toEqual({ ahead: 1, behind: 1 });
    const info = await wm.info({ projectId: 'p1', path: one.path, branch: one.branch, baseRef: 'main', agentId: 'agent-1' });
    expect(info).toMatchObject({ agentId: 'agent-1', ahead: 1, behind: 1, changedFiles: ['scratch.txt', 'shared.txt'], diff: { files: 2, additions: 2, deletions: 1 } });
    // Never pushed: nothing to compare against; scratch.txt is the one uncommitted file.
    expect(info.unpushed).toBeUndefined();
    expect(info.uncommitted).toBe(1);

    // Overlaps: worktree sib edits the same file differently → real conflict.
    write(sib.path, 'shared.txt', '1\nSIB\n3\n');
    commitAll(sib.path, 'sib edits shared');
    const warnings = await detectOverlaps('p1', repo, [
      { agentId: 'agent-1', path: one.path, branch: one.branch, baseRef: 'main' },
      { agentId: 'agent-3', path: sib.path, branch: sib.branch, baseRef: 'main' },
      { agentId: 'agent-2', path: two.path, branch: two.branch, baseRef: 'feature' },
    ]);
    expect(warnings).toEqual([{ projectId: 'p1', agentIds: ['agent-1', 'agent-3'], files: ['shared.txt'], conflicts: true }]);

    // Orphans: worktrees under our roots that no agent owns, plus stray folders.
    mkdirSync(join(appData, 'worktrees', 'p1', 'stray'), { recursive: true });
    const orphans = await wm.orphans(repo, 'p1', [one.path]);
    const orphanNames = orphans.map((o) => basename(o.path)).sort();
    expect(orphanNames).toEqual(['fix-the-flaky-test-2', 'sib', 'stray']);
    expect(orphans.find((o) => basename(o.path) === 'stray')!.registered).toBe(false);

    // Remove: dirty worktree refuses without force, works with force; branch deleted on request.
    await expect(wm.remove(repo, one.path)).rejects.toThrow();
    await wm.remove(repo, one.path, { force: true, deleteBranch: true });
    expect(existsSync(one.path)).toBe(false);
    expect(sh(repo, 'branch', '--list', one.branch).trim()).toBe('');
    await wm.remove(repo, two.path);
    expect(existsSync(two.path)).toBe(false);
    expect(sh(repo, 'branch', '--list', two.branch).trim()).not.toBe('');
    await expect(wm.remove(repo, repo)).rejects.toThrow(/main checkout/);
    await wm.remove(repo, join(appData, 'worktrees', 'p1', 'stray'), { force: true });
    expect(await wm.prune(repo)).toEqual([]);
    expect(await wm.list(repo)).toHaveLength(2);
  });

  it('gives parallel creates with the same slug distinct branches (parallel attempts)', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const wm = new WorktreeManager({ appDataDir: tempDir('oide-appdata-'), sleep: async () => {} });
    const made = await Promise.all(
      [1, 2, 3].map(() => wm.create({ projectPath: repo, projectId: 'p1', agentSlug: 'map-the-routes-with-helpers', base: 'main' })),
    );
    expect(new Set(made.map((w) => w.branch)).size).toBe(3);
    expect(made.map((w) => w.slug).sort()).toEqual(['map-the-routes-with-helpers', 'map-the-routes-with-helpers-2', 'map-the-routes-with-helpers-3']);
  });

  it('runs a setup command with streamed output', async () => {
    const repo = makeRepo();
    const wm = new WorktreeManager({ appDataDir: tempDir() });
    let out = '';
    const r = await wm.runSetup(repo, 'git --version && echo setup-done', { onOutput: (c) => (out += c) });
    expect(r.exitCode).toBe(0);
    expect(out).toContain('setup-done');
    const bad = await wm.runSetup(repo, 'exit 3');
    expect(bad.exitCode).toBe(3);
  });

  it('refuses unsafe project ids and repos without commits', async () => {
    const repo = makeRepo();
    const wm = new WorktreeManager({ appDataDir: tempDir() });
    await expect(wm.create({ projectPath: repo, projectId: '../evil', agentSlug: 'x', base: 'main' })).rejects.toThrow(/Invalid project id/);
    const empty = join(tempDir(), 'empty');
    mkdirSync(empty);
    sh(empty, 'init', '-q', '-b', 'main');
    await expect(wm.create({ projectPath: empty, projectId: 'p', agentSlug: 'x', base: 'main' })).rejects.toThrow(/no commits/);
  });

  /** A pnpm-like `node_modules` (ignored): paths over 260 characters, a junction inside the tree and one to a folder outside it. */
  function pnpmLike(wt: string, outside: string): void {
    let deep = join(wt, 'node_modules', '.pnpm');
    while (deep.length < 300) deep = join(deep, '@scope+some-long-package-name@1.2.3');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'index.js'), 'x');
    write(wt, 'node_modules/.pnpm/store-pkg/i.js', 'x');
    mkdirSync(join(wt, 'node_modules', 'linked'), { recursive: true });
    symlinkSync(join(wt, 'node_modules', '.pnpm', 'store-pkg'), join(wt, 'node_modules', 'linked', 'pkg'), 'junction');
    symlinkSync(outside, join(wt, 'node_modules', 'external'), 'junction');
  }

  it('removes a worktree with long paths and junctions at once, without following junctions out of it', async () => {
    const repo = makeRepo({ '.gitignore': 'node_modules/\n', 'a.txt': 'a\n' });
    const outside = join(tempDir(), 'outside');
    write(outside, 'keep.txt', 'keep');
    const sleeps: number[] = [];
    const wm = new WorktreeManager({ appDataDir: tempDir('oide-appdata-'), sleep: async (ms) => void sleeps.push(ms) });
    const wt = await wm.create({ projectPath: repo, projectId: 'p1', agentSlug: 'x'.repeat(48), base: 'main' });
    pnpmLike(wt.path, outside);

    const started = Date.now();
    await wm.remove(repo, wt.path, { force: true, deleteBranch: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(sleeps).toEqual([]);
    expect(Date.now() - started).toBeLessThan(8000);
    // `git worktree remove` would have deleted this through the junction.
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(await wm.list(repo)).toHaveLength(1);
    expect(sh(repo, 'branch', '--list', wt.branch).trim()).toBe('');
  });

  it('without force removes a clean worktree whose ignored files git cannot delete, and still refuses a dirty one', async () => {
    const repo = makeRepo({ '.gitignore': 'node_modules/\n', 'a.txt': 'a\n' });
    const outside = join(tempDir(), 'outside');
    write(outside, 'keep.txt', 'keep');
    const wm = new WorktreeManager({ appDataDir: tempDir('oide-appdata-'), sleep: async () => {} });

    const clean = await wm.create({ projectPath: repo, projectId: 'p1', agentSlug: 'clean', base: 'main' });
    pnpmLike(clean.path, outside);
    await wm.remove(repo, clean.path);
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);

    const dirty = await wm.create({ projectPath: repo, projectId: 'p1', agentSlug: 'dirty', base: 'main' });
    pnpmLike(dirty.path, outside);
    write(dirty.path, 'new-file.txt', 'untracked\n');
    await expect(wm.remove(repo, dirty.path)).rejects.toThrow(/contains modified or untracked files/);
    expect(existsSync(join(dirty.path, 'new-file.txt'))).toBe(true);
    expect(existsSync(join(dirty.path, 'node_modules', '.pnpm', 'store-pkg', 'i.js'))).toBe(true);
    write(dirty.path, 'new-file.txt', '');
    sh(dirty.path, 'add', 'new-file.txt');
    await expect(wm.remove(repo, dirty.path)).rejects.toThrow(/contains modified or untracked files/);

    sh(repo, 'worktree', 'lock', dirty.path);
    sh(dirty.path, 'reset', '-q', '--hard');
    rmSync(join(dirty.path, 'new-file.txt'), { force: true });
    await expect(wm.remove(repo, dirty.path)).rejects.toThrow(/locked/);
    await wm.remove(repo, dirty.path, { force: true });
    expect(existsSync(dirty.path)).toBe(false);
    expect(await wm.list(repo)).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')('gives up quickly on a folder another process holds as its current directory (no compounding retries)', async () => {
    const root = join(tempDir(), 'wt');
    const inner = join(root, 'node_modules', 'a', 'b', 'pkg');
    mkdirSync(inner, { recursive: true });
    write(root, 'x.txt', 'x');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: inner, stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const sleeps: number[] = [];
      const started = Date.now();
      const err = await removeTree(root, { retries: 3, delayMs: 300, sleep: async (ms) => void sleeps.push(ms) }).catch((e: unknown) => e);
      expect(isLockError(err)).toBe(true);
      expect(sleeps).toEqual([300, 600, 900]);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(existsSync(join(root, 'x.txt'))).toBe(false);
    } finally {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
    }
    await removeTree(root);
    expect(existsSync(root)).toBe(false);
  }, 20_000);

  it('tells a held file from other delete errors', () => {
    expect(isLockError(Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' }))).toBe(true);
    expect(isLockError(new Error('The process cannot access the file because it is being used by another process'))).toBe(true);
    expect(isLockError(Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' }))).toBe(false);
    expect(isLockError(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))).toBe(false);
    expect(isLockError(new Error("error: unable to delete 'x': Filename too long"))).toBe(false);
    expect(isLockError(new Error('fatal: failed to delete: Directory not empty'))).toBe(false);
  });

  it('detects the default branch from origin HEAD and master', async () => {
    const repo = makeRepo();
    sh(repo, 'branch', '-m', 'main', 'master');
    expect(await defaultBranch(repo)).toBe('master');
    const clone = join(tempDir(), 'c');
    sh(repo, 'clone', '-q', repo, clone);
    sh(clone, 'checkout', '-q', '-b', 'other');
    expect(await defaultBranch(clone)).toBe('master');
  });
});
