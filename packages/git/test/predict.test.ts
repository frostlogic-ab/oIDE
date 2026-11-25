import { afterAll, describe, expect, it } from 'vitest';
import { Git, GitError, type GitResult, type GitRunOptions } from '../src/git.js';
import { parseMergeTree, predictMerge } from '../src/merge.js';
import { cleanup, commitAll, makeRepo, sh, write } from './helpers.js';

afterAll(cleanup);

/**
 * "Merge into main?" predicts before it merges: `predictMerge` runs `git merge-tree --write-tree`
 * between the main checkout's HEAD and the agent branch (no checkout touched), against real
 * temporary repositories.
 */

/** main has one more commit than `oide/agent`; both changed line 2 of f.txt. `oide/clean` changed another file. */
function diverged() {
  const repo = makeRepo({ 'f.txt': 'a\nb\nc\n', 'other.txt': 'o\n' });
  sh(repo, 'checkout', '-q', '-b', 'oide/agent');
  write(repo, 'f.txt', 'a\nAGENT\nc\n');
  commitAll(repo, 'agent change');
  sh(repo, 'checkout', '-q', '-b', 'oide/clean', 'main');
  write(repo, 'other.txt', 'clean\n');
  commitAll(repo, 'clean change');
  sh(repo, 'checkout', '-q', 'main');
  write(repo, 'f.txt', 'a\nMAIN\nc\n');
  commitAll(repo, 'main change');
  return repo;
}

describe('predictMerge', () => {
  it('reports the conflicted files, the target branch and commit, and how far behind the branch is', async () => {
    const repo = diverged();
    const head = sh(repo, 'rev-parse', 'HEAD').trim();
    const p = await predictMerge(repo, 'oide/agent');
    expect(p).toMatchObject({ supported: true, conflicts: true, files: ['f.txt'], binary: [], submodules: [], target: { branch: 'main', sha: head }, behind: 1, ahead: 1 });
    expect(p.branchSha).toBe(sh(repo, 'rev-parse', 'oide/agent').trim());
    // Nothing was touched: still on main, clean, no merge in progress.
    expect(sh(repo, 'status', '--porcelain').trim()).toBe('');
    expect(sh(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
  });

  it('is clean when the branch merges without conflicts', async () => {
    const repo = diverged();
    expect(await predictMerge(repo, 'oide/clean')).toMatchObject({ supported: true, conflicts: false, files: [], behind: 1, ahead: 1 });
  });

  it('after the agent merges main into its branch and resolves, the prediction is clean and not behind', async () => {
    const repo = diverged();
    sh(repo, 'checkout', '-q', 'oide/agent');
    try {
      sh(repo, 'merge', '--no-edit', 'main');
    } catch {
      // The conflict the prediction saw.
    }
    write(repo, 'f.txt', 'a\nAGENT and MAIN\nc\n');
    commitAll(repo, 'Merge main into oide/agent');
    sh(repo, 'checkout', '-q', 'main');
    expect(await predictMerge(repo, 'oide/agent')).toMatchObject({ supported: true, conflicts: false, files: [], behind: 0, ahead: 2 });
  });

  it('calls out binary conflicts, and lists modify/delete conflicts too', async () => {
    const repo = makeRepo({ 'gone.txt': 'keep\n' });
    write(repo, 'img.bin', Buffer.from([0, 1, 2, 3]));
    commitAll(repo, 'binary');
    sh(repo, 'checkout', '-q', '-b', 'oide/bin');
    write(repo, 'img.bin', Buffer.from([0, 9, 9, 9]));
    write(repo, 'gone.txt', 'agent edit\n');
    commitAll(repo, 'agent');
    sh(repo, 'checkout', '-q', 'main');
    write(repo, 'img.bin', Buffer.from([0, 7, 7, 7]));
    sh(repo, 'rm', '-q', 'gone.txt');
    commitAll(repo, 'main');
    expect(await predictMerge(repo, 'oide/bin')).toMatchObject({ conflicts: true, files: ['gone.txt', 'img.bin'], binary: ['img.bin'], submodules: [] });
  });

  it('on a detached HEAD the target is the commit, with no branch name', async () => {
    const repo = diverged();
    const head = sh(repo, 'rev-parse', 'HEAD').trim();
    sh(repo, 'checkout', '-q', '--detach', 'HEAD');
    const p = await predictMerge(repo, 'oide/agent');
    expect(p.target).toEqual({ sha: head });
    expect(p.conflicts).toBe(true);
  });

  it('falls back to supported: false when git is too old for merge-tree --write-tree', async () => {
    const repo = diverged();
    // git < 2.38 rejects --write-tree with a usage error (exit 129); everything else still works.
    class OldGit extends Git {
      override async run(args: readonly string[], opts?: GitRunOptions): Promise<GitResult> {
        if (args[0] === 'merge-tree') throw new GitError('git merge-tree failed', args, 129, "error: unknown option `write-tree'\nusage: git merge-tree <base-tree> <branch1> <branch2>", '');
        return super.run(args, opts);
      }
    }
    const p = await predictMerge(new OldGit({ cwd: repo }), 'oide/agent');
    expect(p).toMatchObject({ supported: false, conflicts: false, files: [], behind: 1, ahead: 1, target: { branch: 'main' } });
    expect(p.error).toMatch(/unknown option/);
  });

  it('rejects an unknown branch', async () => {
    const repo = makeRepo();
    await expect(predictMerge(repo, 'oide/nope')).rejects.toThrow(/Unknown branch/);
  });
});

describe('parseMergeTree', () => {
  it('reads conflicted stages, submodule modes and binary messages', () => {
    const out = [
      'f41f77dcf0d610e8d366f3d4ee4550387d57eeb3',
      '100644 1111111111111111111111111111111111111111 1\tb.bin',
      '100644 2222222222222222222222222222222222222222 2\tb.bin',
      '160000 3333333333333333333333333333333333333333 2\tvendor/lib',
      '160000 4444444444444444444444444444444444444444 3\tvendor/lib',
      '100644 5555555555555555555555555555555555555555 2\tsrc/a b.ts',
      '',
      '1',
      'b.bin',
      'CONFLICT (binary)',
      'warning: Cannot merge binary files: b.bin (main vs. x)\n',
      '1',
      'b.bin',
      'Auto-merging',
      'Auto-merging b.bin\n',
      '1',
      'vendor/lib',
      'CONFLICT (submodule)',
      'Failed to merge submodule vendor/lib\n',
      '1',
      'other.ts',
      'Auto-merging',
      'Auto-merging other.ts\n',
      '',
    ].join('\0');
    expect(parseMergeTree(out)).toEqual({ tree: 'f41f77dcf0d610e8d366f3d4ee4550387d57eeb3', files: ['b.bin', 'src/a b.ts', 'vendor/lib'], binary: ['b.bin'], submodules: ['vendor/lib'] });
  });
});

