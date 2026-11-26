import { randomUUID } from 'node:crypto';
import {
  AgentEvent,
  AgentSpec,
  cleanAgentTitle,
  type AgentEventDraft,
  type AgentSpecInput,
  type AgentInterruption,
  type AgentStatus,
  type AgentSummary,
  type ArchiveReason,
  type MessageAttachment,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type UserMessage,
} from '@oide/protocol';
import { askRuleCovers, buildLaunch, cliPermissionMode, editStaysInside, requestTargetsProtectedPath, subagentTiers, LaunchError } from './args.js';
import { ClaudeCliDriver, rawJsonOf, type AgentDriver, type AgentHandle } from './driver.js';
import { ContextWindowBook } from './context-window.js';
import { AgentReducer, createSummary } from './reducer.js';
import { mergeConflictsText, messageText } from './messages.js';
import type { AttachmentProvider, EventSink, PermissionBroker, SecretProvider, SettingsProvider, TitleResult, WorktreeProvider, WorktreeResult } from './ports.js';

/**
 * The Supervisor turns Spawn requests into long-lived `claude` processes, queues them under
 * Settings › Agents › Max running, reduces their events into summaries and maps tile controls to the CLI.
 */

export interface SupervisorDeps {
  worktrees: WorktreeProvider;
  sink: EventSink;
  settings: SettingsProvider;
  secrets?: SecretProvider;
  broker: PermissionBroker;
  /** Copies file attachments into the agent's folder (main). */
  attachments?: AttachmentProvider;
  driver?: AgentDriver;
  log?: (message: string, detail?: unknown) => void;
  /** Override for tests. */
  newId?: () => string;
  baseEnv?: Record<string, string | undefined>;
}

export interface SupervisorEvents {
  event: (e: AgentEvent) => void;
  summary: (s: AgentSummary) => void;
  removed: (agentId: string) => void;
  /** The agent left the supervisor for the Archived view; `s.archived` is set. */
  archived: (s: AgentSummary) => void;
}

export interface ArchiveOptions {
  reason: ArchiveReason;
  mergeCommit?: string;
  /** Delete the worktree too (Settings › Agents › Clean up, or Remove worktree). */
  deleteWorktree?: boolean;
}

/** Shown on a tile instead of Resume when the worktree the session ran in is gone. */
export const WORKTREE_GONE = 'Its worktree was deleted, so this session cannot be resumed. Open it to read the transcript.';

/** Statuses that hold a "running" slot. Idle agents (has-question, ready-for-review) do not. */
const ACTIVE: ReadonlySet<AgentStatus> = new Set(['starting', 'running', 'needs-permission']);
const IDLE_AFTER_RESUME: AgentStatus = 'has-question';

interface QueueEntry {
  id: string;
  resume: boolean;
}

interface AgentRecord {
  id: string;
  spec: AgentSpec;
  reducer: AgentReducer;
  seq: number;
  handle?: AgentHandle;
  launching: boolean;
  /** True once a CLI session exists for this agent (later launches use --resume). */
  started: boolean;
  sessionId: string;
  worktree?: WorktreeResult;
  mcpConfigPath?: string;
  /** Messages held while paused or while the process is (re)starting. */
  held: UserMessage[];
  pendingPermissions: Map<string, PermissionRequest>;
  /** Rules this agent's launch marked "always ask" (never answered by an "Always"). */
  askRules: string[];
  /** Status to show after a resume spawn that has nothing to send. */
  idleStatus: AgentStatus;
  /** Spawn's attachments for the first message. Kept in memory only (never in the stored spec), dropped once sent. */
  firstAttachments?: MessageAttachment[];
  /** Mode changes run one at a time, so a slow fallback cannot overtake a later pick. */
  modeChain?: Promise<void>;
}

export interface RestoreEntry {
  spec: AgentSpec;
  summary: AgentSummary;
  /** Highest stored seq, so new events continue the sequence. */
  lastSeq?: number;
  /** Set when the agent was working at quit or crash: why its process is gone (default `restart` for a live status). */
  interruption?: AgentInterruption['reason'];
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

/**
 * The spec to relaunch a saved agent with. The summary is the truth for what changed while it ran:
 * its mode (the CLI changes it on its own) and its title (the agent named itself: set_title).
 */
function specFromSaved(spec: AgentSpec, s: AgentSummary): AgentSpec {
  const parsed = AgentSpec.parse({ ...spec, mode: s.mode });
  if (s.title && s.title !== parsed.title && AgentSpec.shape.title.safeParse(s.title).success) {
    const { autoTitle: _, ...rest } = parsed;
    return { ...rest, title: s.title };
  }
  return parsed;
}

export class Supervisor {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly queue: QueueEntry[] = [];
  private readonly listeners: { [K in keyof SupervisorEvents]: Set<SupervisorEvents[K]> } = { event: new Set(), summary: new Set(), removed: new Set(), archived: new Set() };
  private readonly driver: AgentDriver;
  /** Context windows the CLI reported, shared so one agent's result fixes the next agent's first turn. */
  private readonly contextWindows = new ContextWindowBook();
  /**
   * Rules the user approved with "Always in <project>", per project. The CLI reads `--allowedTools`
   * only at launch, so a rule saved to .oide/permissions.json reaches running agents through this:
   * their next matching request is allowed without a prompt.
   */
  private readonly alwaysAllowed = new Map<string, Set<string>>();
  private pumping = false;
  private pumpAgain = false;
  private closed = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.driver = deps.driver ?? new ClaudeCliDriver(deps.log ? { log: deps.log } : {});
  }

  // ------------------------------------------------------------------ emitter

  on<K extends keyof SupervisorEvents>(name: K, fn: SupervisorEvents[K]): () => void {
    this.listeners[name].add(fn);
    return () => this.off(name, fn);
  }
  off<K extends keyof SupervisorEvents>(name: K, fn: SupervisorEvents[K]): void {
    this.listeners[name].delete(fn);
  }
  private fire<K extends keyof SupervisorEvents>(name: K, ...args: Parameters<SupervisorEvents[K]>): void {
    for (const fn of this.listeners[name]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        this.deps.log?.(`supervisor ${name} listener threw`, err);
      }
    }
  }

  // ------------------------------------------------------------------ queries

  list(): AgentSummary[] {
    return [...this.agents.values()].map((r) => r.reducer.summary);
  }
  get(agentId: string): AgentSummary | undefined {
    return this.agents.get(agentId)?.reducer.summary;
  }
  spec(agentId: string): AgentSpec | undefined {
    return this.agents.get(agentId)?.spec;
  }
  subagentTranscript(agentId: string, subagentId: string): AgentEvent[] {
    return this.agents.get(agentId)?.reducer.tracker.transcript(subagentId) ?? [];
  }
  /** Fraction of this agent's tokens used by its subagents. */
  subagentTokenShare(agentId: string): number {
    const r = this.agents.get(agentId);
    return r ? r.reducer.tracker.tokenShare(r.reducer.leadTokens) : 0;
  }
  pendingPermissions(agentId: string): PermissionRequest[] {
    return [...(this.agents.get(agentId)?.pendingPermissions.values() ?? [])];
  }
  runningCount(): number {
    let n = 0;
    for (const r of this.agents.values()) if (r.launching || (r.handle?.alive && ACTIVE.has(r.reducer.summary.status))) n++;
    return n;
  }

  // ------------------------------------------------------------------ spawn and queue

  /** Spawn N attempts (spec.attempts) sharing one attemptGroup. Each starts queued. */
  async spawn(input: AgentSpecInput): Promise<AgentSummary[]> {
    const { attachments: firstAttachments, ...spec } = AgentSpec.parse(input);
    const n = spec.attempts;
    const attemptGroup = spec.attemptGroup ?? (n > 1 ? this.newId() : undefined);
    const out: AgentSummary[] = [];
    const settings = await this.deps.settings.get();
    if (spec.mode === 'bypassPermissions') {
      if (!settings.claude.allowBypass) throw new LaunchError('Bypass mode is off in Settings');
      if (spec.workIn === 'project-folder') throw new LaunchError('Bypass agents must run in a worktree');
    }
    for (let i = 0; i < n; i++) {
      const id = this.newId();
      const s: AgentSpec = { ...spec, ...(attemptGroup ? { attemptGroup } : {}), attempts: 1, title: n > 1 ? `${spec.title} #${i + 1}` : spec.title };
      const model = spec.customModel ? ((await this.deps.settings.customModel?.(spec.customModel.id))?.model ?? spec.strategy.lead.model) : spec.strategy.lead.model;
      const summary = createSummary({
        id,
        projectId: s.projectId,
        title: s.title,
        mode: s.mode,
        model,
        status: 'queued',
        sessionId: randomUUID(),
        workIn: s.workIn,
        ...(attemptGroup ? { attemptGroup } : {}),
      });
      const rec = this.newRecord(s, summary, 0, false);
      if (firstAttachments?.length) rec.firstAttachments = firstAttachments;
      this.agents.set(id, rec);
      this.emitDraft(rec, { type: 'status', status: 'queued' });
      // The summary is born queued, so the status event above changes nothing and would not publish:
      // publish it here so every spawn (IPC, extensions) shows up on the Wall while it waits.
      this.publishSummary(rec);
      this.queue.push({ id, resume: false });
      out.push(rec.reducer.summary);
    }
    void this.pump();
    return out;
  }

  private newId(): string {
    return this.deps.newId ? this.deps.newId() : `agt-${randomUUID()}`;
  }

  private newRecord(spec: AgentSpec, summary: AgentSummary, seq: number, started: boolean): AgentRecord {
    return {
      id: summary.id,
      spec,
      reducer: new AgentReducer(summary, { tiers: subagentTiers(spec.strategy), windows: this.contextWindows }),
      seq,
      launching: false,
      started,
      sessionId: summary.sessionId ?? randomUUID(),
      ...(summary.worktreePath ? { worktree: { path: summary.worktreePath, ...(summary.branch ? { branch: summary.branch } : {}), ...(summary.baseRef ? { baseRef: summary.baseRef } : {}) } } : {}),
      held: [],
      pendingPermissions: new Map(),
      askRules: [],
      idleStatus: IDLE_AFTER_RESUME,
    };
  }

  /** Start queued agents while slots are free. */
  private async pump(): Promise<void> {
    if (this.closed) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const max = (await this.deps.settings.get()).agents.maxRunning;
        while (this.queue.length && this.runningCount() < max) {
          const entry = this.queue.shift()!;
          const rec = this.agents.get(entry.id);
          if (!rec || rec.reducer.summary.status !== 'queued') continue;
          rec.launching = true;
          void this.launch(rec, entry.resume);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async launch(rec: AgentRecord, resume: boolean): Promise<void> {
    rec.launching = true;
    try {
      this.emitDraft(rec, { type: 'status', status: 'starting', ...(resume ? { detail: 'resume' } : {}) });
      const settings = await this.deps.settings.get();
      const cli = await this.deps.settings.cli();
      if (!rec.worktree) {
        const slug = slugify(rec.spec.title);
        rec.worktree = await this.deps.worktrees.create({ agentId: rec.id, slug, spec: rec.spec });
        const s = rec.reducer.summary;
        s.worktreePath = rec.worktree.path;
        if (rec.worktree.branch) s.branch = rec.worktree.branch;
        if (rec.worktree.baseRef) s.baseRef = rec.worktree.baseRef;
        this.publishSummary(rec);
        if (this.deps.worktrees.runSetup) {
          // The provider calls onStart only when there is a setup command to run (and the project is trusted).
          const setup = await this.deps.worktrees.runSetup({
            agentId: rec.id,
            path: rec.worktree.path,
            spec: rec.spec,
            onStart: () => this.emitDraft(rec, { type: 'status', status: 'starting', detail: 'Setup: running .oide/setup' }),
            onOutput: (line) => this.emitDraft(rec, { type: 'stderr', text: `[setup] ${line}` }),
          });
          if (!setup.ok) {
            this.emitDraft(rec, { type: 'error', message: `Setup failed${setup.output ? `: ${setup.output.slice(-500)}` : ''}`, code: 'spawn' });
            this.emitDraft(rec, { type: 'status', status: 'error' });
            return;
          }
        }
      }
      // Every launch: the broker writes fresh one-time launch nonces and returns the env the
      // agent needs for its mcp.json placeholders (no secret is written to the file).
      const extra = (await this.deps.settings.extraMcpServers?.(rec.spec, rec.id)) ?? {};
      const secretEnv = (await this.deps.settings.extraEnv?.(rec.spec, rec.id)) ?? {};
      const reg = await this.deps.broker.registerAgent(
        rec.id,
        {
          onPermissionRequest: (req) => this.onPermissionRequest(rec, req),
          onPermissionResolved: (requestId, behavior, reason) => this.onPermissionResolved(rec, requestId, behavior, reason),
          onReview: (review) => this.emitDraft(rec, { type: 'review-submitted', review: { agentId: rec.id, summary: review.summary, checks: review.checks, ...(review.pr ? { pr: review.pr } : {}), submittedAt: Date.now() } }),
          onTitle: (title) => this.setOwnTitle(rec, title),
        },
        extra,
        { projectId: rec.spec.projectId, secretEnv },
      );
      rec.mcpConfigPath = reg.mcpConfigPath;
      const agentEnv = reg.env ?? secretEnv;
      const project = await this.deps.settings.project?.(rec.spec.projectId);
      const customModel = rec.spec.customModel ? await this.deps.settings.customModel?.(rec.spec.customModel.id) : undefined;
      const customModelSecret = customModel?.hasKey ? await this.deps.secrets?.customModelKey(customModel.id) : undefined;
      let firstAttachments: MessageAttachment[] | undefined;
      if (!(resume || rec.started) && rec.firstAttachments?.length) {
        const cwd = rec.worktree.path;
        firstAttachments = this.deps.attachments ? await this.deps.attachments.materialize({ agentId: rec.id, projectId: rec.spec.projectId, cwd, attachments: rec.firstAttachments }) : rec.firstAttachments;
      }
      const launchedMode = rec.spec.mode;
      const plan = buildLaunch(rec.spec, {
        agentId: rec.id,
        sessionId: rec.sessionId,
        resume: resume || rec.started,
        cwd: rec.worktree.path,
        ...(rec.worktree.branch ? { branch: rec.worktree.branch } : {}),
        ...(rec.worktree.baseRef ? { baseRef: rec.worktree.baseRef } : {}),
        cli,
        settings,
        techniques: (await this.deps.settings.techniques?.(rec.spec.projectId)) ?? settings.techniques,
        ...(project?.rules ? { projectRules: project.rules } : {}),
        trusted: project?.trusted ?? false,
        extensionTools: (await this.deps.settings.extensionTools?.(rec.spec, rec.id)) ?? [],
        extraEnv: agentEnv,
        mcpConfigPath: rec.mcpConfigPath,
        ...(customModel ? { customModel } : {}),
        ...(customModelSecret ? { customModelSecret } : {}),
        ...(this.deps.baseEnv ? { baseEnv: this.deps.baseEnv } : {}),
        ...(this.deps.settings.resolveArtifact ? { resolveArtifact: this.deps.settings.resolveArtifact } : {}),
        ...(firstAttachments ? { firstAttachments } : {}),
      });
      rec.askRules = plan.askRules;
      for (const w of plan.warnings) this.emitDraft(rec, { type: 'stderr', text: `[oide] ${w}` });
      const handle = await this.driver.start(rec.spec, {
        agentId: rec.id,
        sessionId: rec.sessionId,
        cwd: rec.worktree.path,
        launch: plan,
        nextSeq: () => rec.seq++,
        ...(this.deps.settings.resolveArtifact ? { resolveArtifact: this.deps.settings.resolveArtifact } : {}),
        ...(this.deps.sink.appendRaw ? { onRawLine: (line: string) => void this.deps.sink.appendRaw!(rec.id, line) } : {}),
        ...(this.deps.log ? { log: this.deps.log } : {}),
      });
      rec.handle = handle;
      // A mode picked while the process was starting: apply it now, or the new process's init would undo it.
      if (rec.spec.mode !== launchedMode) {
        const picked = rec.spec.mode;
        this.setMode(rec.id, picked).catch((err) => this.deps.log?.('mode change after launch failed', (err as Error).message));
      }
      // Running again: no longer "Interrupted" (the next status event publishes this).
      delete rec.reducer.summary.interrupted;
      const wasStarted = rec.started;
      rec.started = true;
      void this.consume(rec, handle);
      if (plan.firstMessage) {
        delete rec.firstAttachments;
        this.emitDraft(rec, { type: 'user-text', text: messageText(plan.firstMessage), ...(firstAttachments?.length ? { attachments: firstAttachments } : {}) });
        this.emitDraft(rec, { type: 'status', status: 'running' });
        if (rec.held.length) this.flushHeld(rec);
      }
      else if (rec.held.length) this.flushHeld(rec);
      else this.emitDraft(rec, { type: 'status', status: wasStarted || resume ? rec.idleStatus : 'running', detail: 'resume' });
    } catch (err) {
      this.deps.log?.('agent launch failed', err);
      this.emitDraft(rec, { type: 'error', message: (err as Error).message, code: 'spawn' });
      this.emitDraft(rec, { type: 'status', status: 'error' });
    } finally {
      rec.launching = false;
      void this.pump();
    }
  }

  private async consume(rec: AgentRecord, handle: AgentHandle): Promise<void> {
    try {
      for await (const e of handle.events) this.ingest(rec, e, rawJsonOf(e));
    } catch (err) {
      this.deps.log?.('agent event stream failed', err);
    }
    if (rec.handle === handle) delete rec.handle;
    for (const [id] of rec.pendingPermissions) this.deps.broker.answer(id, { requestId: id, behavior: 'deny', message: 'The agent process exited' });
    rec.pendingPermissions.clear();
    void this.pump();
  }

  // ------------------------------------------------------------------ event plumbing

  private ingest(rec: AgentRecord, e: AgentEvent, raw?: string): void {
    // A record replaced by unarchive (same id) must not publish from its stale reducer.
    if (this.agents.get(rec.id) !== rec) return;
    const prevStatus = rec.reducer.summary.status;
    try {
      const p = this.deps.sink.append(e, raw);
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch((err) => this.deps.log?.('event sink failed', err));
    } catch (err) {
      this.deps.log?.('event sink failed', err);
    }
    const res = rec.reducer.apply(e);
    if (e.type === 'init' && e.sessionId) rec.sessionId = e.sessionId;
    // The CLI changes mode on its own (plan → manual after the plan is approved). Keep the spec in
    // step so a resume relaunches in the mode the agent is really in, not the one it was spawned with.
    if ((e.type === 'init' || e.type === 'mode-changed') && rec.reducer.summary.mode !== rec.spec.mode) {
      rec.spec = { ...rec.spec, mode: rec.reducer.summary.mode };
    }
    this.fire('event', e);
    for (const sub of res.subagents) this.emitDraft(rec, { type: 'subagent', subagent: sub });
    if (res.changed) this.publishSummary(rec);
    const status = rec.reducer.summary.status;
    if (status !== prevStatus && ACTIVE.has(prevStatus) && !ACTIVE.has(status)) void this.pump();
  }

  private emitDraft(rec: AgentRecord, draft: AgentEventDraft): void {
    const parsed = AgentEvent.safeParse({ ...draft, agentId: rec.id, seq: rec.seq++, ts: Date.now() });
    if (!parsed.success) {
      this.deps.log?.('invalid supervisor event', parsed.error.message);
      return;
    }
    this.ingest(rec, parsed.data);
  }

  /**
   * `set_title` from the agent: replace the stand-in title Spawn made from the goal. Only while the
   * spec still says so (a title the user or oIDE gave is kept); once named, later calls are refused.
   * Parallel attempts keep their " #n" suffix. The worktree branch keeps its first name.
   */
  private setOwnTitle(rec: AgentRecord, raw: string): TitleResult {
    if (this.agents.get(rec.id) !== rec) return { ok: false, message: 'This agent is no longer active.' };
    if (!rec.spec.autoTitle) return { ok: false, message: 'This agent already has its title; keep it.' };
    const clean = cleanAgentTitle(raw);
    if (!clean) return { ok: false, message: 'The title was empty.' };
    const suffix = rec.spec.attemptGroup ? (/ #\d+$/.exec(rec.spec.title)?.[0] ?? '') : '';
    const title = `${clean}${suffix}`;
    const { autoTitle: _, ...spec } = rec.spec;
    rec.spec = { ...spec, title };
    this.emitDraft(rec, { type: 'title-changed', title });
    return { ok: true, title };
  }

  private publishSummary(rec: AgentRecord): void {
    const s = rec.reducer.summary;
    this.fire('summary', s);
    try {
      const p = this.deps.sink.saveSummary?.(s, rec.spec);
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch((err) => this.deps.log?.('saveSummary failed', err));
    } catch (err) {
      this.deps.log?.('saveSummary failed', err);
    }
  }

  // ------------------------------------------------------------------ permissions and review

  private onPermissionRequest(rec: AgentRecord, req: PermissionRequest): void {
    const subagentId = req.subagentId ?? rec.reducer.tracker.ownerOfToolUse(req.toolUseId);
    const request: PermissionRequest = { ...req, agentId: rec.id, ...(subagentId ? { subagentId } : {}) };
    // No rule to offer when "Always" could not cover this request: the tile then offers no "Always".
    if (request.suggestedRule && !this.canAlwaysAllow(rec, request)) delete request.suggestedRule;
    if (subagentId && rec.reducer.tracker.isStopRequested(subagentId)) {
      this.deps.broker.answer(req.requestId, { requestId: req.requestId, behavior: 'deny', message: 'Stopped by the user. Do not continue; report back to the lead agent now.' });
      return;
    }
    if (this.alwaysAllows(rec, request)) {
      this.deps.broker.answer(req.requestId, { requestId: req.requestId, behavior: 'allow', always: false });
      return;
    }
    const first = rec.pendingPermissions.size === 0;
    rec.pendingPermissions.set(request.requestId, request);
    if (first) this.emitDraft(rec, { type: 'permission-request', request });
  }

  private onPermissionResolved(rec: AgentRecord, requestId: string, behavior: 'allow' | 'deny', reason?: 'quit'): void {
    if (!rec.pendingPermissions.delete(requestId)) return;
    this.emitDraft(rec, { type: 'permission-resolved', requestId, behavior, ...(reason ? { reason } : {}) });
    const next = rec.pendingPermissions.values().next();
    if (!next.done) this.emitDraft(rec, { type: 'permission-request', request: next.value });
  }

  /** Answer a pending prompt. Only the exact pending request id of this agent is accepted. */
  async answerPermission(agentId: string, answer: PermissionAnswer): Promise<boolean> {
    const rec = this.require(agentId);
    const pending = rec.pendingPermissions.get(answer.requestId);
    if (!pending) return false;
    const ok = this.deps.broker.answer(answer.requestId, answer);
    const rule = pending.suggestedRule;
    if (ok && answer.behavior === 'allow' && answer.always && rule && this.canAlwaysAllow(rec, pending)) {
      const projectId = rec.spec.projectId;
      let rules = this.alwaysAllowed.get(projectId);
      if (!rules) this.alwaysAllowed.set(projectId, (rules = new Set()));
      rules.add(rule);
      this.allowWaiting(projectId);
      try {
        await this.deps.settings.addAllowRule?.(projectId, rule);
      } catch (err) {
        this.deps.log?.('saving always-allow rule failed', err);
      }
    }
    return ok;
  }

  /** A request "Always" may cover: not an always-ask tool or rule, not an edit of .oide/, .claude/ or .mcp.json. */
  private canAlwaysAllow(rec: AgentRecord, req: PermissionRequest): boolean {
    if (!req.suggestedRule || requestTargetsProtectedPath(req.toolName, req.input)) return false;
    for (const r of rec.askRules) if (askRuleCovers(r, req.toolName, req.input)) return false;
    return true;
  }

  /** Answered without a prompt: an "Always" rule covers it, and an edit stays inside the agent's worktree. */
  private alwaysAllows(rec: AgentRecord, req: PermissionRequest): boolean {
    const rules = this.alwaysAllowed.get(rec.spec.projectId);
    if (!req.suggestedRule || !rules?.has(req.suggestedRule) || !this.canAlwaysAllow(rec, req)) return false;
    return editStaysInside(req.toolName, req.input, rec.worktree?.path);
  }

  /** After a new "Always" rule: allow every waiting prompt in the project it covers. */
  private allowWaiting(projectId: string): void {
    for (const rec of this.agents.values()) {
      if (rec.spec.projectId !== projectId) continue;
      for (const req of [...rec.pendingPermissions.values()]) {
        if (this.alwaysAllows(rec, req)) this.deps.broker.answer(req.requestId, { requestId: req.requestId, behavior: 'allow', always: false });
      }
    }
  }

  // ------------------------------------------------------------------ tile controls

  private require(agentId: string): AgentRecord {
    const rec = this.agents.get(agentId);
    if (!rec) throw new Error(`Unknown agent ${agentId}`);
    return rec;
  }

  /** Reply, review feedback, artifact, or a slash command. Held while paused; restarts a dead process. */
  send(agentId: string, msg: UserMessage): void {
    const rec = this.require(agentId);
    const status = rec.reducer.summary.status;
    if (rec.reducer.summary.resumeBlocked && !rec.handle?.alive) throw new LaunchError(rec.reducer.summary.resumeBlocked);
    if (status === 'paused' || status === 'queued' || rec.launching) {
      rec.held.push(msg);
      return;
    }
    if (rec.handle?.alive) {
      this.deliver(rec, msg);
      return;
    }
    rec.held.push(msg);
    this.enqueueResume(rec);
  }

  private deliver(rec: AgentRecord, msg: UserMessage): void {
    const isCompact = msg.kind === 'command' && msg.command.trim() === '/compact';
    rec.handle!.send(msg);
    const text =
      msg.kind === 'text'
        ? msg.text
        : msg.kind === 'command'
          ? msg.command
          : msg.kind === 'review-feedback'
            ? `Review feedback (${msg.comments.length} comments)`
            : msg.kind === 'merge-conflicts'
              ? mergeConflictsText(msg)
              : `Artifact ${msg.artifactId}`;
    const attachments = msg.kind === 'text' || msg.kind === 'artifact' ? msg.attachments : undefined;
    // Merge conflicts are written by oIDE: the transcript shows the whole message, marked "Sent by oIDE".
    this.emitDraft(rec, { type: 'user-text', text, ...(attachments?.length ? { attachments } : {}), ...(msg.kind === 'merge-conflicts' ? { origin: 'oide' as const } : {}) });
    this.emitDraft(rec, { type: 'status', status: 'running', ...(isCompact ? { detail: 'compact' } : {}) });
  }

  private flushHeld(rec: AgentRecord): void {
    const msgs = rec.held.splice(0);
    for (const m of msgs) this.deliver(rec, m);
  }

  private enqueueResume(rec: AgentRecord): void {
    if (this.queue.some((q) => q.id === rec.id)) return;
    this.emitDraft(rec, { type: 'status', status: 'queued', detail: 'resume' });
    this.queue.push({ id: rec.id, resume: rec.started });
    void this.pump();
  }

  /** `/compact`, sent after the UI's confirm dialog. Verified to work over stream-json input. */
  compact(agentId: string): void {
    this.send(agentId, { kind: 'command', command: '/compact' });
  }

  /**
   * Focus mode menu / Shift+Tab: control request; falls back to interrupt + `--resume` with the new
   * mode. Calls for one agent run in order, so the last pick wins even when an earlier one falls back.
   */
  async setMode(agentId: string, mode: PermissionMode): Promise<void> {
    const rec = this.require(agentId);
    const run = (rec.modeChain ?? Promise.resolve()).then(() => this.applyMode(rec, mode));
    rec.modeChain = run.catch(() => {});
    await run;
  }

  private async applyMode(rec: AgentRecord, mode: PermissionMode): Promise<void> {
    const settings = await this.deps.settings.get();
    if (mode === 'bypassPermissions' && (!settings.claude.allowBypass || rec.spec.workIn === 'project-folder')) {
      throw new LaunchError('Bypass mode is not allowed for this agent');
    }
    rec.spec = { ...rec.spec, mode };
    if (!rec.handle?.alive) {
      this.emitDraft(rec, { type: 'mode-changed', mode });
      return;
    }
    const cli = await this.deps.settings.cli();
    try {
      await rec.handle.setMode(cliPermissionMode(mode, cli, []) as PermissionMode);
    } catch (err) {
      this.deps.log?.('set_permission_mode failed; restarting with --resume', (err as Error).message);
      const idle = rec.reducer.summary.status;
      await this.killProcess(rec);
      rec.idleStatus = ACTIVE.has(idle) ? IDLE_AFTER_RESUME : idle;
      this.emitDraft(rec, { type: 'mode-changed', mode });
      this.emitDraft(rec, { type: 'status', status: 'queued', detail: 'resume' });
      this.queue.unshift({ id: rec.id, resume: true });
      void this.pump();
    }
  }

  private async killProcess(rec: AgentRecord): Promise<void> {
    const h = rec.handle;
    if (!h?.alive) return;
    await h.interrupt();
    await h.dispose();
  }

  /** Stop: interrupt the turn and end the process. The session stays resumable. */
  async stop(agentId: string): Promise<void> {
    const rec = this.require(agentId);
    this.dropFromQueue(agentId);
    rec.held = [];
    this.emitDraft(rec, { type: 'status', status: 'stopped' });
    for (const [id] of rec.pendingPermissions) this.deps.broker.answer(id, { requestId: id, behavior: 'deny', message: 'Stopped by user' });
    await this.killProcess(rec);
    void this.pump();
  }

  /** Pause: interrupt the current turn and hold new messages until resume(). */
  async pause(agentId: string): Promise<void> {
    const rec = this.require(agentId);
    const status = rec.reducer.summary.status;
    if (status === 'queued') {
      this.dropFromQueue(agentId);
      rec.idleStatus = 'queued';
      this.emitDraft(rec, { type: 'status', status: 'paused' });
      return;
    }
    const wasActive = ACTIVE.has(status);
    rec.idleStatus = wasActive ? IDLE_AFTER_RESUME : status;
    this.emitDraft(rec, { type: 'status', status: 'paused' });
    if (wasActive && rec.handle?.alive) await rec.handle.interrupt();
    void this.pump();
  }

  /** Resume a paused agent, or respawn a stopped / crashed / restored one with `--resume <sessionId>`. */
  async resume(agentId: string): Promise<void> {
    const rec = this.require(agentId);
    const status = rec.reducer.summary.status;
    if (status === 'paused' && rec.idleStatus === 'queued') {
      this.emitDraft(rec, { type: 'status', status: 'queued' });
      this.queue.push({ id: rec.id, resume: rec.started });
      void this.pump();
      return;
    }
    if (rec.handle?.alive) {
      if (rec.held.length) this.flushHeld(rec);
      else if (status === 'paused') this.emitDraft(rec, { type: 'status', status: rec.idleStatus, detail: 'resume' });
      return;
    }
    if (ACTIVE.has(status) || status === 'queued') return;
    if (rec.reducer.summary.resumeBlocked) throw new LaunchError(rec.reducer.summary.resumeBlocked);
    rec.idleStatus = status === 'paused' || status === 'stopped' || status === 'error' || status === 'done' ? IDLE_AFTER_RESUME : status;
    this.enqueueResume(rec);
  }

  /** Diff counts from the worktree (`git diff --numstat`), refreshed by main after edits. */
  setDiff(agentId: string, diff: AgentSummary['diff']): void {
    const rec = this.agents.get(agentId);
    if (!rec) return;
    const cur = rec.reducer.summary.diff;
    if (cur && diff && cur.files === diff.files && cur.additions === diff.additions && cur.deletions === diff.deletions) return;
    if (diff) rec.reducer.summary.diff = diff;
    else delete rec.reducer.summary.diff;
    this.publishSummary(rec);
  }

  /** The branch's pull request (main's gh lookups); publishes only on a change. */
  setPr(agentId: string, pr: AgentSummary['pr']): void {
    const rec = this.agents.get(agentId);
    if (!rec) return;
    const cur = rec.reducer.summary.pr;
    if (cur?.number === pr?.number && cur?.state === pr?.state && cur?.url === pr?.url && cur?.mergeCommit === pr?.mergeCommit) return;
    if (pr) rec.reducer.summary.pr = pr;
    else delete rec.reducer.summary.pr;
    this.publishSummary(rec);
  }

  /** "Resolving merge conflicts" (main sets it after sending the conflicts; the reducer clears it on submit_for_review). */
  setMergeConflict(agentId: string, info: AgentSummary['mergeConflict']): void {
    const rec = this.agents.get(agentId);
    if (!rec) return;
    if (!info && !rec.reducer.summary.mergeConflict) return;
    if (info) rec.reducer.summary.mergeConflict = info;
    else delete rec.reducer.summary.mergeConflict;
    this.publishSummary(rec);
  }

  /** Stop one subagent (open question 9): deny its next tool call with a stop message. */
  stopSubagent(agentId: string, subagentId: string): boolean {
    const rec = this.require(agentId);
    if (!rec.reducer.tracker.requestStop(subagentId)) return false;
    for (const [id, req] of rec.pendingPermissions) {
      if (req.subagentId === subagentId) this.deps.broker.answer(id, { requestId: id, behavior: 'deny', message: 'Stopped by the user. Do not continue; report back to the lead agent now.' });
    }
    return true;
  }

  async remove(agentId: string, opts: { deleteWorktree?: boolean } = {}): Promise<void> {
    const rec = this.require(agentId);
    this.dropFromQueue(agentId);
    await this.killProcess(rec);
    await this.deps.broker.unregisterAgent(agentId).catch((err) => this.deps.log?.('unregister failed', err));
    if (opts.deleteWorktree && rec.worktree && this.deps.worktrees.remove) {
      await this.deps.worktrees.remove({ agentId, path: rec.worktree.path, projectId: rec.spec.projectId, ...(rec.worktree.branch ? { branch: rec.worktree.branch } : {}) });
    }
    this.agents.delete(agentId);
    await this.deps.sink.removeAgent?.(agentId);
    this.fire('removed', agentId);
    void this.pump();
  }

  /**
   * Move an agent to the Archived view: end its process (pending prompts are denied), optionally
   * delete its worktree, stamp `summary.archived` and save it. The agent leaves the supervisor, so
   * it no longer counts toward Max running or any Wall counter; its row, summary and events stay.
   */
  async archive(agentId: string, opts: ArchiveOptions): Promise<AgentSummary> {
    const rec = this.require(agentId);
    this.dropFromQueue(agentId);
    rec.held = [];
    for (const [id] of rec.pendingPermissions) this.deps.broker.answer(id, { requestId: id, behavior: 'deny', message: 'The agent was archived' });
    const status = rec.reducer.summary.status;
    if (ACTIVE.has(status) || status === 'queued' || status === 'paused') this.emitDraft(rec, { type: 'status', status: 'stopped' });
    await this.killProcess(rec);
    await this.deps.broker.unregisterAgent(agentId).catch((err) => this.deps.log?.('unregister failed', err));
    let worktreeRemoved = false;
    if (opts.deleteWorktree && rec.worktree && this.deps.worktrees.remove) {
      try {
        const r = await this.deps.worktrees.remove({ agentId, path: rec.worktree.path, projectId: rec.spec.projectId, ...(rec.worktree.branch ? { branch: rec.worktree.branch } : {}) });
        worktreeRemoved = r !== false;
      } catch (err) {
        // Archive anyway: the folder stays (it is not an orphan) and the user can delete it later.
        this.deps.log?.('worktree removal failed while archiving', err);
      }
    }
    const now = Date.now();
    const s = rec.reducer.summary;
    delete s.pendingPermission;
    delete s.interrupted;
    s.archived = { at: now, reason: opts.reason, ...(opts.mergeCommit ? { mergeCommit: opts.mergeCommit } : {}), worktreeRemoved };
    if (worktreeRemoved) s.resumeBlocked = WORKTREE_GONE;
    s.updatedAt = now;
    try {
      const p = this.deps.sink.saveSummary?.(s, rec.spec);
      if (p && typeof (p as Promise<void>).catch === 'function') await (p as Promise<void>);
    } catch (err) {
      this.deps.log?.('saveSummary failed while archiving', err);
    }
    this.agents.delete(agentId);
    this.fire('archived', { ...s });
    void this.pump();
    return { ...s };
  }

  /**
   * Bring an archived agent back to the Wall (stopped; Resume respawns with `--resume`). Pass
   * `resumeBlocked` when its session cannot be resumed (the worktree is gone).
   */
  unarchive(entry: RestoreEntry & { resumeBlocked?: string }): AgentSummary {
    const existing = this.agents.get(entry.summary.id);
    if (existing) return existing.reducer.summary;
    const s: AgentSummary = { ...entry.summary };
    delete s.archived;
    delete s.pendingPermission;
    delete s.interrupted;
    if (ACTIVE.has(s.status) || s.status === 'queued' || s.status === 'paused') s.status = 'stopped';
    if (entry.resumeBlocked) s.resumeBlocked = entry.resumeBlocked;
    else delete s.resumeBlocked;
    s.updatedAt = Date.now();
    const parsed = specFromSaved(entry.spec, s);
    s.workIn = parsed.workIn;
    const rec = this.newRecord(parsed, s, (entry.lastSeq ?? -1) + 1, Boolean(s.sessionId));
    this.agents.set(rec.id, rec);
    this.publishSummary(rec);
    return rec.reducer.summary;
  }

  private dropFromQueue(agentId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.id === agentId) this.queue.splice(i, 1);
  }

  // ------------------------------------------------------------------ restart

  /**
   * Register agents persisted before an app restart. Live statuses become `stopped` (their process is
   * gone; Resume respawns with `--resume <sessionId>`); queued agents go back into the queue.
   */
  restore(entries: RestoreEntry[]): AgentSummary[] {
    const now = Date.now();
    for (const { spec, summary, lastSeq, interruption } of entries) {
      if (this.agents.has(summary.id) || summary.archived) continue;
      const wasQueued = summary.status === 'queued';
      const started = !wasQueued && Boolean(summary.sessionId);
      const s: AgentSummary = { ...summary };
      delete s.pendingPermission;
      // It was working when oIDE went away (a live status, or the caller knows it was): "Interrupted"
      // on the Wall until it runs again. A clean quit already saved these as stopped.
      if (ACTIVE.has(s.status) || interruption) s.interrupted = { at: now, reason: interruption ?? 'restart' };
      if (ACTIVE.has(s.status) || s.status === 'paused') s.status = 'stopped';
      // Saved before the spec followed the CLI's own mode changes: the summary's mode is the real one.
      const parsed = specFromSaved(spec, s);
      s.workIn = parsed.workIn;
      const rec = this.newRecord(parsed, s, (lastSeq ?? -1) + 1, started);
      this.agents.set(rec.id, rec);
      if (wasQueued) this.queue.push({ id: rec.id, resume: false });
    }
    void this.pump();
    return this.list();
  }

  /** Stop every process (app quit). Pending prompts are denied by the broker's own shutdown. */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    await Promise.all(
      [...this.agents.values()].map(async (rec) => {
        if (rec.handle?.alive) {
          if (ACTIVE.has(rec.reducer.summary.status)) this.emitDraft(rec, { type: 'status', status: 'stopped' });
          await rec.handle.dispose();
        }
      }),
    );
  }
}
