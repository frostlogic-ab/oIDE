import type { PrInfo, PrLookup } from '@oide/git';
import type { AgentPrInfo, AgentSummary } from '@oide/protocol';

/**
 * Pull request state for agents' branches, from the user's own `gh` (docs/wiki/pages/screen-wall.md,
 * "Pull requests"). Rate-limit friendly by design:
 *
 * - Polls only agents whose PR is open or draft, plus a one-time lookup per agent per session to
 *   find a PR opened outside oIDE (finished agents only). Lookups run one at a time.
 * - Runs after the background fetch (Settings › Agents › Fetch interval) and on window focus
 *   (at most every FOCUS_MIN_MS); never while offline, never when gh is missing or signed out.
 * - A gh error stops the round and backs off exponentially (interval × 2^n, capped at MAX_BACKOFF_MS).
 *
 * A PR seen merged hands the agent to `onMerged` (archive with reason `merged`), once.
 */
export const FOCUS_MIN_MS = 2 * 60_000;
export const MAX_BACKOFF_MS = 2 * 60 * 60_000;
const MIN_INTERVAL_MS = 60_000;

/** Statuses at which an agent's branch may have a PR worth discovering (its work is done or paused). */
const DISCOVER: ReadonlySet<AgentSummary['status']> = new Set(['ready-for-review', 'has-question', 'stopped', 'done', 'error', 'paused']);

export type PollReason = 'timer' | 'focus' | 'manual';
export type PollSkip = 'busy' | 'offline' | 'backoff' | 'throttled' | 'gh-unavailable';

export interface PrWatcherDeps {
  gh: { available(): Promise<boolean>; prLookup(cwd: string, branch: string): Promise<PrLookup> };
  agents: { list(): AgentSummary[]; setPr(agentId: string, pr: AgentPrInfo | undefined): void };
  /** Only trusted projects run git or gh on their own (SEC-03). */
  trusted(projectId: string): boolean;
  /** False for a project without a git remote: gh can only fail there, so it is skipped quietly. */
  hasRemote?(projectId: string): Promise<boolean>;
  /** gh said "no git remotes found" for this project (the cache was stale). */
  noRemote?(projectId: string): void;
  /** Settings › Agents › Fetch interval, in minutes (0 = off: only window focus polls). */
  intervalMinutes(): number;
  isOnline?: () => boolean;
  onMerged(agent: AgentSummary, pr: AgentPrInfo): Promise<void>;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
  now?: () => number;
}

/** gh's PrInfo → the summary's PR, or undefined when it lacks a number or URL. */
export function toAgentPr(pr: PrInfo | undefined, now: number): AgentPrInfo | undefined {
  if (!pr?.url || !pr.number || !/^https:\/\//.test(pr.url)) return undefined;
  const state = pr.state === 'open' || pr.state === 'draft' || pr.state === 'merged' || pr.state === 'closed' ? pr.state : undefined;
  if (!state) return undefined;
  return { number: pr.number, url: pr.url, state, ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}), checkedAt: now };
}

export class PrWatcher {
  private running = false;
  private failures = 0;
  private nextAllowedAt = 0;
  private lastFocusAt = 0;
  private readonly discovered = new Set<string>();
  private readonly mergedHandled = new Set<string>();

  constructor(private readonly d: PrWatcherDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Consecutive gh failures (tests, diagnostics). */
  get failureCount(): number {
    return this.failures;
  }

  get backoffUntil(): number {
    return this.nextAllowedAt;
  }

  /** `interval × 2^(n-1)`, at least a minute, at most MAX_BACKOFF_MS. */
  backoffMs(failures: number): number {
    const base = Math.max(MIN_INTERVAL_MS, this.d.intervalMinutes() * 60_000);
    return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, failures - 1));
  }

  /** The agent's PR is known (opened from oIDE): no discovery lookup needed. */
  noteKnown(agentId: string): void {
    this.discovered.add(agentId);
  }

  private targets(): AgentSummary[] {
    return this.d.agents.list().filter((a) => {
      if (!a.branch || !a.worktreePath || !this.d.trusted(a.projectId)) return false;
      if (a.pr) return a.pr.state === 'open' || a.pr.state === 'draft';
      return !this.discovered.has(a.id) && DISCOVER.has(a.status);
    });
  }

  async poll(reason: PollReason): Promise<{ checked: number; skipped?: PollSkip }> {
    if (this.running) return { checked: 0, skipped: 'busy' };
    const now = this.now();
    if (this.d.isOnline && !this.d.isOnline()) return { checked: 0, skipped: 'offline' };
    if (now < this.nextAllowedAt) return { checked: 0, skipped: 'backoff' };
    if (reason === 'focus') {
      if (now - this.lastFocusAt < FOCUS_MIN_MS) return { checked: 0, skipped: 'throttled' };
      this.lastFocusAt = now;
    }
    let targets = this.targets();
    if (!targets.length) return { checked: 0 };
    this.running = true;
    let checked = 0;
    try {
      if (this.d.hasRemote) {
        const remote = new Map<string, boolean>();
        for (const id of new Set(targets.map((a) => a.projectId))) remote.set(id, await this.d.hasRemote(id).catch(() => true));
        targets = targets.filter((a) => remote.get(a.projectId));
        if (!targets.length) return { checked: 0 };
      }
      if (!(await this.d.gh.available())) return { checked: 0, skipped: 'gh-unavailable' };
      const noRemote = new Set<string>();
      for (const a of targets) {
        if (noRemote.has(a.projectId)) continue;
        const r = await this.d.gh.prLookup(a.worktreePath!, a.branch!);
        if (r.unavailable) return { checked, skipped: 'gh-unavailable' };
        if (r.error && /no git remotes? found/i.test(r.error)) {
          // Local-only repo: nothing to look up, not a gh failure (no backoff, no warning).
          noRemote.add(a.projectId);
          this.d.noRemote?.(a.projectId);
          this.d.log?.debug('no git remote; skipping PR lookups for this project');
          continue;
        }
        if (r.error) {
          this.failures++;
          this.nextAllowedAt = this.now() + this.backoffMs(this.failures);
          this.d.log?.warn('gh pr lookup failed; backing off', { failures: this.failures, retryInMs: this.backoffMs(this.failures), error: r.error });
          return { checked };
        }
        checked++;
        this.discovered.add(a.id);
        const pr = toAgentPr(r.pr, this.now());
        if (!pr) continue;
        this.d.agents.setPr(a.id, pr);
        if (pr.state === 'merged' && !this.mergedHandled.has(a.id)) {
          this.mergedHandled.add(a.id);
          await this.d.onMerged({ ...a, pr }, pr).catch((err) => this.d.log?.warn('archiving the agent of a merged PR failed', a.id, err));
        }
      }
      this.failures = 0;
      return { checked };
    } finally {
      this.running = false;
    }
  }
}
