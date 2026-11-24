import {
  PermissionMode,
  TodoItem,
  contextWindowFor,
  type AgentEvent,
  type AgentStatus,
  type AgentSummary,
  type SubagentInfo,
  type TokenUsage,
} from '@oide/protocol';
import { z } from 'zod';
import type { TierInfo } from './args.js';
import { SubagentTracker } from './subagents.js';

/**
 * Events → AgentSummary (the Wall tile). Status table from the build brief:
 * Queued (supervisor), Running (a message was sent, no result yet), Needs permission (pending MCP prompt),
 * Has a question (result without submit_for_review), Ready for review (submit_for_review called),
 * Error (non-zero exit, auth error), Paused by plan limit (rate-limit event; no auto retry).
 */

export interface ReducerOptions {
  tiers?: Record<string, TierInfo>;
  activityLimit?: number;
}

const EPHEMERAL = new Set(['Thinking…', 'Writing…']);
const MAX_LINE = 90;

function clip(s: string, n = MAX_LINE): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
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
  private knownWindow: number | undefined;
  private lastStderr = '';
  private leadUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  constructor(initial: AgentSummary, opts: ReducerOptions = {}) {
    this.summary = { ...initial };
    this.tracker = new SubagentTracker(initial.id, { ...(opts.tiers ? { tiers: opts.tiers } : {}) });
    this.activityLimit = opts.activityLimit ?? 6;
    if (initial.review) this.reviewSinceSend = initial.status === 'ready-for-review';
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
        if (e.sessionId) s.sessionId = e.sessionId;
        if (e.model) {
          s.model = e.model;
          if (!this.knownWindow) s.contextWindow = contextWindowFor(e.model);
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
      case 'partial':
        if (lead && e.kind === 'thinking') pushActivity('Thinking…', true);
        else if (lead && e.kind === 'text') pushActivity('Writing…', true);
        break;
      case 'thinking':
        if (lead) pushActivity('Thinking…', true);
        break;
      case 'assistant-text':
        if (lead) {
          dropEphemeral();
          if (e.text.trim()) s.lastMessage = e.text;
        }
        break;
      case 'tool-use':
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
        if (lead) s.contextUsed = e.usage.input + e.usage.cacheRead + e.usage.cacheCreation;
        break;
      }
      case 'result':
        if (e.contextWindow) {
          this.knownWindow = e.contextWindow;
          s.contextWindow = e.contextWindow;
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
      case 'review-submitted':
        s.review = e.review;
        this.reviewSinceSend = true;
        if (s.status !== 'needs-permission') s.status = 'ready-for-review';
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
