import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { autoStashNote, mergeLocal, parseBlockedByLocalChanges } from '../src/merge.js';
import { cleanup, commitAll, makeRepo, sh, write } from './helpers.js';

afterAll(cleanup);

/**
 * Merge with uncommitted changes in the main checkout: the files in the way are stashed, the branch
 * merged and the stash put back; when it clashes, the files stay as merged and the stash is kept.
 */

/** `oide/other` changes line 1 of other.txt (a,b,c) and adds new.txt; main also has notes.txt. */
function withBranch() {
  const repo = makeRepo({ 'other.txt': 'a\nb\nc\n', 'notes.txt': 'n\n' });
  sh(repo, 'checkout', '-q', '-b', 'oide/other');
  write(repo, 'other.txt', 'AGENT\nb\nc\n');
  write(repo, 'new.txt', 'agent\n');
  commitAll(repo, 'other');
  sh(repo, 'checkout', '-q', 'main');
  return repo;
}

const read = (repo: string, f: string) => readFileSync(join(repo, f), 'utf8');
const status = (repo: string) => sh(repo, 'status', '--porcelain').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();

describe('mergeLocal with local changes in the main checkout', () => {
  it('stashes only the files in the way, merges, and puts them back', async () => {
    const repo = withBranch();
    write(repo, 'other.txt', 'a\nb\nMINE\n');
    write(repo, 'notes.txt', 'unrelated\n');
    const r = await mergeLocal(repo, 'oide/other');
    expect(r).toMatchObject({ ok: true, conflicts: [], autoStash: { files: ['other.txt'], restored: true } });
    expect(sh(repo, 'rev-parse', 'HEAD^2').trim()).toBe(sh(repo, 'rev-parse', 'oide/other').trim());
    expect(sh(repo, 'show', 'HEAD:other.txt')).toBe('AGENT\nb\nc\n');
    expect(read(repo, 'other.txt')).toBe('AGENT\nb\nMINE\n');
    expect(read(repo, 'notes.txt')).toBe('unrelated\n');
    expect(status(repo)).toEqual(['M notes.txt', 'M other.txt']);
    expect(sh(repo, 'stash', 'list').trim()).toBe('');
    expect(autoStashNote(r.autoStash!)).toMatch(/set aside for the merge and put back/);
  });

  it('when the changes clash with the merge: merged anyway, files left as merged, changes kept in the stash', async () => {
    const repo = withBranch();
    write(repo, 'notes.txt', 'older\n');
    sh(repo, 'stash', 'push', '-q', '-m', 'an older stash of the user');
    write(repo, 'other.txt', 'MINE\nb\nc\n');
    write(repo, 'new.txt', 'mine\n');
    write(repo, 'notes.txt', 'unrelated\n');
    const r = await mergeLocal(repo, 'oide/other');
    expect(r).toMatchObject({ ok: true, autoStash: { files: ['other.txt', 'new.txt'], restored: false, stash: expect.stringMatching(/^oide: .*oide\/other/) } });
    expect(read(repo, 'other.txt')).toBe('AGENT\nb\nc\n');
    expect(read(repo, 'new.txt')).toBe('agent\n');
    // No conflict markers or unmerged entries; the unrelated change is untouched.
    expect(status(repo)).toEqual(['M notes.txt']);
    const stashes = sh(repo, 'stash', 'list', '--format=%gs').trim().split(/\r?\n/);
    expect(stashes).toHaveLength(2);
    expect(stashes[0]).toMatch(/oide: local changes set aside to merge oide\/other/);
    expect(stashes[1]).toMatch(/an older stash of the user/);
    // The user's changes are all in that stash (tracked and untracked).
    expect(sh(repo, 'show', 'stash@{0}:other.txt')).toBe('MINE\nb\nc\n');
    expect(sh(repo, 'show', 'stash@{0}^3:new.txt')).toBe('mine\n');
    expect(autoStashNote(r.autoStash!)).toMatch(/kept in the stash .*git stash pop/);
  });

  it('when the merge then conflicts, it is aborted and the local changes are put back', async () => {
    const repo = withBranch();
    write(repo, 'notes.txt', 'MAIN\n');
    commitAll(repo, 'main notes');
    sh(repo, 'checkout', '-q', 'oide/other');
    write(repo, 'notes.txt', 'AGENT\n');
    commitAll(repo, 'agent notes');
    sh(repo, 'checkout', '-q', 'main');
    const head = sh(repo, 'rev-parse', 'HEAD').trim();
    write(repo, 'other.txt', 'a\nb\nMINE\n');
    const r = await mergeLocal(repo, 'oide/other');
    expect(r).toMatchObject({ ok: false, conflicts: ['notes.txt'], autoStash: { files: ['other.txt'], restored: true } });
    expect(sh(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(status(repo)).toEqual(['M other.txt']);
    expect(read(repo, 'other.txt')).toBe('a\nb\nMINE\n');
    expect(sh(repo, 'stash', 'list').trim()).toBe('');
  });

  it('with autoStash: false, refuses with a clear message naming the files, and changes nothing', async () => {
    const repo = withBranch();
    write(repo, 'other.txt', 'uncommitted\n');
    const head = sh(repo, 'rev-parse', 'HEAD').trim();
    const r = await mergeLocal(repo, 'oide/other', { autoStash: false });
    expect(r).toMatchObject({ ok: false, conflicts: [], blockedBy: ['other.txt'] });
    expect(r.error).toMatch(/uncommitted changes .*other\.txt.*Commit or stash them/);
    expect(sh(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(status(repo)).toEqual(['M other.txt']);
  });

  it("parses git's refusal for tracked and untracked files, also both at once", () => {
    expect(
      parseBlockedByLocalChanges(
        'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tsrc/b.ts\nPlease commit your changes or stash them before you merge.\nAborting\n',
      ),
    ).toEqual(['a.txt', 'src/b.ts']);
    expect(
      parseBlockedByLocalChanges('error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt\nPlease move or remove them before you merge.\nAborting\n'),
    ).toEqual(['new.txt']);
    expect(
      parseBlockedByLocalChanges(
        'error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\nPlease commit your changes or stash them before you merge.\nerror: The following untracked working tree files would be overwritten by merge:\n\tn.txt\nPlease move or remove them before you merge.\nAborting\n',
      ),
    ).toEqual(['f.txt', 'n.txt']);
    // A staged file: two-space indent, and no advice line before git's own trailer.
    expect(parseBlockedByLocalChanges('error: Your local changes to the following files would be overwritten by merge:\n  c.txt\nMerge with strategy ort failed.\n')).toEqual(['c.txt']);
    expect(parseBlockedByLocalChanges('fatal: refusing to merge unrelated histories')).toBeUndefined();
  });
});
