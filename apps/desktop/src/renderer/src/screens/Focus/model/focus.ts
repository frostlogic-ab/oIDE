/**
 * Pure helpers for the Focus screen: agent list order, mode cycling, composer messages, permission
 * copy, subagent timing, token share and timeline geometry. Tested in focus.test.ts.
 */
import type { AgentSummary, MessageAttachment, PermissionMode, PermissionRequest, SubagentInfo, TokenUsage, UserMessage } from '@oide/protocol';
import { modelFamily } from '@oide/ui';
import { attachmentOnlyText } from '../../../lib/attachments';
import { formatDuration } from '../../../lib/format';
import { clip, toolPath } from './transcript';

// ---------- agent list ----------

/** Needs permission first, then the other needs-you states, review, running, the rest. */
export function agentRank(a: AgentSummary): number {
  switch (a.status) {
    case 'needs-permission':
      return 0;
    case 'has-question':
    case 'error':
    case 'rate-limited':
      return 1;
    case 'ready-for-review':
      return 2;
    case 'running':
    case 'starting':
      return 3;
    default:
      return 4;
  }
}

/** Order of the "Agents" list; J / K walk it. Stable within a rank (creation order). */
export function sortAgentList(agents: readonly AgentSummary[]): AgentSummary[] {
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => agentRank(x.a) - agentRank(y.a) || x.i - y.i)
    .map((x) => x.a);
}

const activeSub = (s: SubagentInfo) => s.status === 'running' || s.status === 'needs-permission' || s.status === 'queued';

/** Second line of an agent card in the list. */
export function agentListLine(a: AgentSummary): { text: string; tone: 'warn' | 'dim'; mono: boolean } {
  switch (a.status) {
    case 'needs-permission':
      return { text: 'Needs permission', tone: 'warn', mono: false };
    case 'has-question':
      return { text: 'Has a question', tone: 'warn', mono: false };
    case 'rate-limited':
      return { text: 'Paused by plan limit', tone: 'warn', mono: false };
    case 'error':
      return { text: a.error ? clip(`Error · ${a.error}`, 40) : 'Error', tone: 'warn', mono: false };
    case 'ready-for-review': {
      const done = a.subagents.filter((s) => s.status === 'done').length;
      return { text: `Ready for review${done ? ` · ${done} ${done === 1 ? 'subagent' : 'subagents'} done` : ''}`, tone: 'dim', mono: false };
    }
    case 'queued':
      return { text: 'Queued', tone: 'dim', mono: false };
    case 'paused':
      return { text: 'Paused', tone: 'dim', mono: false };
    case 'stopped':
      return { text: 'Stopped', tone: 'dim', mono: false };
    default: {
      const last = [...a.activity].reverse().find((l) => !l.startsWith('⎿') && !l.startsWith('↳')) ?? 'Working…';
      const subs = a.subagents.filter(activeSub).length;
      return { text: `${clip(last.replace(/…$/, ''), 30)}${subs ? ` · ${subs} sub` : ''}`, tone: 'dim', mono: true };
    }
  }
}

// ---------- mode (header menu, Shift+Tab) ----------

export const MODE_CYCLE: readonly PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan'];

export interface ModeOptions {
  allowBypass?: boolean;
  inWorktree?: boolean;
  hasAuto?: boolean;
}

export interface ModeChoice {
  mode: PermissionMode;
  /** Set when the mode cannot be picked for this agent; the short form shows in the menu. */
  disabled?: { hint: string; reason: string };
}

/**
 * Every mode an agent can switch to while it runs, in Shift+Tab order. Bypass is listed but
 * disabled (with the reason) unless Settings allow it and the agent works in a worktree.
 */
export function modeChoices(opts: ModeOptions = {}): ModeChoice[] {
  const out: ModeChoice[] = MODE_CYCLE.filter((m) => m !== 'auto' || opts.hasAuto !== false).map((mode) => ({ mode }));
  if (!opts.allowBypass) out.push({ mode: 'bypassPermissions', disabled: { hint: 'Off in Settings', reason: 'Turn on Settings › Claude Code › Allow Bypass permissions to use Bypass mode.' } });
  else if (!opts.inWorktree) out.push({ mode: 'bypassPermissions', disabled: { hint: 'Worktree only', reason: 'Bypass mode runs only in a worktree, never in the project folder.' } });
  else out.push({ mode: 'bypassPermissions' });
  return out;
}

/** Next mode for Shift+Tab. Bypass joins the cycle only when Settings allow it and the agent is in a worktree. */
export function nextMode(current: PermissionMode, opts: ModeOptions = {}): PermissionMode {
  const cycle = modeChoices(opts)
    .filter((c) => !c.disabled)
    .map((c) => c.mode);
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length]!;
}

export const MODE_LABEL: Record<PermissionMode, string> = {
  auto: 'Auto mode',
  default: 'Manual mode',
  acceptEdits: 'Edit automatically',
  plan: 'Plan mode',
  bypassPermissions: 'Bypass mode',
};

// ---------- composer ----------

/** Verified on CLI 2.1.325 (`slash_commands` in init); used until the agent's own init reports its list. */
export const DEFAULT_SLASH_COMMANDS = ['compact', 'context', 'init'] as const;

// The `/` menu's grouping, labels, descriptions and filter: lib/slash.ts (shared SlashMenu).

export type ComposerIntent = { kind: 'send'; message: UserMessage } | { kind: 'compact' } | { kind: 'none' };

/**
 * What the composer sends. `/compact` opens the confirm dialog (never sent directly); other `/x`
 * become command messages; an attached artifact becomes an artifact message with the text as note.
 * Pasted, dropped or picked attachments ride on the text (or artifact) message; a message with
 * attachments is never a command. Messages typed while viewing a subagent go to the lead, prefixed
 * with which subagent they concern.
 */
export function composeMessage(input: { text: string; artifactId?: string; subagentName?: string; commands?: readonly string[]; attachments?: readonly MessageAttachment[] }): ComposerIntent {
  const text = input.text.trim();
  const about = (t: string) => (input.subagentName ? `About the subagent "${input.subagentName}": ${t}` : t);
  const atts = input.attachments?.length ? { attachments: [...input.attachments] } : {};
  if (input.artifactId) return { kind: 'send', message: { kind: 'artifact', artifactId: input.artifactId, ...(text ? { note: about(text) } : {}), ...atts } };
  if (input.attachments?.length) return { kind: 'send', message: { kind: 'text', text: about(text || attachmentOnlyText(input.attachments)), ...atts } };
  if (!text) return { kind: 'none' };
  const m = /^\/([a-z][\w:-]*)(\s|$)/i.exec(text);
  // Only the CLI's known commands are commands; "/usr/bin is missing" stays a message.
  if (m && (input.commands ?? DEFAULT_SLASH_COMMANDS).some((c) => c.toLowerCase() === m[1]!.toLowerCase())) {
    if (m[1]!.toLowerCase() === 'compact') return { kind: 'compact' };
    return { kind: 'send', message: { kind: 'command', command: text } };
  }
  return { kind: 'send', message: { kind: 'text', text: about(text) } };
}

// ---------- permission prompt ----------

export function permissionCopy(req: PermissionRequest): { verb: string; detail: string } {
  const input = req.input;
  const cmd = input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined;
  const url = input && typeof input === 'object' ? (input as Record<string, unknown>).url : undefined;
  switch (req.toolName) {
    case 'Bash':
    case 'PowerShell':
      return { verb: 'wants to run a command', detail: typeof cmd === 'string' ? cmd : req.summary };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'wants to edit a file', detail: toolPath(input) ?? req.summary };
    case 'Write':
      return { verb: 'wants to write a file', detail: toolPath(input) ?? req.summary };
    case 'WebFetch':
      return { verb: 'wants to fetch a page', detail: typeof url === 'string' ? url : req.summary };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(req.toolName);
      return { verb: m ? `wants to use ${m[1]}: ${m[2]}` : `wants to use ${req.toolName}`, detail: req.summary };
    }
  }
}

// ---------- subagents ----------

export function tokenTotal(u: TokenUsage | undefined): number {
  return u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
}

/** Display tokens (input + output, as the CLI's own counters do). */
export function tokenCount(u: TokenUsage | undefined): number {
  return u ? u.input + u.output : 0;
}

/** Share (0–1) of the agent's tokens used by its subagents. `agent.usage` includes subagent usage. */
export function subagentTokenShare(agent: Pick<AgentSummary, 'usage' | 'subagents'>): number {
  const total = tokenTotal(agent.usage);
  if (!total) return 0;
  const subs = agent.subagents.reduce((n, s) => n + tokenTotal(s.usage), 0);
  return Math.min(1, subs / total);
}

/** "Done in 2m", "Running 5m", "Needs permission · 8m", "Queued". */
export function subagentStatusText(s: SubagentInfo, now = Date.now()): string {
  const since = s.startedAt ? formatDuration((s.endedAt ?? now) - s.startedAt) : '';
  switch (s.status) {
    case 'done':
      return since ? `Done in ${since}` : 'Done';
    case 'running':
      return since ? `Running ${since}` : 'Running';
    case 'needs-permission':
      return since ? `Needs permission · ${since}` : 'Needs permission';
    case 'error':
      return since ? `Failed after ${since}` : 'Failed';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Queued';
  }
}

export const isSubagentActive = activeSub;

const TIER_LABEL: Record<string, string> = { simple: 'simple', standard: 'standard', complex: 'complex', custom: 'custom' };
export const routeLabel = (s: SubagentInfo): string => (s.tier ? TIER_LABEL[s.tier]! : (s.subagentType ?? 'custom'));

/** "Sonnet · medium" chip and "Sonnet, medium effort" line. */
export function modelEffort(s: SubagentInfo, sep: ' · ' | ', ' = ' · '): string {
  const fam = modelFamily(s.model);
  if (!s.effort) return fam;
  return sep === ', ' ? `${fam}, ${s.effort} effort` : `${fam} · ${s.effort}`;
}

/** "3 subagents · 1 needs you · 1 running · 1 done" parts. */
export function subagentSummary(subs: readonly SubagentInfo[]): { total: string; parts: Array<{ text: string; warn?: boolean }> } {
  const count = (st: string) => subs.filter((s) => s.status === st).length;
  const parts: Array<{ text: string; warn?: boolean }> = [];
  const need = count('needs-permission');
  if (need) parts.push({ text: `${need} needs you`, warn: true });
  for (const [st, label] of [['running', 'running'], ['queued', 'queued'], ['done', 'done'], ['error', 'failed'], ['stopped', 'stopped']] as const) {
    const n = count(st);
    if (n) parts.push({ text: `${n} ${label}` });
  }
  return { total: `${subs.length} ${subs.length === 1 ? 'subagent' : 'subagents'}`, parts };
}

/** "Opus leads and routes each task. Simple goes to Haiku, standard to Sonnet." from the tiers seen. */
export function routingLine(leadModel: string, subs: readonly SubagentInfo[]): string {
  const tiers = new Map<string, string>();
  for (const s of subs) if (s.tier && s.tier !== 'custom' && !tiers.has(s.tier)) tiers.set(s.tier, modelFamily(s.model));
  const lead = modelFamily(leadModel);
  if (!tiers.size) return `${lead} leads. Subagents use the model their task asks for.`;
  const order = ['simple', 'standard', 'complex'].filter((t) => tiers.has(t));
  const parts = order.map((t, i) => (i === 0 ? `${t[0]!.toUpperCase()}${t.slice(1)} goes to ${tiers.get(t)}` : `${t} to ${tiers.get(t)}`));
  return `${lead} leads and routes each task. ${parts.join(', ')}.`;
}

export interface TimelineBar {
  id: string;
  left: number;
  width: number;
}

/** Bars (percent of the agent's run so far) for the Subagents tab timeline. */
export function timeline(agentStart: number, subs: readonly SubagentInfo[], now = Date.now()): { bars: TimelineBar[]; spanMs: number } {
  const span = Math.max(1, now - agentStart);
  const bars = subs.map((s) => {
    const start = s.startedAt ?? now;
    const end = s.endedAt ?? now;
    const left = Math.min(100, Math.max(0, ((start - agentStart) / span) * 100));
    const width = Math.max(1.5, Math.min(100 - left, ((end - start) / span) * 100));
    return { id: s.id, left: Math.round(left * 10) / 10, width: Math.round(width * 10) / 10 };
  });
  return { bars, spanMs: span };
}

/** Header meta "running 19m" / "needs permission · 19m" / "paused". */
export function runningText(a: AgentSummary, now = Date.now()): string {
  const d = formatDuration(now - a.createdAt);
  if (a.status === 'running' || a.status === 'starting' || a.status === 'needs-permission') return `running ${d}`;
  return `${a.status.replace(/-/g, ' ')} · ${d}`;
}
