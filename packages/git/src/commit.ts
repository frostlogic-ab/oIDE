import type { CommitInfo } from '@oide/protocol';
import { toGit, type Repo } from './git.js';
import { AGENT_TRAILER, log } from './log.js';
import { status } from './status.js';

export interface CommitOptions {
  message: string;
  /** Only these paths (added, modified or deleted). Omit to commit every change in the checkout. */
  files?: string[];
  /** Adds `Oide-Agent: <name>` when the commit is made on an agent's behalf. */
  agent?: string;
  /** Extra trailers, `{ Key: value }`. */
  trailers?: Record<string, string>;
}

/** Commit selected files (or everything) and return the new commit. Hooks and signing follow the user's config. */
export async function commit(repo: Repo, opts: CommitOptions): Promise<CommitInfo> {
  const git = toGit(repo);
  if (!opts.message.trim()) throw new Error('Commit message is empty.');
  const trailerArgs: string[] = [];
  const trailers = { ...(opts.agent ? { [AGENT_TRAILER]: opts.agent } : {}), ...(opts.trailers ?? {}) };
  for (const [k, v] of Object.entries(trailers)) {
    if (!/^[A-Za-z0-9-]+$/.test(k) || /[\r\n]/.test(v)) throw new Error(`Invalid trailer: ${k}`);
    trailerArgs.push('--trailer', `${k}: ${v}`);
  }
  if (opts.files) {
    if (!opts.files.length) throw new Error('No files selected.');
    // -A stages deletions too; pathspecs are literal so names with * or : are safe.
    await git.run(['--literal-pathspecs', 'add', '-A', '--', ...opts.files]);
    await git.run(['--literal-pathspecs', 'commit', '--no-edit', '-m', opts.message, ...trailerArgs, '--only', '--', ...opts.files], { timeoutMs: 5 * 60_000 });
  } else {
    await git.run(['add', '-A']);
    await git.run(['commit', '--no-edit', '-m', opts.message, ...trailerArgs], { timeoutMs: 5 * 60_000 });
  }
  const [head] = await log(git, 'HEAD', 1);
  if (!head) throw new Error('Commit did not produce a HEAD commit.');
  return head;
}

/**
 * Throw away uncommitted changes: tracked files go back to HEAD (index and working tree), untracked
 * files are deleted. `files` limits it to those paths; only paths `git status` reports as changed are
 * touched, so a path that is not a change (or sits outside the checkout) is ignored. Returns the
 * paths that were reverted.
 */
export async function discard(repo: Repo, opts: { files?: string[] } = {}): Promise<string[]> {
  const git = toGit(repo);
  if (opts.files && !opts.files.length) throw new Error('No files selected.');
  const st = await status(git);
  const want = opts.files ? new Set(opts.files) : undefined;
  const picked = st.entries.filter((e) => e.kind !== 'ignored' && (!want || want.has(e.path)));
  if (!picked.length) throw new Error('There are no uncommitted changes to revert.');
  const untracked = picked.filter((e) => e.kind === 'untracked').map((e) => e.path);
  // A staged rename reverts both sides: the new path goes away, the old one comes back.
  const tracked = [...new Set(picked.filter((e) => e.kind !== 'untracked').flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path])))];
  if (tracked.length) {
    if (!st.oid) throw new Error('Nothing is committed yet, so there is no version to revert to.');
    // --source=HEAD also drops files that are staged but not in HEAD; pathspecs are literal.
    await git.run(['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
  }
  if (untracked.length) await git.run(['--literal-pathspecs', 'clean', '-f', '-q', '--', ...untracked]);
  return picked.map((e) => e.path);
}
