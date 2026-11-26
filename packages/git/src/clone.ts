import { Git, GitError } from './git.js';

/**
 * `git clone` for New project › Clone. The URL is validated by the caller (`CloneUrl` in
 * @oide/protocol: no `ext::`, no options, no network shares); the runner adds
 * `protocol.ext.allow=never` and never prompts. Progress comes from `--progress` on stderr.
 */

export interface CloneProgressLine {
  phase: string;
  percent?: number;
}

/**
 * Splits git's progress stream (lines end in `\r` while a phase counts, `\n` when it is done) into
 * `{ phase, percent }`. Feed it every stderr chunk; it returns the latest line it understood.
 */
export function cloneProgressParser(): (chunk: string) => CloneProgressLine | undefined {
  let rest = '';
  return (chunk) => {
    rest += chunk;
    const parts = rest.split(/[\r\n]/);
    rest = parts.pop() ?? '';
    let last: CloneProgressLine | undefined;
    for (const raw of parts) {
      const line = raw.replace(/^remote:\s*/, '').trim();
      const m = /^([A-Za-z][A-Za-z ]{2,60}?):\s+(\d{1,3})%/.exec(line);
      if (m) last = { phase: m[1]!, percent: Math.min(100, Number(m[2])) };
      else if (/^Cloning into /.test(line)) last = { phase: 'Connecting' };
    }
    if (rest.length > 4096) rest = rest.slice(-1024);
    return last;
  };
}

export type CloneFailure = 'auth' | 'not_found' | 'network' | 'exists' | 'other';

/** What kind of failure git's stderr describes (for a helpful message and telemetry). */
export function cloneFailureOf(stderr: string): CloneFailure {
  const s = stderr;
  if (/already exists and is not an empty directory/i.test(s)) return 'exists';
  if (/repository ['"].*['"] (not found|does not exist)|Repository not found|does not appear to be a git repository|not found\.?\s*$|\b404\b/im.test(s)) return 'not_found';
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|\b403\b|access denied|invalid credentials/i.test(s)) return 'auth';
  if (/Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Network is unreachable|unable to access|early EOF|timed out|SSL/i.test(s)) return 'network';
  return 'other';
}

/** A sentence for the dialog, from the failure kind and git's own last line. */
export function cloneFailureMessage(kind: CloneFailure, stderr: string): string {
  const last = stderr.trim().split(/\r?\n/).filter((l) => l.trim() && !/^Cloning into/.test(l)).slice(-1)[0]?.replace(/^fatal:\s*/, '') ?? '';
  switch (kind) {
    case 'not_found':
      return 'Repository not found, or your account cannot see it. Check the URL; for a private repository, sign in with git (or `gh auth login`) first.';
    case 'auth':
      return 'Git could not sign in to that server. oIDE uses your own git credentials and never prompts: sign in once in a terminal (for GitHub, `gh auth login` then `gh auth setup-git`), or use an ssh URL with your SSH key.';
    case 'network':
      return `Could not reach the server. Check your connection and the URL.${last ? ` (${last})` : ''}`;
    case 'exists':
      return 'That folder already exists and is not empty. Choose another name or location.';
    default:
      return last ? `git clone failed: ${last}` : 'git clone failed.';
  }
}

export interface CloneOptions {
  url: string;
  /** Absolute target folder (must not exist or be empty). */
  target: string;
  /** Folder git runs in (the target's parent). */
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (p: CloneProgressLine) => void;
  gitBinary?: string;
}

export interface CloneResult {
  ok: boolean;
  aborted: boolean;
  failure?: CloneFailure;
  message?: string;
}

/** Runs `git clone --progress -- <url> <target>`. Never throws for git failures: see `failure`. */
export async function cloneRepo(o: CloneOptions): Promise<CloneResult> {
  // The new checkout is not trusted: its config does not exist yet, and hooks stay off (runner default).
  const git = new Git({ cwd: o.cwd, trust: 'untrusted', ...(o.gitBinary ? { gitBinary: o.gitBinary } : {}) });
  const parse = cloneProgressParser();
  try {
    const r = await git.stream(['clone', '--progress', '--no-recurse-submodules', '--', o.url, o.target], {
      onStdout: () => {},
      onStderr: (chunk) => {
        const p = parse(chunk);
        if (p) o.onProgress?.(p);
      },
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (r.aborted) return { ok: false, aborted: true };
    return { ok: true, aborted: false };
  } catch (err) {
    const stderr = err instanceof GitError ? err.stderr : String((err as Error)?.message ?? err);
    if (err instanceof GitError && err.exitCode === null && !err.stderr) return { ok: false, aborted: false, failure: 'other', message: err.message };
    const failure = cloneFailureOf(stderr);
    return { ok: false, aborted: false, failure, message: cloneFailureMessage(failure, stderr) };
  }
}
