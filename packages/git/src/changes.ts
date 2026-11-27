import type { FileChange, FileChangeStatus } from '@oide/protocol';
import { toGit, type Git, type Repo } from './git.js';
import { mergeBase } from './diff.js';

/**
 * What a checkout changed, for the Files tree's git colours (VS Code explorer style), and the
 * matching "Discard changes".
 *
 * - No `base` (the project's main checkout): changes against HEAD, i.e. uncommitted work.
 * - `base` (an agent worktree): changes against the merge-base with the base branch, committed or
 *   not, i.e. everything the branch changed.
 *
 * Untracked (not ignored) files are listed one by one as `untracked`.
 */

/** More than this many changes: the rest are left out (`truncated`). */
export const MAX_CHANGES = 5000;

const NO_LOCKS = { env: { GIT_OPTIONAL_LOCKS: '0' } };
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];

/** The commit changes are measured against, or undefined when nothing is committed yet. */
async function sourceOf(git: Git, base?: string): Promise<string | undefined> {
  if (base) {
    try {
      return await mergeBase(git, base);
    } catch {
      // Base branch gone: fall back to HEAD (uncommitted changes).
    }
  }
  return git.revParse('HEAD');
}

/** Parse `git diff --name-status -z` (renames as `R100\0old\0new\0`). */
export function parseNameStatusZ(text: string): FileChange[] {
  const parts = text.split('\0');
  const out: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i] ?? '';
      const path = parts[++i] ?? '';
      if (path) out.push(letter === 'R' ? { path, status: 'renamed', oldPath } : { path, status: 'added' });
      continue;
    }
    const path = parts[++i];
    if (!path) continue;
    const status: FileChangeStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'U' ? 'conflicted' : 'modified';
    out.push({ path, status });
  }
  return out;
}

async function untracked(git: Git): Promise<string[]> {
  const out = await git.out(['ls-files', '--others', '--exclude-standard', '-z'], NO_LOCKS);
  return out.split('\0').filter(Boolean);
}

export interface CheckoutChanges {
  changes: FileChange[];
  truncated: boolean;
}

/** Changed files of a checkout, sorted by path. */
export async function checkoutChanges(repo: Repo, base?: string): Promise<CheckoutChanges> {
  const git = toGit(repo);
  const from = await sourceOf(git, base);
  let tracked: FileChange[];
  if (from) {
    tracked = parseNameStatusZ(await git.out(['diff', '--name-status', '-z', ...DIFF_FLAGS, from, '--'], NO_LOCKS));
  } else {
    // Nothing committed yet: everything in the index is new.
    const staged = (await git.out(['ls-files', '--cached', '-z'], NO_LOCKS)).split('\0').filter(Boolean);
    tracked = staged.map((path) => ({ path, status: 'added' as const }));
  }
  const seen = new Set(tracked.map((c) => c.path));
  const all = [...tracked];
  for (const path of await untracked(git)) if (!seen.has(path)) all.push({ path, status: 'untracked' });
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { changes: all.slice(0, MAX_CHANGES), truncated: all.length > MAX_CHANGES };
}

/**
 * Put `paths` back to the version `checkoutChanges` compares against: modified and deleted files are
 * restored, new files (untracked or added) are deleted, a rename goes back to its old name. Only paths
 * reported as changed are touched, so anything else (or outside the checkout) is ignored. Returns the
 * paths that were reverted.
 */
export async function discardCheckoutChanges(repo: Repo, paths: string[], base?: string): Promise<string[]> {
  const git = toGit(repo);
  if (!paths.length) throw new Error('No files selected.');
  const want = new Set(paths);
  const { changes } = await checkoutChanges(git, base);
  const picked = changes.filter((c) => want.has(c.path));
  if (!picked.length) throw new Error('There are no changes to discard here.');
  const from = await sourceOf(git, base);
  const fresh = picked.filter((c) => c.status === 'untracked').map((c) => c.path);
  const tracked = [...new Set(picked.filter((c) => c.status !== 'untracked').flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])))];
  for (const chunk of chunks(tracked)) {
    if (from) {
      // A path missing from the source is removed (index and disk); pathspecs are literal.
      await git.run(['--literal-pathspecs', 'restore', `--source=${from}`, '--staged', '--worktree', '--', ...chunk]);
    } else {
      await git.run(['--literal-pathspecs', 'rm', '-f', '-q', '--', ...chunk]);
    }
  }
  for (const chunk of chunks(fresh)) await git.run(['--literal-pathspecs', 'clean', '-f', '-q', '--', ...chunk]);
  return picked.map((c) => c.path);
}

/** Larger originals are not diffed (the Files editor reads at most this much too). */
export const MAX_ORIGINAL_BYTES = 5 * 1024 * 1024;

export type OriginalContent =
  /** The file as it was in the version `checkoutChanges` compares against. */
  | { kind: 'text'; content: string }
  /** Binary, or too large to diff. */
  | { kind: 'binary' }
  /** Not in that version (a new file), or nothing is committed yet. */
  | { kind: 'missing' };

/**
 * The version of `path` that `checkoutChanges` compares against (HEAD, or the merge-base with
 * `base`): the left side of the Files editor's diff. Read from the object store as stored (no
 * smudge filters or textconv run); line endings may differ from the working copy.
 */
export async function originalContent(repo: Repo, path: string, base?: string): Promise<OriginalContent> {
  const git = toGit(repo);
  const from = await sourceOf(git, base).catch(() => undefined);
  if (!from) return { kind: 'missing' };
  const spec = `${from}:${path}`;
  const size = await git.run(['cat-file', '-s', spec], { ...NO_LOCKS, okExitCodes: [0, 128] });
  if (size.exitCode !== 0) return { kind: 'missing' };
  if (Number(size.stdout.trim()) > MAX_ORIGINAL_BYTES) return { kind: 'binary' };
  const blob = await git.run(['cat-file', 'blob', spec], { ...NO_LOCKS, okExitCodes: [0, 128] });
  if (blob.exitCode !== 0) return { kind: 'missing' };
  if (blob.stdout.slice(0, 8000).includes('\0')) return { kind: 'binary' };
  return { kind: 'text', content: blob.stdout };
}

/** Keep command lines short (Windows caps them at 32k characters). */
function chunks(list: string[], size = 200): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
