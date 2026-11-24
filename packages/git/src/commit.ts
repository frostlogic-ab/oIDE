import type { CommitInfo } from '@oide/protocol';
import { toGit, type Repo } from './git.js';
import { AGENT_TRAILER, log } from './log.js';

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
