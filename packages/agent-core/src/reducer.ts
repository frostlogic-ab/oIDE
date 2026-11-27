import {
  PermissionMode,
  TodoItem,
  baseModelId,
  contextWindowFor,
  type AgentEvent,
  type AgentStatus,
  type AgentSummary,
  type Effort,
  type SubagentInfo,
  type TokenUsage,
  type WorkIn,
} from '@oide/protocol';
import { z } from 'zod';
import type { TierInfo } from './args.js';
import { ContextWindowBook } from './context-window.js';
import { SubagentTracker } from './subagents.js';

/**
 * Events → AgentSummary (the Wall tile). Status table from the build brief:
 * Queued (supervisor), Running (a message was sent, no result yet), Needs permission (pending MCP prompt),
 * Has a question (result without submit_for_review), Ready for review (submit_for_review called),
 * Error (non-zero exit, auth error), Paused by plan limit (rate-limit event; no auto retry).
 * One refinement (ADR 0016): a follow-up turn on an agent that already submitted for review goes back
 * to Ready for review when its last message asks the user nothing (a status report, "CI is green").
 */

export interface ReducerOptions {
  tiers?: Record<string, TierInfo>;
  activityLimit?: number;
  /** Context windows learned from the CLI, shared across agents by the supervisor. */
  windows?: ContextWindowBook;
}

const EPHEMERAL = new Set(['Thinking…', 'Writing…']);
/** Idle statuses a turn the CLI starts on its own (no message from the user) turns back into running. */
const WOKEN: ReadonlySet<AgentStatus> = new Set(['has-question', 'ready-for-review']);
const MAX_LINE = 90;
/** The window assumed when a request outgrows the table's guess (the largest window the CLI reports today). */
const LARGE_WINDOW = 1_000_000;

function clip(s: string, n = MAX_LINE): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

const QUESTION_MARK = /\?(?=$|[\s"')\]*_.,:;!])/m;
const ASKS_USER =
  /\b(?:let me know|please (?:confirm|choose|decide|advise|tell me|reply|answer)|tell me (?:which|whether|if|what|how)|(?:waiting|wait) for your|your call|up to you|i need (?:you|your)|need your (?:input|answer|decision|go-ahead|approval))\b/i;

/**
 * Whether an agent's final message asks the user something: a question mark outside code and links,
 * or a plain request for an answer ("Let me know which you prefer."). Errs towards yes, since a missed
 * question leaves the user unaware the agent is waiting on them.
 */
export function asksUser(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\]\([^)\s]*\)/g, '] ');
  return QUESTION_MARK.test(prose) || ASKS_USER.test(prose);
}

/** Show a path relative to the worktree, with forward slashes. */
export function relPath(p: string, cwd?: string): string {
  let out = p.replace(/\\/g, '/');
  if (cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (out.toLowerCase().startsWith(`${base.toLowerCase()}/`)) out = out.slice(base.length + 1);
  }
  return out;
}

/** "Read src/x.ts", "Edit …", "Run npm test" from a tool_use. */
export function describeToolUse(name: string, input: unknown, cwd?: string): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  const path = s('file_path') ?? s('notebook_path') ?? s('path');
  switch (name) {
    case 'Read':
      return clip(`Read ${path ? relPath(path, cwd) : 'file'}`);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return clip(`Edit ${path ? relPath(path, cwd) : 'file'}`);
    case 'Write':
      return clip(`Write ${path ? relPath(path, cwd) : 'file'}`);
    case 'Bash':
    case 'PowerShell':
      return clip(`Run ${s('command') ?? s('description') ?? 'command'}`);
    case 'Grep':
      return clip(`Search ${s('pattern') ?? ''}`);
    case 'Glob':
      return clip(`Find ${s('pattern') ?? ''}`);
    case 'WebFetch':
      return clip(`Fetch ${s('url') ?? ''}`);
    case 'WebSearch':
      return clip(`Search the web for ${s('query') ?? ''}`);
    case 'TodoWrite':
      return 'Update plan';
    case 'ExitPlanMode':
      return 'Plan ready';
    case 'ToolSearch':
      return 'Load tools';
    case 'Agent':
    case 'Task':
      return clip(`Delegate: ${s('description') ?? s('subagent_type') ?? 'subagent'}`);
    case 'mcp__oide__set_title':
      return 'Name the task';
    case 'mcp__oide__submit_for_review':
      return 'Submit for review';
    case 'mcp__oide__permission_prompt':
      return 'Ask permission';
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      if (m) return clip(`${m[1]}: ${m[2]}`);
      return clip(name);
    }
  }
}

/** CLI mode strings → oIDE PermissionMode (`manual` is the CLI's new name for `default`). */
export function toPermissionMode(mode: string | undefined): PermissionMode | undefined {
  if (!mode) return undefined;
  if (mode === 'manual') return 'default';
  const r = PermissionMode.safeParse(mode);
  return r.success ? r.data : undefined;
}

export interface NewSummaryInput {
  id: string;
  projectId: string;
  title: string;
  mode: PermissionMode;
  model: string;
  status?: AgentStatus;
  attemptGroup?: string;
  sessionId?: string;
  workIn?: WorkIn;
  artifactId?: string;
  effort?: Effort;
  now?: number;
}

export function createSummary(input: NewSummaryInput): AgentSummary {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    status: input.status ?? 'queued',
    mode: input.mode,
    model: input.model,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.attemptGroup ? { attemptGroup: input.attemptGroup } : {}),
    ...(input.workIn ? { workIn: input.workIn } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    activity: [],
    contextUsed: 0,
    contextWindow: contextWindowFor(input.model),
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    subagents: [],
    todos: [],
    backgroundTasks: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const TodoInput = z.looseObject({ todos: z.array(TodoItem) });

function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation };
}

export interface ApplyResult {
  summary: AgentSummary;
  /** False when the event did not change the summary (e.g. a repeated partial). */
  changed: boolean;
  /** Subagents whose info changed; the supervisor turns these into `subagent` events. */
  subagents: SubagentInfo[];
}

export class AgentReducer {
  summary: AgentSummary;
  readonly tracker: SubagentTracker;
  private readonly activityLimit: number;
  private readonly seenUsage = new Set<string>();
  private reviewSinceSend = false;
  private readonly windows: ContextWindowBook;
  private lastStderr = '';
  private leadUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  /** The CLI's `total_cost_usd` is cumulative per process; this is the last value of the current one. */
  private processCost = 0;

  constructor(initial: AgentSummary, opts: ReducerOptions = {}) {
    this.summary = { ...initial };
    this.windows = opts.windows ?? new ContextWindowBook();
    // A restored summary keeps the window the CLI reported last time; the table never reports more
    // than the CLI, so a larger stored value was learned (a smaller one may be a stale table value).
    if (initial.model && !this.windows.has(initial.model) && initial.contextWindow > contextWindowFor(initial.model)) {
      this.windows.learn(initial.model, initial.contextWindow);
    }
    this.tracker = new SubagentTracker(initial.id, { ...(opts.tiers ? { tiers: opts.tiers } : {}), windowFor: (m) => this.windows.get(m) });
    this.activityLimit = opts.activityLimit ?? 6;
    if (initial.review) this.reviewSinceSend = initial.status === 'ready-for-review';
  }

  /**
   * The lead model's window from a result. `modelUsage` lists every model the turn used (a subagent
   * on another model, the CLI's own background calls), so the lead's entry is picked by id; the
   * largest one is only used when the result has no per-model map (events stored by older builds).
   */
  private resultWindow(model: string, perModel: Record<string, number> | undefined, largest: number | undefined): number | undefined {
    if (perModel) {
      for (const [m, w] of Object.entries(perModel)) this.windows.learn(m, w);
      const entries = Object.entries(perModel);
      const lead = baseModelId(model);
      const hit = entries.find(([m]) => baseModelId(m) === lead);
      if (hit) return hit[1];
      if (entries.length === 1) {
        this.windows.learn(model, entries[0]![1]);
        return entries[0]![1];
      }
      return this.windows.has(model) ? this.windows.get(model) : undefined;
    }
    if (largest) this.windows.learn(model, largest);
    return largest;
  }

  /** Tokens of the lead only (subagents excluded), for the token share. */
  get leadTokens(): TokenUsage {
    return { ...this.leadUsage };
  }

  apply(e: AgentEvent): ApplyResult {
    const before = JSON.stringify(this.summary);
    const s: AgentSummary = { ...this.summary, activity: [...this.summary.activity] };
    const subChanges = this.tracker.onEvent(e);
    const lead = !e.parentToolUseId;

    const pushActivity = (line: string, ephemeral = false) => {
      const last = s.activity[s.activity.length - 1];
      if (last !== undefined && EPHEMERAL.has(last)) s.activity.pop();
      if (ephemeral && s.activity[s.activity.length - 1] === line) return;
      s.activity.push(line);
      if (s.activity.length > this.activityLimit) s.activity.splice(0, s.activity.length - this.activityLimit);
    };
    const dropEphemeral = () => {
      const last = s.activity[s.activity.length - 1];
      if (last !== undefined && EPHEMERAL.has(last)) s.activity.pop();
    };
    // The CLI starts turns of its own: a background subagent's report wakes the lead after its turn
    // ended. The lead is working again, so it no longer has a question or waits for review. The next
    // result settles the status again (a submitted review still wins, see statusAfterResult).
    const leadWorking = () => {
      if (lead && WOKEN.has(s.status)) s.status = 'running';
    };

    switch (e.type) {
      case 'status':
        s.status = e.status;
        if (e.status === 'running' && e.detail !== 'compact' && e.detail !== 'resume') {
          this.reviewSinceSend = false;
          delete s.error;
        }
        if (e.status === 'starting' && e.detail) pushActivity(clip(e.detail));
        break;
      case 'init':
        this.processCost = 0;
        if (e.sessionId) s.sessionId = e.sessionId;
        if (e.model) {
          s.model = e.model;
          s.contextWindow = this.windows.get(e.model);
        }
        {
          const m = toPermissionMode(e.permissionMode);
          if (m) s.mode = m;
        }
        if (s.status === 'starting') s.status = 'running';
        break;
      case 'mode-changed': {
        const m = toPermissionMode(e.mode);
        if (m) s.mode = m;
        break;
      }
      case 'model-changed':
        s.model = e.model;
        s.contextWindow = this.windows.get(e.model);
        if (e.effort) s.effort = e.effort;
        else delete s.effort;
        break;
      case 'partial':
        leadWorking();
        if (lead && e.kind === 'thinking') pushActivity('Thinking…', true);
        else if (lead && e.kind === 'text') pushActivity('Writing…', true);
        break;
      case 'thinking':
        leadWorking();
        if (lead) pushActivity('Thinking…', true);
        break;
      case 'assistant-text':
        leadWorking();
        if (lead) {
          dropEphemeral();
          if (e.text.trim()) s.lastMessage = e.text;
        }
        break;
      case 'tool-use':
        leadWorking();
        if (lead) {
          pushActivity(describeToolUse(e.name, e.input, s.worktreePath));
          if (e.name === 'TodoWrite') {
            const r = TodoInput.safeParse(e.input);
            if (r.success) s.todos = r.data.todos;
          }
          if (e.name === 'ExitPlanMode') {
            const plan = (e.input as { plan?: unknown } | undefined)?.plan;
            if (typeof plan === 'string') s.planText = plan;
          }
        }
        break;
      case 'todos':
        s.todos = e.todos;
        break;
      case 'usage': {
        const key = e.messageId ? `${e.parentToolUseId ?? ''}:${e.messageId}` : `seq:${e.seq}`;
        if (!this.seenUsage.has(key)) {
          this.seenUsage.add(key);
          s.usage = add(s.usage, e.usage);
          if (lead) this.leadUsage = add(this.leadUsage, e.usage);
        }
        // Context = what the latest lead request sent: input + cache read + cache creation (output is
        // not in it yet). Matches the CLI's own /context total (fixtures real-context-*.jsonl).
        if (lead) {
          const used = e.usage.input + e.usage.cacheRead + e.usage.cacheCreation;
          if (used > 0) {
            s.contextUsed = used;
            s.contextBaseline ??= used;
            // A request larger than the window proves the window is wrong (an unverified model on the
            // 200k fallback before its first result). Assume the next size up until the CLI reports it.
            if (used > s.contextWindow && !this.windows.has(s.model)) s.contextWindow = LARGE_WINDOW;
          }
        }
        break;
      }
      case 'context-usage':
        if (lead) {
          s.contextUsed = e.used;
          s.contextWindow = e.window;
          this.windows.learn(e.model ?? s.model, e.window);
        }
        break;
      case 'result':
        {
          const w = this.resultWindow(s.model, e.contextWindows, e.contextWindow);
          if (w) s.contextWindow = w;
        }
        if (e.totalCostUsd !== undefined && e.totalCostUsd >= 0) {
          // A smaller total than before means a new process whose init we did not see.
          const delta = e.totalCostUsd >= this.processCost ? e.totalCostUsd - this.processCost : e.totalCostUsd;
          this.processCost = e.totalCostUsd;
          s.costUsd = Math.round(((s.costUsd ?? 0) + delta) * 1e6) / 1e6;
        }
        dropEphemeral();
        s.status = this.statusAfterResult(s, e);
        if (s.status === 'error' && e.isError && e.text) s.error = e.text;
        break;
      case 'background-tasks':
        s.backgroundTasks = e.count;
        break;
      case 'permission-request':
        s.pendingPermission = e.request;
        if (s.status !== 'paused' && s.status !== 'stopped') s.status = 'needs-permission';
        if (e.request.subagentId) {
          const sub = this.tracker.setNeedsPermission(e.request.subagentId, true);
          if (sub) subChanges.push(sub);
        }
        break;
      case 'permission-resolved':
        if (s.pendingPermission?.requestId === e.requestId) {
          const subId = s.pendingPermission.subagentId;
          if (e.reason === 'quit') {
            const p = s.pendingPermission;
            s.interruptedPermission = { toolName: p.toolName, ...(p.summary ? { summary: p.summary } : {}), at: e.ts };
          }
          delete s.pendingPermission;
          if (s.status === 'needs-permission') s.status = this.reviewSinceSend ? 'ready-for-review' : 'running';
          if (subId) {
            const sub = this.tracker.setNeedsPermission(subId, false);
            if (sub) subChanges.push(sub);
          }
        }
        break;
      case 'title-changed':
        if (lead && s.title !== e.title) s.title = e.title;
        break;
      case 'review-submitted':
        s.review = e.review;
        this.reviewSinceSend = true;
        if (s.status !== 'needs-permission') s.status = 'ready-for-review';
        // Merge conflicts oIDE sent are resolved once the agent submits again (the user merges by hand).
        if (lead) delete s.mergeConflict;
        pushActivity('Submitted for review');
        break;
      case 'rate-limit':
        s.status = 'rate-limited';
        s.error = e.message;
        if (e.resetAt !== undefined) s.rateLimitResetAt = e.resetAt;
        else if (s.planUsage?.resetsAt) s.rateLimitResetAt = s.planUsage.resetsAt;
        break;
      case 'plan-usage':
        s.planUsage = {
          status: e.status,
          ...(e.window ? { window: e.window } : {}),
          ...(e.utilization !== undefined ? { utilization: e.utilization } : {}),
          ...(e.resetsAt !== undefined ? { resetsAt: e.resetsAt } : {}),
        };
        break;
      case 'compact':
        if (e.phase === 'started') pushActivity('Compacting context…');
        else if (e.phase === 'done') {
          pushActivity('Compacted context');
          if (e.postTokens !== undefined) s.contextUsed = e.postTokens;
        } else pushActivity('Compaction failed');
        break;
      case 'error':
        s.error = e.message;
        if (e.code === 'auth' || e.code === 'spawn' || e.code === 'model_not_found') s.status = 'error';
        break;
      case 'stderr':
        if (e.text.trim()) this.lastStderr = e.text.trim();
        break;
      case 'exit':
        s.exitCode = e.code;
        delete s.pendingPermission;
        s.backgroundTasks = 0;
        if (s.status === 'stopped' || s.status === 'paused') {
          s.status = 'stopped';
        } else if (e.code !== 0 && s.status !== 'rate-limited') {
          s.status = 'error';
          s.error ??= `Claude Code CLI exited with ${e.code === null ? `signal ${e.signal ?? 'unknown'}` : `code ${e.code}`}${this.lastStderr ? `: ${clip(this.lastStderr, 200)}` : ''}`;
        } else if (s.status === 'running' || s.status === 'starting' || s.status === 'needs-permission') {
          s.status = 'stopped';
        }
        break;
      case 'user-text':
        // The user answered the agent after a prompt was cut off by quitting: the note has done its job.
        if (lead) delete s.interruptedPermission;
        if (lead && e.origin === 'oide') pushActivity('Resolving merge conflicts');
        break;
      case 'subagent':
      case 'tool-result':
      case 'subagent-task':
      case 'unknown':
        break;
    }

    if (subChanges.length) s.subagents = this.tracker.list();
    const changed = JSON.stringify(s) !== before;
    if (changed) s.updatedAt = e.ts;
    this.summary = s;
    return { summary: s, changed, subagents: dedupeById(subChanges) };
  }

  private statusAfterResult(s: AgentSummary, e: Extract<AgentEvent, { type: 'result' }>): AgentStatus {
    if (s.status === 'rate-limited' || s.status === 'paused' || s.status === 'stopped') return s.status;
    if (e.isError && e.apiErrorStatus === 429) return 'rate-limited';
    if (s.status === 'error' && s.error) return 'error';
    if (s.pendingPermission) return 'needs-permission';
    if (this.reviewSinceSend) return 'ready-for-review';
    if ((s.backgroundTasks ?? 0) > 0) return 'running';
    if (e.isError && e.subtype !== 'error_during_execution' && e.apiErrorStatus) return 'error';
    // A follow-up turn after an earlier submit_for_review that only reports back (no question) leaves
    // the submitted work standing: it is ready for review again, not waiting on an answer.
    if (s.review && !e.isError && !asksUser(e.text ?? s.lastMessage)) return 'ready-for-review';
    return 'has-question';
  }
}

function dedupeById(xs: SubagentInfo[]): SubagentInfo[] {
  const m = new Map<string, SubagentInfo>();
  for (const x of xs) m.set(x.id, x);
  return [...m.values()];
}

/** Convenience: reduce a list of events onto a summary. */
export function reduceEvents(initial: AgentSummary, events: AgentEvent[], opts?: ReducerOptions): AgentSummary {
  const r = new AgentReducer(initial, opts);
  for (const e of events) r.apply(e);
  return r.summary;
}
