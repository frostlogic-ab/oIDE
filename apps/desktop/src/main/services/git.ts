import { existsSync } from 'node:fs';
import {
  GhCli,
  Git,
  commit as gitCommit,
  detectOverlaps,
  diffStat,
  fileDiffs,
  gitFetch,
  gitPull,
  gitPush,
  log as gitLog,
  mergeLocal as gitMergeLocal,
  predictMerge as gitPredictMerge,
  isInside,
  samePath,
  syncState,
  type LiveWorktree,
  type MergeForecast,
  type PrInfo,
  type WorktreeManager,
} from '@oide/git';
import {
  sensitivePathReason,
  type AgentStatus,
  type AgentSummary,
  type CommitInfo,
  type FileDiff,
  type MergeConflictsMessage,
  type MergePrediction,
  type OverlapWarning,
  type Project,
  type SyncState,
  type UserMessage,
  type WorktreeInfo,
} from '@oide/protocol';
import type { SettingsService, Store } from '@oide/store';
import type { MainContext } from '../context.js';
import { IpcError } from '../ipc/router.js';
import type { ProjectsService } from './projects.js';
import { PrWatcher, toAgentPr } from './pr-watch.js';

/** Minimal view of the agents the git service needs (avoids a cycle with AgentsService). */
export interface AgentLookup {
  list(): AgentSummary[];
  get(agentId: string): AgentSummary | undefined;
  setDiff(agentId: string, diff: AgentSummary['diff']): void;
  /** The branch's pull request (tile "View PR", PR-merged archive). */
  setPr?(agentId: string, pr: AgentSummary['pr']): void;
  /** "Resolving merge conflicts" on the tile (set after the conflicts were sent). */
  setMergeConflict?(agentId: string, info: AgentSummary['mergeConflict']): void;
  /** An archived agent's summary (Archived view), or undefined. */
  archived?(agentId: string): AgentSummary | undefined;
  /** Back to the Wall (resumable when its session and worktree exist). */
  unarchive?(agentId: string): Promise<AgentSummary>;
  /** Deliver a message; a stopped agent is resumed with `--resume` (queued under Max running). */
  send?(agentId: string, msg: UserMessage): void | Promise<void>;
  /** Resume a paused agent so a held message is delivered. */
  resume?(agentId: string): Promise<void>;
}

const LIVE: ReadonlySet<AgentStatus> = new Set(['starting', 'running', 'needs-permission']);
const PROJECT_FOLDER = 'This agent works in the project folder; there is no branch to merge.';
const WORKTREE_DELETED = "Its worktree was deleted, so the agent can't resolve conflicts there. Resolve them by hand, or hand them to a new agent.";

interface Subscription {
  unsubscribe(): Promise<void>;
}
export type WatchFn = (dir: string, onChange: () => void) => Promise<Subscription>;

/** `@parcel/watcher`, ignoring `.git` and `node_modules`. Loaded lazily (native module). */
export const parcelWatch: WatchFn = async (dir, onChange) => {
  const watcher = await import('@parcel/watcher');
  return watcher.subscribe(
    dir,
    (err) => {
      if (!err) onChange();
    },
    // On Windows pick the native backend: the default probes watchman through cmd, which prints
    // "'watchman' is not recognized" on every start (m4).
    { ignore: ['.git', 'node_modules', '**/.git/**', '**/node_modules/**'], ...(process.platform === 'win32' ? { backend: 'windows' as const } : {}) },
  );
};

const MERGED_KEY = (agentId: string) => `merged:${agentId}`;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Source control: sync state, fetch/pull/push, commits, worktree cards (ahead/behind, diff stats,
 * PR state via the user's own `gh`), overlap warnings, diffs, local merge and cleanup. Watches each
 * checkout (`@parcel/watcher`) and refreshes tile diff counts with a debounce; fetches every
 * Settings > Agents > fetch interval minutes. Emits `git.changed { projectId }`.
 */
export class GitService {
  readonly gh: GhCli;
  /** Polls open/draft PRs; a merged one archives its agent (pr-watch.ts). */
  readonly prs: PrWatcher;
  private readonly lastFetchAt = new Map<string, number>();
  private readonly prCache = new Map<string, { at: number; pr: PrInfo | undefined }>();
  private readonly watchers = new Map<string, { projectId: string; sub: Promise<Subscription | undefined> }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fetchTimer: ReturnType<typeof setInterval> | undefined;
  private fetchMinutes = -1;
  private closed = false;
  /** Background git work (diff refreshes, periodic fetch) that dispose() waits for. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Merge predictions per agent, valid while the main checkout's HEAD and the branch stay on the same commits. */
  private readonly predictions = new Map<string, { key: string; forecast: MergeForecast }>();
  /** Files the last real merge of each agent stopped on (prediction missed it, or git is too old to predict). */
  private readonly mergeConflicts = new Map<string, string[]>();

  constructor(
    private readonly o: {
      ctx: MainContext;
      store: Store;
      settings: SettingsService;
      worktrees: WorktreeManager;
      projects: ProjectsService;
      agents: AgentLookup;
      /**
       * After a full merge: archive the agent (reason `merged`, with the merge commit); its worktree is
       * deleted now when Settings › Agents › Clean up is "Right away".
       */
      archiveMerged(agentId: string, opts: { mergeCommit?: string; deleteWorktree: boolean }): Promise<void>;
      /** Clean up "After 7 days": delete a merged agent's worktree (archived or not). True when removed. */
      removeWorktreeOf(agentId: string): Promise<boolean>;
      watch?: WatchFn | undefined;
      background?: boolean | undefined;
      gh?: GhCli;
      /** False while the machine is offline (Electron's net.isOnline): no PR polling then. */
      isOnline?: () => boolean;
      debounceMs?: number;
      /** Test seam for the tile diff counts. */
      diffStat?: typeof diffStat;
      /** How long dispose() waits for in-flight git commands (default 5 s). */
      disposeWaitMs?: number;
    },
  ) {
    this.gh = o.gh ?? new GhCli();
    this.prs = new PrWatcher({
      gh: this.gh,
      agents: { list: () => this.o.agents.list(), setPr: (id, pr) => this.o.agents.setPr?.(id, pr) },
      trusted: (projectId) => this.o.projects.get(projectId)?.trusted ?? false,
      intervalMinutes: () => this.o.settings.get().agents.fetchIntervalMinutes,
      ...(o.isOnline ? { isOnline: o.isOnline } : {}),
      onMerged: (a, pr) => this.archiveForMergedPr(a, pr),
      log: o.ctx.log,
    });
    if (o.background) {
      this.armFetchTimer();
      o.settings.onChange(() => this.armFetchTimer());
    }
  }

  // ---------------------------------------------------------------- helpers

  private project(projectId: string): Project {
    return this.o.projects.require(projectId);
  }

  private agent(agentId: string): AgentSummary {
    const a = this.o.agents.get(agentId);
    if (!a) throw new IpcError(`Unknown agent ${agentId}`, 'not_found');
    return a;
  }

  /** Agents of a project that run in their own worktree (not the project folder). */
  private worktreeAgents(project: Project): Array<AgentSummary & { worktreePath: string; branch: string; baseRef: string }> {
    return this.o.agents
      .list()
      .filter((a) => a.projectId === project.id && a.worktreePath && a.branch && a.baseRef && !samePath(a.worktreePath, project.path)) as Array<AgentSummary & { worktreePath: string; branch: string; baseRef: string }>;
  }

  changed(projectId: string): void {
    this.o.ctx.emit('git.changed', { projectId });
  }

  // ---------------------------------------------------------------- main checkout

  sync(projectId: string): Promise<SyncState> {
    const p = this.project(projectId);
    const at = this.lastFetchAt.get(projectId);
    return syncState(p.path, at !== undefined ? { lastFetchAt: at } : {});
  }

  async fetch(projectId: string): Promise<SyncState> {
    const p = this.project(projectId);
    await this.remote(() => gitFetch(p.path, { prune: true }));
    this.lastFetchAt.set(projectId, Date.now());
    this.prCache.clear();
    this.changed(projectId);
    return this.sync(projectId);
  }

  async pull(projectId: string): Promise<SyncState> {
    const p = this.project(projectId);
    await this.remote(() => gitPull(p.path));
    this.changed(projectId);
    return this.sync(projectId);
  }

  async push(projectId: string): Promise<SyncState> {
    const p = this.project(projectId);
    // "Not on a remote yet" offers Push; with no remote at all git only says "Could not read from remote repository".
    const remotes = (await new Git({ cwd: p.path }).out(['remote']).catch(() => '')).trim();
    if (!remotes) throw new IpcError(`${p.name} has no git remote to push to. Add one with "git remote add origin <url>", then push again.`, 'git_failed');
    await this.remote(() => gitPush(p.path));
    this.changed(projectId);
    return this.sync(projectId);
  }

  private async remote(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      throw new IpcError((err as Error).message, 'git_failed');
    }
  }

  async commit(projectId: string, message: string, files?: string[]): Promise<CommitInfo> {
    const p = this.project(projectId);
    try {
      const c = await gitCommit(p.path, { message, ...(files ? { files } : {}) });
      this.changed(projectId);
      return c;
    } catch (err) {
      throw new IpcError((err as Error).message, 'git_failed');
    }
  }

  log(projectId: string, ref: string, limit: number): Promise<CommitInfo[]> {
    return gitLog(this.project(projectId).path, ref, limit);
  }

  // ---------------------------------------------------------------- worktrees

  async worktrees(projectId: string): Promise<WorktreeInfo[]> {
    const p = this.project(projectId);
    const agents = this.worktreeAgents(p);
    const prOk = await this.gh.available().catch(() => false);
    const out = await Promise.all(
      agents.map(async (a) => {
        const info = await this.o.worktrees.info({ projectId, path: a.worktreePath, branch: a.branch, baseRef: a.baseRef, agentId: a.id });
        const pr = prOk && !info.orphaned ? await this.prFor(a.worktreePath, a.branch) : undefined;
        // The same lookup puts the PR on the agent (tile "View PR #12"), also for PRs opened outside oIDE.
        const agentPr = toAgentPr(pr, Date.now());
        if (agentPr && agentPr.state !== 'merged') this.o.agents.setPr?.(a.id, agentPr);
        return pr ? { ...info, pr: { state: pr.state, ...(pr.number !== undefined ? { number: pr.number } : {}), ...(pr.url ? { url: pr.url } : {}) } } : info;
      }),
    );
    // Archived agents' kept worktrees are not orphans: Unarchive can resume them.
    const known = [...agents.map((a) => a.worktreePath), ...this.o.store.agents.archivedWorktrees(projectId)];
    const orphans = await this.o.worktrees.orphans(p.path, p.id, known).catch(() => []);
    for (const o of orphans) out.push({ projectId, path: o.path, branch: o.branch ?? '', baseRef: '', ahead: 0, behind: 0, changedFiles: [], orphaned: true });
    return out;
  }

  /** PR state per branch, cached until the next fetch (or 5 minutes). */
  private async prFor(cwd: string, branch: string): Promise<PrInfo | undefined> {
    const hit = this.prCache.get(branch);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.pr;
    const pr = await this.gh.prView(cwd, branch).catch(() => undefined);
    this.prCache.set(branch, { at: Date.now(), pr });
    return pr;
  }

  /** A pull request needs a remote to push to and the GitHub CLI (m6: a repo without a remote can only fail). */
  async prAvailable(projectPath?: string): Promise<{ available: boolean; reason?: string }> {
    if (projectPath) {
      const remotes = (await new Git({ cwd: projectPath }).out(['remote']).catch(() => '')).trim();
      if (!remotes) return { available: false, reason: 'This project has no git remote to open a pull request against.' };
    }
    const ok = await this.gh.available().catch(() => false);
    return ok ? { available: true } : { available: false, reason: 'The GitHub CLI (gh) is not installed or not signed in.' };
  }

  overlaps(projectId: string): Promise<OverlapWarning[]> {
    const p = this.project(projectId);
    const live: LiveWorktree[] = this.worktreeAgents(p)
      .filter((a) => existsSync(a.worktreePath))
      .map((a) => ({ agentId: a.id, path: a.worktreePath, branch: a.branch, baseRef: a.baseRef }));
    return detectOverlaps(projectId, p.path, live);
  }

  /** The agent's changes; files that configure agents, git or MCP are marked `sensitive` (SEC-12). */
  async diff(agentId: string): Promise<FileDiff[]> {
    // An archived agent (Focus, read-only) shows its changes while its worktree still exists.
    const a = this.o.agents.get(agentId) ?? this.o.store.agents.get(agentId)?.summary;
    if (!a) throw new IpcError(`Unknown agent ${agentId}`, 'not_found');
    if (!a.worktreePath || !a.baseRef || (a.archived && !existsSync(a.worktreePath))) return [];
    const diffs = await fileDiffs(a.worktreePath, a.baseRef);
    return diffs.map((d) => {
      const why = sensitivePathReason(d.path) ?? (d.oldPath ? sensitivePathReason(d.oldPath) : undefined);
      return why ? { ...d, sensitive: why } : d;
    });
  }

  /** Merge the agent's branch into the main checkout (`--no-ff`); cleanup follows Settings. */
  async mergeLocal(agentId: string): Promise<{ ok: boolean; conflicts: string[] }> {
    const a = this.agent(agentId);
    const p = this.project(a.projectId);
    if (!a.branch || !a.worktreePath || samePath(a.worktreePath, p.path)) throw new IpcError('This agent works in the project folder; there is no branch to merge.', 'conflict');
    // Review shows committed AND uncommitted changes, so Merge merges both: pending worktree
    // changes are committed first, on the agent's behalf (Oide-Agent trailer).
    if (existsSync(a.worktreePath) && (await this.hasLocalChanges(a.worktreePath))) {
      const subject = (a.review?.summary ?? '').split(/\r?\n/)[0]!.trim().slice(0, 72) || `${a.title}: uncommitted work`;
      try {
        await gitCommit(a.worktreePath, { message: subject, agent: a.title });
      } catch (err) {
        throw new IpcError(`Could not commit the worktree's uncommitted changes before merging: ${(err as Error).message}`, 'git_failed');
      }
    }
    const r = await gitMergeLocal(p.path, a.branch, { message: `Merge ${a.branch} (${a.title})` });
    if (r.error && !r.conflicts.length) throw new IpcError(r.error, r.blockedBy ? 'conflict' : 'git_failed');
    // Remembered for "Ask <agent> to resolve" when the prediction could not see these conflicts.
    if (r.conflicts.length) this.mergeConflicts.set(agentId, r.conflicts);
    else this.mergeConflicts.delete(agentId);
    this.changed(p.id);
    if (r.ok && (await this.fullyMerged(p.path, a.worktreePath, a.branch))) {
      // Merged agents move to the Archived view (row, summary and transcript stay); worktree cleanup follows Settings.
      const cleanup = this.o.settings.get().agents.cleanup;
      if (cleanup === 'after-7-days') this.o.store.ui.kv.set(MERGED_KEY(agentId), Date.now());
      await this.o.archiveMerged(agentId, { ...(r.sha ? { mergeCommit: r.sha } : {}), deleteWorktree: cleanup === 'right-away' });
    }
    return { ok: r.ok, conflicts: r.conflicts };
  }

  // ---------------------------------------------------------------- merge conflicts

  /** A live agent, or an archived one (its record), with its project. */
  private mergeSubject(agentId: string): { a: AgentSummary; p: Project; archived: boolean } {
    const live = this.o.agents.get(agentId);
    const a = live ?? this.o.agents.archived?.(agentId);
    if (!a) throw new IpcError(`Unknown agent ${agentId}`, 'not_found');
    return { a, p: this.project(a.projectId), archived: !live };
  }

  /**
   * "Merge into main?" before merging: would the agent branch conflict with the main checkout's HEAD?
   * `git merge-tree --write-tree` (no checkout touched), cached until either commit moves.
   * Prediction sees commits only; Merge first commits the worktree's pending changes.
   */
  async predictMerge(agentId: string, opts: { refresh?: boolean; withMainStatus?: boolean } = {}): Promise<MergePrediction> {
    const { a, p, archived } = this.mergeSubject(agentId);
    const computedAt = Date.now();
    const none = (reason: string): MergePrediction => ({ agentId, status: 'unavailable', reason, files: [], binary: [], submodules: [], behind: 0, ahead: 0, canAsk: false, askBlocked: reason, computedAt });
    if (!a.branch || !a.worktreePath || samePath(a.worktreePath, p.path)) return none(PROJECT_FOLDER);
    const git = new Git({ cwd: p.path });
    const [head, branchSha] = await Promise.all([git.revParse('HEAD'), git.revParse(a.branch)]);
    if (!head) return none('The main checkout has no commits yet.');
    if (!branchSha) return none(`Its branch ${a.branch} no longer exists.`);
    const key = `${head}:${branchSha}`;
    let forecast = opts.refresh ? undefined : this.predictions.get(agentId);
    if (forecast?.key !== key) {
      try {
        forecast = { key, forecast: await gitPredictMerge(git, a.branch) };
      } catch (err) {
        return none((err as Error).message);
      }
      this.predictions.set(agentId, forecast);
      if (this.predictions.size > 500) this.predictions.delete(this.predictions.keys().next().value!);
    }
    const f = forecast.forecast;
    const gone = Boolean(a.archived?.worktreeRemoved) || !existsSync(a.worktreePath);
    const askBlocked = gone ? WORKTREE_DELETED : a.resumeBlocked && !(LIVE.has(a.status) && !archived) ? a.resumeBlocked : undefined;
    let mainDirty: string[] | undefined;
    if (opts.withMainStatus) {
      const out = await git.out(['status', '--porcelain', '-z', '--untracked-files=no'], { env: { GIT_OPTIONAL_LOCKS: '0' } }).catch(() => '');
      mainDirty = out
        .split('\0')
        .filter((e) => e.length > 3)
        .map((e) => e.slice(3))
        .slice(0, 200);
    }
    return {
      agentId,
      status: !f.supported ? 'unknown' : f.conflicts ? 'conflicts' : 'clean',
      ...(f.supported ? {} : { reason: `oIDE could not predict conflicts: ${f.error ?? 'git merge-tree failed'} (git 2.38 or newer is needed).` }),
      target: { ...(f.target.branch ? { branch: f.target.branch } : {}), sha: f.target.sha },
      branchSha: f.branchSha,
      files: f.files,
      binary: f.binary,
      submodules: f.submodules,
      behind: f.behind,
      ahead: f.ahead,
      ...(mainDirty ? { mainDirty } : {}),
      canAsk: !askBlocked,
      ...(askBlocked ? { askBlocked } : {}),
      computedAt,
    };
  }

  /**
   * "Ask <agent> to resolve": send the agent the merge conflicts as a message from oIDE (target
   * branch and commit, files, what to do and what never to do). An archived agent is unarchived
   * first; a stopped one is resumed with `--resume` (queued under Max running). Never merges: the
   * agent submits for review again and the user clicks Merge.
   */
  async askToResolve(agentId: string, source: 'prediction' | 'merge' = 'prediction'): Promise<{ status: AgentStatus; files: number; unarchived: boolean; resumed: boolean }> {
    const { a, archived } = this.mergeSubject(agentId);
    const pred = await this.predictMerge(agentId, { refresh: true });
    if (pred.status === 'unavailable') throw new IpcError(pred.reason ?? PROJECT_FOLDER, 'conflict');
    if (!pred.canAsk) throw new IpcError(pred.askBlocked ?? WORKTREE_DELETED, 'conflict');
    const recorded = this.mergeConflicts.get(agentId) ?? [];
    let files: string[] = [];
    if (pred.status === 'conflicts') files = pred.files;
    else if (recorded.length) files = recorded;
    else if (pred.status === 'clean') throw new IpcError('Merging this branch would not conflict any more, so there is nothing to resolve. Merge it again.', 'conflict');
    const send = this.o.agents.send;
    if (!send) throw new IpcError('Agents cannot be messaged right now.', 'unavailable');
    let unarchived = false;
    if (archived) {
      if (!this.o.agents.unarchive) throw new IpcError('Archived agents cannot be brought back right now.', 'unavailable');
      await this.o.agents.unarchive(agentId);
      unarchived = true;
    }
    const before = this.o.agents.get(agentId) ?? a;
    const target = pred.target!;
    const ref = target.branch ?? target.sha;
    const msg: MergeConflictsMessage = {
      kind: 'merge-conflicts',
      target: ref,
      targetSha: target.sha,
      mergeRef: ref,
      fetchFirst: false,
      files,
      binary: pred.binary.filter((f) => files.includes(f)),
      submodules: pred.submodules.filter((f) => files.includes(f)),
    };
    await send(agentId, msg);
    if (before.status === 'paused') await this.o.agents.resume?.(agentId);
    this.o.agents.setMergeConflict?.(agentId, { target: ref, targetSha: target.sha, files, sentAt: Date.now() });
    this.mergeConflicts.delete(agentId);
    const after = this.o.agents.get(agentId) ?? before;
    this.o.ctx.log.debug('merge conflicts sent to the agent', { agent: agentId, source, files: files.length });
    // Delivered to a live process: running now. Otherwise it waits in the queue for a --resume launch.
    return { status: after.status, files: files.length, unarchived, resumed: unarchived || after.status === 'queued' || after.status === 'starting' };
  }

  private async hasLocalChanges(worktree: string): Promise<boolean> {
    const out = await new Git({ cwd: worktree }).out(['status', '--porcelain', '-z', '--untracked-files=all'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
    return out.length > 0;
  }

  /** Cleanup may only delete a worktree whose branch is in main and which holds no other changes. */
  private async fullyMerged(main: string, worktree: string, branch: string): Promise<boolean> {
    try {
      const inMain = await new Git({ cwd: main }).test(['merge-base', '--is-ancestor', '--end-of-options', branch, 'HEAD']);
      return inMain && !(existsSync(worktree) && (await this.hasLocalChanges(worktree)));
    } catch {
      return false;
    }
  }

  /** Startup sweep: agents merged more than 7 days ago lose their worktree (cleanup "After 7 days"). */
  async sweepMerged(now = Date.now()): Promise<string[]> {
    if (this.o.settings.get().agents.cleanup !== 'after-7-days') return [];
    const removed: string[] = [];
    for (const key of this.o.store.ui.kv.keys().filter((k) => k.startsWith('merged:'))) {
      const at = this.o.store.ui.kv.get<number>(key);
      const agentId = key.slice('merged:'.length);
      if (typeof at === 'number' && now - at < 7 * DAY) continue;
      this.o.store.ui.kv.delete(key);
      const done = await this.o.removeWorktreeOf(agentId).catch((err) => {
        this.o.ctx.log.warn('cleanup failed', err);
        return false;
      });
      if (done) removed.push(agentId);
    }
    return removed;
  }

  /**
   * Push the branch and open a PR. Idempotent: when the branch already has an open or draft PR
   * (opened before, or outside oIDE), that one is returned (`existing: true`) instead of failing.
   */
  async openPr(agentId: string, title: string, body: string): Promise<{ url: string; number?: number; state?: 'open' | 'draft' | 'merged' | 'closed'; existing?: boolean }> {
    const a = this.agent(agentId);
    if (!a.branch || !a.worktreePath) throw new IpcError('This agent has no branch to open a pull request for.', 'conflict');
    if (!(await this.gh.available())) throw new IpcError('The GitHub CLI (gh) is not installed or not signed in.', 'unavailable');
    const cwd = a.worktreePath;
    const branch = a.branch;
    const existing = async () => {
      const r = await this.gh.prLookup(cwd, branch);
      const pr = toAgentPr(r.pr, Date.now());
      return pr && (pr.state === 'open' || pr.state === 'draft') ? pr : undefined;
    };
    const known = await existing();
    // New commits still go up, so the existing PR shows them.
    await this.remote(() => gitPush(cwd, { branch, setUpstream: true }));
    if (known) return this.notePr(a, known, true);
    const base = a.baseRef && !/^[0-9a-f]{40}$/.test(a.baseRef) ? a.baseRef.replace(/^origin\//, '') : undefined;
    let created: { url: string } | undefined;
    try {
      created = await this.gh.prCreate(cwd, { title, body, head: branch, ...(base ? { base } : {}) });
    } catch (err) {
      // A PR appeared in between (or gh's lookup missed it): "a pull request for branch … already exists".
      const again = /already exists/i.test((err as Error).message) ? await existing() : undefined;
      if (again) return this.notePr(a, again, true);
      throw new IpcError((err as Error).message, 'git_failed');
    }
    if (!created) throw new IpcError('The GitHub CLI (gh) is not available.', 'unavailable');
    const number = Number(/\/pull\/(\d+)/.exec(created.url)?.[1]);
    const pr = (await existing()) ?? (number > 0 ? { number, url: created.url, state: 'open' as const, checkedAt: Date.now() } : undefined);
    if (!pr) {
      this.prCache.delete(branch);
      this.changed(a.projectId);
      return created;
    }
    return this.notePr(a, pr, false);
  }

  private notePr(a: AgentSummary, pr: NonNullable<AgentSummary['pr']>, existing: boolean) {
    this.o.agents.setPr?.(a.id, pr);
    this.prs.noteKnown(a.id);
    if (a.branch) this.prCache.delete(a.branch);
    this.changed(a.projectId);
    return { url: pr.url, number: pr.number, state: pr.state, existing };
  }

  /**
   * The agent's PR was merged on the forge: archive it (reason `merged`, the PR's merge commit), as a
   * merge inside oIDE does. Worktree cleanup follows Settings, but never deletes uncommitted work.
   */
  private async archiveForMergedPr(a: AgentSummary, pr: NonNullable<AgentSummary['pr']>): Promise<void> {
    if (!this.o.agents.get(a.id)) return;
    const cleanup = this.o.settings.get().agents.cleanup;
    const dirty = a.worktreePath && existsSync(a.worktreePath) ? await this.hasLocalChanges(a.worktreePath).catch(() => true) : false;
    if (dirty) this.o.ctx.log.warn('merged PR: worktree has uncommitted changes, so it is kept', { agent: a.id });
    if (cleanup === 'after-7-days' && !dirty) this.o.store.ui.kv.set(MERGED_KEY(a.id), Date.now());
    await this.o.archiveMerged(a.id, { ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}), deleteWorktree: cleanup === 'right-away' && !dirty });
    this.o.ctx.emit('notify', { level: 'info', message: `PR #${pr.number} merged · ${a.title} archived`, agentId: a.id });
    this.changed(a.projectId);
  }

  async pruneOrphans(projectId: string): Promise<{ removed: string[] }> {
    const p = this.project(projectId);
    const known = [
      ...this.o.agents
        .list()
        .filter((a) => a.projectId === projectId && a.worktreePath)
        .map((a) => a.worktreePath!),
      ...this.o.store.agents.archivedWorktrees(projectId),
    ];
    const orphans = await this.o.worktrees.orphans(p.path, p.id, known);
    const removed: string[] = [];
    for (const o of orphans) {
      try {
        await this.o.worktrees.remove(p.path, o.path, { force: true, deleteBranch: true });
        removed.push(o.path);
      } catch (err) {
        this.o.ctx.log.warn('could not remove orphaned worktree', o.path, err);
      }
    }
    await this.o.worktrees.prune(p.path).catch(() => undefined);
    if (removed.length) this.changed(projectId);
    return { removed };
  }

  // ---------------------------------------------------------------- diff refresh and watchers

  /** Recompute an agent's diff counts after a debounce, then emit `git.changed`. */
  scheduleDiff(agentId: string, delayMs = this.o.debounceMs ?? 400): void {
    if (this.closed) return;
    const key = `agent:${agentId}`;
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.refreshDiff(agentId);
      }, delayMs),
    );
  }

  async refreshDiff(agentId: string): Promise<void> {
    if (this.closed) return;
    const a = this.o.agents.get(agentId);
    if (!a?.worktreePath || !a.baseRef || !existsSync(a.worktreePath)) return;
    const worktreePath = a.worktreePath;
    const baseRef = a.baseRef;
    await this.track(async () => {
      try {
        const stat = await (this.o.diffStat ?? diffStat)(worktreePath, baseRef);
        if (this.closed) return;
        this.o.agents.setDiff(agentId, stat);
        this.changed(a.projectId);
      } catch (err) {
        this.o.ctx.log.debug('diff refresh failed', agentId, err);
      }
    });
  }

  /** Run background git work so dispose() can wait for it (a running `git diff` keeps the worktree locked on Windows). */
  private track<T>(fn: () => Promise<T>): Promise<T> {
    const p = fn();
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  /** Background git commands still running (diagnostics, tests). */
  get pendingWork(): number {
    return this.inflight.size;
  }

  private readonly checkoutListeners = new Set<(path: string, projectId: string) => void>();

  /** Called (undebounced) on every watcher change of a checkout, e.g. so the quick-open index refreshes. */
  onCheckoutChange(fn: (path: string, projectId: string) => void): () => void {
    this.checkoutListeners.add(fn);
    return () => this.checkoutListeners.delete(fn);
  }

  /** True when a watcher covers `path` (a watched checkout or a folder inside one). */
  isWatching(path: string): boolean {
    for (const p of this.watchers.keys()) if (samePath(p, path) || isInside(p, path)) return true;
    return false;
  }

  /** Watch a checkout; changes refresh the diff of the agents working there and emit `git.changed`. */
  watch(path: string, projectId: string): void {
    if (!this.o.watch || this.closed || this.watchers.has(path) || !existsSync(path)) return;
    const onChange = () => {
      for (const fn of this.checkoutListeners) fn(path, projectId);
      for (const a of this.o.agents.list()) if (a.worktreePath && samePath(a.worktreePath, path)) this.scheduleDiff(a.id);
      const key = `project:${projectId}`;
      if (this.timers.has(key)) return;
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          this.changed(projectId);
        }, 1000),
      );
    };
    const sub = this.o.watch(path, onChange).catch((err: unknown) => {
      this.o.ctx.log.warn('file watcher failed', path, err);
      return undefined;
    });
    this.watchers.set(path, { projectId, sub });
  }

  async unwatch(path: string): Promise<void> {
    const w = this.watchers.get(path);
    if (!w) return;
    this.watchers.delete(path);
    await (await w.sub)?.unsubscribe().catch(() => undefined);
  }

  async unwatchProject(projectId: string): Promise<void> {
    for (const [path, w] of [...this.watchers]) if (w.projectId === projectId) await this.unwatch(path);
  }

  private armFetchTimer(): void {
    const minutes = this.o.settings.get().agents.fetchIntervalMinutes;
    if (minutes === this.fetchMinutes) return;
    this.fetchMinutes = minutes;
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    this.fetchTimer = undefined;
    if (minutes <= 0) return;
    this.fetchTimer = setInterval(() => void this.fetchAll(), minutes * 60_000);
    this.fetchTimer.unref?.();
  }

  /** Background fetch of every project (the only remote command that runs without a click). */
  async fetchAll(): Promise<void> {
    if (this.closed) return;
    await this.track(() => this.fetchAllNow());
    // Then the PR states (open/draft PRs only; backs off on gh errors).
    if (!this.closed) await this.track(() => this.prs.poll('timer'));
  }

  /** The window got focus: look at open PRs again (throttled in PrWatcher). */
  onWindowFocus(): void {
    if (this.closed || !this.o.background) return;
    void this.track(() => this.prs.poll('focus'));
  }

  private async fetchAllNow(): Promise<void> {
    for (const p of this.o.projects.list()) {
      if (this.closed) return;
      // SEC-03: nothing runs on its own in a project the user has not trusted.
      if (!p.trusted) continue;
      const hasRemote = (await new Git({ cwd: p.path }).out(['remote']).catch(() => '')).trim();
      if (!hasRemote) continue;
      await this.fetch(p.id).catch((err) => this.o.ctx.log.debug('background fetch failed', p.path, (err as Error).message));
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    // Close watchers and let in-flight git commands finish (capped) before the caller removes
    // worktrees or exits: on Windows a running `git diff` keeps files in the worktree open.
    await Promise.all([...this.watchers.keys()].map((p) => this.unwatch(p)));
    if (this.inflight.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<void>((r) => (timer = setTimeout(r, this.o.disposeWaitMs ?? 5000)));
      await Promise.race([Promise.allSettled([...this.inflight]), cap]);
      if (timer) clearTimeout(timer);
      if (this.inflight.size) this.o.ctx.log.warn('git work still running at shutdown', { pending: this.inflight.size });
    }
  }
}
