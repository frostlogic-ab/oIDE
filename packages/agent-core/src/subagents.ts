import type { AgentEvent, SubagentInfo, SubagentStatus, TokenUsage } from '@oide/protocol';
import type { TierInfo } from './args.js';

/**
 * SubagentTracker: one per agent. Builds every subagent view from the lead's event stream.
 *
 * Verified on CLI 2.1.325 (fixtures/real-subagent.jsonl):
 * - The lead delegates with the `Agent` tool (older CLIs: `Task`), input {subagent_type, description, prompt}.
 * - With `--forward-subagent-text`, every subagent assistant/user message carries
 *   `parent_tool_use_id` = the lead's Agent tool_use id, including its tool_use blocks and usage.
 * - Subagents may run async: the Agent tool_result is "Async agent launched…" and the report arrives in
 *   `system/task_notification` {tool_use_id, status, summary}. Foreground runs return the report as the tool_result.
 */

export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const ASYNC_LAUNCH = /^Async agent launched/i;

interface Entry {
  info: SubagentInfo;
  transcript: AgentEvent[];
  seenMessages: Set<string>;
  stopRequested: boolean;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation };
}
export function totalTokens(u: TokenUsage | undefined): number {
  return u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
}
const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

export interface TrackerOptions {
  /** subagent_type → tier/model from the `--agents` definitions oIDE generated. */
  tiers?: Record<string, TierInfo>;
  /** Cap on events kept per subagent transcript. */
  maxTranscript?: number;
}

export class SubagentTracker {
  private readonly entries = new Map<string, Entry>();
  /** Any tool_use id seen inside a subagent → that subagent's id (for permission attribution). */
  private readonly toolOwner = new Map<string, string>();
  private readonly taskToTool = new Map<string, string>();
  private readonly tiers: Record<string, TierInfo>;
  private readonly maxTranscript: number;

  constructor(
    readonly agentId: string,
    opts: TrackerOptions = {},
  ) {
    this.tiers = opts.tiers ?? {};
    this.maxTranscript = opts.maxTranscript ?? 2000;
  }

  /** Feed one event. Returns the subagents whose info changed. */
  onEvent(e: AgentEvent): SubagentInfo[] {
    const changed = new Set<Entry>();

    // The lead starts a subagent.
    if (e.type === 'tool-use' && !e.parentToolUseId && SUBAGENT_TOOLS.has(e.name)) {
      if (!this.entries.has(e.toolUseId)) {
        const input = (e.input ?? {}) as { subagent_type?: unknown; description?: unknown; prompt?: unknown; model?: unknown };
        const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
        const tier = subagentType ? this.tiers[subagentType] : undefined;
        const name = typeof input.description === 'string' && input.description ? input.description : (subagentType ?? 'Subagent');
        const info: SubagentInfo = {
          id: e.toolUseId,
          agentId: this.agentId,
          name,
          task: typeof input.prompt === 'string' ? input.prompt : '',
          status: 'queued',
          ...(subagentType ? { subagentType } : {}),
          tier: tier?.tier ?? (subagentType ? 'custom' : undefined),
          ...(tier?.model ? { model: tier.model } : typeof input.model === 'string' ? { model: input.model } : {}),
          ...(tier?.effort ? { effort: tier.effort } : {}),
          usage: { ...ZERO },
        };
        if (!info.tier) delete info.tier;
        const entry: Entry = { info, transcript: [], seenMessages: new Set(), stopRequested: false };
        this.entries.set(e.toolUseId, entry);
        changed.add(entry);
      }
    }

    // Events tagged with the parent id belong to that subagent.
    if (e.parentToolUseId) {
      const entry = this.entries.get(e.parentToolUseId);
      if (entry && e.type !== 'partial') {
        if (entry.transcript.length < this.maxTranscript) entry.transcript.push(e);
        if (entry.info.status === 'queued') {
          entry.info.status = 'running';
          entry.info.startedAt ??= e.ts;
          changed.add(entry);
        }
        if (e.type === 'tool-use') this.toolOwner.set(e.toolUseId, entry.info.id);
        if (e.type === 'usage') {
          const key = e.messageId ?? `seq-${e.seq}`;
          if (!entry.seenMessages.has(key)) {
            entry.seenMessages.add(key);
            entry.info.usage = addUsage(entry.info.usage ?? ZERO, e.usage);
          }
          entry.info.contextUsed = e.usage.input + e.usage.cacheRead + e.usage.cacheCreation;
          if (e.model && !entry.info.model) entry.info.model = e.model;
          changed.add(entry);
        }
      }
    }

    // The CLI's task lifecycle.
    if (e.type === 'subagent-task') {
      if (e.toolUseId) this.taskToTool.set(e.taskId, e.toolUseId);
      const toolId = e.toolUseId ?? this.taskToTool.get(e.taskId);
      const entry = toolId ? this.entries.get(toolId) : undefined;
      if (entry) {
        if (e.phase === 'started' && entry.info.status === 'queued') {
          entry.info.status = 'running';
          entry.info.startedAt ??= e.ts;
        }
        const st = e.status?.toLowerCase();
        if (st && (e.phase === 'notification' || e.phase === 'updated')) {
          const mapped: SubagentStatus | undefined =
            st === 'completed' ? 'done' : st === 'failed' || st === 'error' ? 'error' : st === 'killed' || st === 'stopped' || st === 'cancelled' ? 'stopped' : undefined;
          if (mapped) this.finish(entry, mapped, e.ts);
        }
        if (e.summary && e.phase === 'notification') entry.info.report = e.summary;
        changed.add(entry);
      }
    }

    // The lead receives the subagent's tool_result.
    if (e.type === 'tool-result' && !e.parentToolUseId) {
      const entry = this.entries.get(e.toolUseId);
      if (entry) {
        if (ASYNC_LAUNCH.test(e.content)) {
          if (entry.info.status === 'queued') {
            entry.info.status = 'running';
            entry.info.startedAt ??= e.ts;
          }
        } else {
          entry.info.report = e.content;
          this.finish(entry, entry.stopRequested ? 'stopped' : e.isError ? 'error' : 'done', e.ts);
        }
        changed.add(entry);
      }
    }

    // Process exit: anything still running is over.
    if (e.type === 'exit') {
      for (const entry of this.entries.values()) {
        if (entry.info.status === 'running' || entry.info.status === 'queued' || entry.info.status === 'needs-permission') {
          this.finish(entry, 'stopped', e.ts);
          changed.add(entry);
        }
      }
    }

    return [...changed].map((x) => ({ ...x.info }));
  }

  private finish(entry: Entry, status: SubagentStatus, ts: number): void {
    if (entry.info.status === 'done' || entry.info.status === 'error' || entry.info.status === 'stopped') return;
    entry.info.status = status;
    entry.info.endedAt = ts;
  }

  /** Which subagent issued a tool call (for permission prompts). Undefined = the lead. */
  ownerOfToolUse(toolUseId: string | undefined): string | undefined {
    return toolUseId ? this.toolOwner.get(toolUseId) : undefined;
  }

  /** Mark a pending permission prompt on a subagent (or clear it). */
  setNeedsPermission(subagentId: string, pending: boolean): SubagentInfo | undefined {
    const entry = this.entries.get(subagentId);
    if (!entry) return undefined;
    if (pending && (entry.info.status === 'running' || entry.info.status === 'queued')) entry.info.status = 'needs-permission';
    else if (!pending && entry.info.status === 'needs-permission') entry.info.status = 'running';
    else return undefined;
    return { ...entry.info };
  }

  /** "Stop subagent": remembered so the supervisor denies its next tool call (open question 9). */
  requestStop(subagentId: string): boolean {
    const entry = this.entries.get(subagentId);
    if (!entry) return false;
    entry.stopRequested = true;
    return true;
  }
  isStopRequested(subagentId: string | undefined): boolean {
    return subagentId ? (this.entries.get(subagentId)?.stopRequested ?? false) : false;
  }

  get(id: string): SubagentInfo | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.info } : undefined;
  }
  list(): SubagentInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }
  transcript(id: string): AgentEvent[] {
    return [...(this.entries.get(id)?.transcript ?? [])];
  }

  /** Sum of all subagents' tokens. */
  usage(): TokenUsage {
    let u = { ...ZERO };
    for (const e of this.entries.values()) u = addUsage(u, e.info.usage ?? ZERO);
    return u;
  }

  /** "Subagents have used 38% of this agent's tokens": subagent tokens / (lead + subagents). */
  tokenShare(leadUsage: TokenUsage): number {
    const sub = totalTokens(this.usage());
    const all = sub + totalTokens(leadUsage);
    return all ? sub / all : 0;
  }

  counts(): { total: number; running: number; needsYou: number; done: number } {
    let running = 0;
    let needsYou = 0;
    let done = 0;
    for (const e of this.entries.values()) {
      if (e.info.status === 'running' || e.info.status === 'queued') running++;
      else if (e.info.status === 'needs-permission') needsYou++;
      else done++;
    }
    return { total: this.entries.size, running, needsYou, done };
  }
}
