import { execFile } from 'node:child_process';
import { resolveTool } from './bin.js';

/**
 * Optional GitHub CLI wrapper used for PR state and "Open pull request". It uses the user's own
 * `gh` login; oIDE never reads gh's token. Everything returns `undefined` (and the UI hides PR
 * state) when `gh` is missing, signed out, or the repo has no GitHub remote.
 */

export interface PrInfo {
  /** `open`, `draft`, `closed` or `merged`. */
  state: string;
  number?: number;
  url?: string;
  /** Merge commit sha (merged PRs). */
  mergeCommit?: string;
  /** CI checks on the head commit, counted; absent when there are none. */
  checks?: PrChecks;
}

/** GitHub's status check rollup (check runs + commit statuses), counted. */
export interface PrChecks {
  /** `pending` while any check runs; else `failure` when one failed; else `success`. */
  state: 'pending' | 'success' | 'failure';
  total: number;
  /** Checks that finished (passed or failed). */
  completed: number;
  /** Finished checks that failed. */
  failed: number;
}

/** A lookup that tells "no PR for this branch" (`pr` undefined, no error) from a gh failure (`error`). */
export interface PrLookup {
  pr?: PrInfo;
  error?: string;
  /** gh is missing or signed out. */
  unavailable?: boolean;
}

const PR_FIELDS = 'state,number,url,isDraft,mergeCommit';
/** gh's message for a `--json` field it does not know. */
const UNKNOWN_FIELD = /unknown json field/i;

/** gh's message when a branch has no pull request. */
const NO_PR = /no (open )?pull requests? found|could not find any pull requests/i;

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

export class GhCli {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private availableCache: Promise<boolean> | undefined;
  /** gh rejected `statusCheckRollup` (older gh): PR lookups go without CI checks. */
  private noRollup = false;

  constructor(opts: { ghBinary?: string; timeoutMs?: number } = {}) {
    this.bin = opts.ghBinary ?? resolveTool('gh');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private run(args: string[], cwd?: string): Promise<Run> {
    return new Promise((resolve) => {
      execFile(
        this.bin,
        args,
        {
          cwd,
          timeout: this.timeoutMs,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
        },
      );
    });
  }

  /** True when `gh` is installed and signed in. Cached; call `refresh()` after the user signs in. */
  available(): Promise<boolean> {
    this.availableCache ??= (async () => {
      const v = await this.run(['--version']);
      if (v.code !== 0) return false;
      const auth = await this.run(['auth', 'status']);
      return auth.code === 0;
    })();
    return this.availableCache;
  }

  refresh(): void {
    this.availableCache = undefined;
  }

  /**
   * The signed-in user's repositories (most recently pushed first), with the clone URL their gh
   * `git_protocol` asks for (https by default, ssh when set). Undefined when gh is unavailable.
   */
  async listRepos(limit = 200): Promise<GhRepo[] | undefined> {
    if (!(await this.available())) return undefined;
    const r = await this.run(['repo', 'list', '--limit', String(Math.max(1, Math.min(1000, limit))), '--json', 'nameWithOwner,description,isPrivate,url,sshUrl,pushedAt']);
    if (r.code !== 0) throw new Error(`gh repo list failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const proto = await this.run(['config', 'get', 'git_protocol']);
    return parseRepoList(r.stdout, proto.code === 0 && proto.stdout.trim() === 'ssh' ? 'ssh' : 'https');
  }

  /** PR for a branch, or undefined when there is none or gh is unavailable. */
  async prView(cwd: string, branch: string): Promise<PrInfo | undefined> {
    return (await this.prLookup(cwd, branch)).pr;
  }

  /** PR for a branch, telling "none" apart from a failure (for backoff). */
  async prLookup(cwd: string, branch: string): Promise<PrLookup> {
    if (!(await this.available())) return { unavailable: true };
    let r = await this.run(['pr', 'view', branch, '--json', this.noRollup ? PR_FIELDS : `${PR_FIELDS},statusCheckRollup`], cwd);
    if (r.code !== 0 && !this.noRollup && UNKNOWN_FIELD.test(r.stderr || r.stdout)) {
      // A gh too old for statusCheckRollup: ask without it from now on (no CI indicator).
      this.noRollup = true;
      r = await this.run(['pr', 'view', branch, '--json', PR_FIELDS], cwd);
    }
    if (r.code === 0) {
      const pr = parsePrView(r.stdout);
      return pr ? { pr } : { error: 'gh pr view returned no state' };
    }
    const msg = (r.stderr || r.stdout).trim();
    if (NO_PR.test(msg)) return {};
    return { error: msg.slice(0, 300) || `gh exited with ${r.code}` };
  }

  /** Create a PR. Returns its URL, or undefined when gh is unavailable. Throws with gh's message on failure. */
  async prCreate(cwd: string, opts: { title: string; body: string; base?: string; head?: string; draft?: boolean }): Promise<{ url: string } | undefined> {
    if (!(await this.available())) return undefined;
    const args = ['pr', 'create', '--title', opts.title, '--body', opts.body];
    if (opts.base) args.push('--base', opts.base);
    if (opts.head) args.push('--head', opts.head);
    if (opts.draft) args.push('--draft');
    const r = await this.run(args, cwd);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`);
    const url = r.stdout.trim().split(/\r?\n/).reverse().find((l) => /^https?:\/\//.test(l.trim()));
    return { url: (url ?? r.stdout).trim() };
  }
}

export function parsePrView(json: string): PrInfo | undefined {
  try {
    const v = JSON.parse(json) as { state?: string; number?: number; url?: string; isDraft?: boolean; mergeCommit?: { oid?: string } | null; statusCheckRollup?: unknown };
    if (!v.state) return undefined;
    const state = v.isDraft && v.state === 'OPEN' ? 'draft' : v.state.toLowerCase();
    const checks = summarizeChecks(v.statusCheckRollup);
    return { state, number: v.number, url: v.url, ...(v.mergeCommit?.oid ? { mergeCommit: v.mergeCommit.oid } : {}), ...(checks ? { checks } : {}) };
  } catch {
    return undefined;
  }
}

/** Check run conclusions and commit status states that count as a failed check. */
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/**
 * `statusCheckRollup` from `gh pr view --json` → counts, or undefined when there are no checks.
 * Items are CheckRuns (`status`, `conclusion`) or StatusContexts (`state`). A check run counts as
 * finished once its status is COMPLETED; a status context once its state is not PENDING/EXPECTED.
 */
export function summarizeChecks(rollup: unknown): PrChecks | undefined {
  if (!Array.isArray(rollup)) return undefined;
  let total = 0;
  let completed = 0;
  let failed = 0;
  for (const raw of rollup) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as { __typename?: unknown; status?: unknown; conclusion?: unknown; state?: unknown };
    const up = (x: unknown) => (typeof x === 'string' ? x.toUpperCase() : '');
    if (c.__typename === 'StatusContext' || (c.status === undefined && typeof c.state === 'string')) {
      const st = up(c.state);
      total++;
      if (st === 'PENDING' || st === 'EXPECTED' || !st) continue;
      completed++;
      if (FAILED.has(st)) failed++;
    } else {
      total++;
      if (up(c.status) !== 'COMPLETED') continue;
      completed++;
      if (FAILED.has(up(c.conclusion))) failed++;
    }
  }
  if (!total) return undefined;
  const state = completed < total ? 'pending' : failed ? 'failure' : 'success';
  return { state, total, completed, failed };
}

export interface GhRepo {
  nameWithOwner: string;
  description?: string;
  isPrivate: boolean;
  cloneUrl: string;
  updatedAt?: string;
}

/** `gh repo list --json nameWithOwner,description,isPrivate,url,sshUrl,pushedAt` → repos, newest push first. */
export function parseRepoList(json: string, protocol: 'https' | 'ssh' = 'https'): GhRepo[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: GhRepo[] = [];
  for (const v of rows as Array<Record<string, unknown>>) {
    if (!v || typeof v.nameWithOwner !== 'string' || typeof v.url !== 'string') continue;
    const https = `${v.url.replace(/\/+$/, '')}.git`;
    const cloneUrl = protocol === 'ssh' && typeof v.sshUrl === 'string' && v.sshUrl ? v.sshUrl : https;
    out.push({
      nameWithOwner: v.nameWithOwner,
      ...(typeof v.description === 'string' && v.description ? { description: v.description } : {}),
      isPrivate: v.isPrivate === true,
      cloneUrl,
      ...(typeof v.pushedAt === 'string' ? { updatedAt: v.pushedAt } : {}),
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
