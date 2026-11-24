import { toGit, type Repo } from './git.js';

/**
 * The only commands oIDE runs against a remote. They use the user's own git credentials
 * (credential helper, SSH agent) and never prompt: `GIT_TERMINAL_PROMPT=0` and
 * `GCM_INTERACTIVE=never` are always set by the runner. Only `fetch` runs without a click.
 */

const NETWORK_TIMEOUT = 5 * 60_000;

export interface RemoteResult {
  ok: boolean;
  /** git's own message, for a toast. */
  output: string;
}

export async function fetch(repo: Repo, opts: { remote?: string; prune?: boolean; all?: boolean } = {}): Promise<RemoteResult> {
  const args = ['fetch', '--quiet'];
  if (opts.prune !== false) args.push('--prune');
  if (opts.all) args.push('--all');
  else if (opts.remote) args.push(opts.remote);
  const r = await toGit(repo).run(args, { timeoutMs: NETWORK_TIMEOUT });
  return { ok: true, output: (r.stderr + r.stdout).trim() };
}

/** `git pull --ff-only`: never creates a merge commit in the user's checkout. */
export async function pull(repo: Repo, opts: { remote?: string; branch?: string } = {}): Promise<RemoteResult> {
  const args = ['pull', '--ff-only', '--no-rebase'];
  if (opts.remote) args.push(opts.remote);
  if (opts.remote && opts.branch) args.push(opts.branch);
  const r = await toGit(repo).run(args, { timeoutMs: NETWORK_TIMEOUT });
  return { ok: true, output: (r.stderr + r.stdout).trim() };
}

/** `git push`. Without an upstream it pushes HEAD to `remote` (default `origin`) and sets upstream. */
export async function push(repo: Repo, opts: { remote?: string; branch?: string; setUpstream?: boolean } = {}): Promise<RemoteResult> {
  const git = toGit(repo);
  const hasUpstream = await git.test(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const args = ['push'];
  if (!hasUpstream || opts.setUpstream || opts.branch) {
    args.push('--set-upstream', opts.remote ?? 'origin', opts.branch ?? 'HEAD');
  } else if (opts.remote) args.push(opts.remote);
  const r = await git.run(args, { timeoutMs: NETWORK_TIMEOUT });
  return { ok: true, output: (r.stderr + r.stdout).trim() };
}
