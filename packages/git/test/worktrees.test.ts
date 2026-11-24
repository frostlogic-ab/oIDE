import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WorktreeManager, defaultBranch, parseWorktreeList, slugify } from '../src/worktrees.js';
import { detectOverlaps, intersectChangedFiles } from '../src/overlaps.js';
import { isInside, samePath } from '../src/paths.js';
import { parsePrView, GhCli } from '../src/gh.js';
import { cleanup, commitAll, makeRepo, sh, tempDir, write } from './helpers.js';

afterAll(cleanup);

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
