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
  samePath,
  syncState,
  type LiveWorktree,
  type PrInfo,
  type WorktreeManager,
} from '@oide/git';
import { sensitivePathReason, type AgentSummary, type CommitInfo, type FileDiff, type OverlapWarning, type Project, type SyncState, type WorktreeInfo } from '@oide/protocol';
import type { SettingsService, Store } from '@oide/store';
import type { MainContext } from '../context.js';
import { IpcError } from '../ipc/router.js';
import type { ProjectsService } from './projects.js';

/** Minimal view of the agents the git service needs (avoids a cycle with AgentsService). */
export interface AgentLookup {
  list(): AgentSummary[];
  get(agentId: string): AgentSummary | undefined;
  setDiff(agentId: string, diff: AgentSummary['diff']): void;
}

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
  private readonly lastFetchAt = new Map<string, number>();
  private readonly prCache = new Map<string, { at: number; pr: PrInfo | undefined }>();
  private readonly watchers = new Map<string, { projectId: string; sub: Promise<Subscription | undefined> }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fetchTimer: ReturnType<typeof setInterval> | undefined;
  private fetchMinutes = -1;
  private closed = false;
  /** Background git work (diff refreshes, periodic fetch) that dispose() waits for. */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly o: {
      ctx: MainContext;
      store: Store;
      settings: SettingsService;
      worktrees: WorktreeManager;
      projects: ProjectsService;
      agents: AgentLookup;
      /** Remove an agent (and its worktree); used by cleanup after merge. */
      removeAgent(agentId: string): Promise<void>;
      watch?: WatchFn | undefined;
      background?: boolean | undefined;
      gh?: GhCli;
      debounceMs?: number;
      /** Test seam for the tile diff counts. */
      diffStat?: typeof diffStat;
      /** How long dispose() waits for in-flight git commands (default 5 s). */
      disposeWaitMs?: number;
    },
  ) {
    this.gh = o.gh ?? new GhCli();
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
        return pr ? { ...info, pr: { state: pr.state, ...(pr.number !== undefined ? { number: pr.number } : {}), ...(pr.url ? { url: pr.url } : {}) } } : info;
      }),
    );
    const orphans = await this.o.worktrees.orphans(p.path, p.id, agents.map((a) => a.worktreePath)).catch(() => []);
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
    const a = this.agent(agentId);
    if (!a.worktreePath || !a.baseRef) return [];
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
    if (r.error && !r.conflicts.length) throw new IpcError(r.error, 'git_failed');
    this.changed(p.id);
    if (r.ok && (await this.fullyMerged(p.path, a.worktreePath, a.branch))) {
      const cleanup = this.o.settings.get().agents.cleanup;
      if (cleanup === 'right-away') await this.o.removeAgent(agentId);
      else if (cleanup === 'after-7-days') this.o.store.ui.kv.set(MERGED_KEY(agentId), Date.now());
    }
    return { ok: r.ok, conflicts: r.conflicts };
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
      if (this.o.agents.get(agentId)) {
        await this.o.removeAgent(agentId).catch((err) => this.o.ctx.log.warn('cleanup failed', err));
        removed.push(agentId);
      }
    }
    return removed;
  }

  async openPr(agentId: string, title: string, body: string): Promise<{ url: string }> {
    const a = this.agent(agentId);
    if (!a.branch || !a.worktreePath) throw new IpcError('This agent has no branch to open a pull request for.', 'conflict');
    if (!(await this.gh.available())) throw new IpcError('The GitHub CLI (gh) is not installed or not signed in.', 'unavailable');
    await this.remote(() => gitPush(a.worktreePath!, { branch: a.branch!, setUpstream: true }));
    const base = a.baseRef && !/^[0-9a-f]{40}$/.test(a.baseRef) ? a.baseRef.replace(/^origin\//, '') : undefined;
    const r = await this.gh.prCreate(a.worktreePath, { title, body, head: a.branch, ...(base ? { base } : {}) }).catch((err: Error) => {
      throw new IpcError(err.message, 'git_failed');
    });
    if (!r) throw new IpcError('The GitHub CLI (gh) is not available.', 'unavailable');
    this.prCache.delete(a.branch);
    this.changed(a.projectId);
    return r;
  }

  async pruneOrphans(projectId: string): Promise<{ removed: string[] }> {
    const p = this.project(projectId);
    const known = this.o.agents
      .list()
      .filter((a) => a.projectId === projectId && a.worktreePath)
      .map((a) => a.worktreePath!);
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

  /** Watch a checkout; changes refresh the diff of the agents working there and emit `git.changed`. */
  watch(path: string, projectId: string): void {
    if (!this.o.watch || this.closed || this.watchers.has(path) || !existsSync(path)) return;
    const onChange = () => {
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
