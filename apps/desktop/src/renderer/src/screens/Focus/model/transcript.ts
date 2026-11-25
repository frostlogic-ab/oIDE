/**
 * Pure event → transcript-row mapping for the Focus screen. No React here, so it is cheap to test
 * and can run on every batch: one O(n) pass over the agent's events.
 *
 * - Lead transcript = events without `parentToolUseId`; a subagent's transcript = events tagged with
 *   its Task/Agent tool_use id (open question 8: the CLI tags them with --forward-subagent-text).
 * - Consecutive tool calls share one card ("tools" row); results attach to their call by id.
 *   Adjacent Read calls collapse into one "Read N files" line, as on the canvas.
 * - The lead's Agent/Task calls become subagent cards; their tool_result (the report) is absorbed.
 * - Every row carries `v`, the seq of the newest event that changed it, so memoized row
 *   components re-render only when their own content changed.
 */
import type { AgentEvent, CheckResult, MessageAttachment } from '@oide/protocol';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  seq: number;
  result?: { content: string; isError: boolean; seq: number };
}

/** One visible line in a tool card: one call, or several adjacent Reads merged. */
export interface ToolLine {
  key: string;
  calls: ToolCall[];
}

interface RowBase {
  key: string;
  /** Seq of the first event in the row. */
  seq: number;
  /** Seq of the newest event that changed the row (memo key). */
  v: number;
}

export type TranscriptRow =
  | (RowBase & { kind: 'user'; text: string; attachments?: MessageAttachment[] })
  | (RowBase & { kind: 'assistant'; text: string })
  | (RowBase & { kind: 'thinking'; text: string })
  | (RowBase & { kind: 'tools'; lines: ToolLine[] })
  | (RowBase & {
      kind: 'subagent';
      toolUseId: string;
      description: string;
      prompt: string;
      subagentType?: string;
      report?: { content: string; isError: boolean };
    })
  | (RowBase & { kind: 'notice'; tone: 'info' | 'ok' | 'warn' | 'bad'; text: string })
  | (RowBase & { kind: 'result'; isError: boolean; subtype: string; durationMs?: number; numTurns?: number; text?: string; localCommand?: string })
  | (RowBase & { kind: 'error'; message: string; code?: string })
  | (RowBase & { kind: 'rate-limit'; message: string; resetAt?: number })
  | (RowBase & { kind: 'review'; summary: string; checks: CheckResult[] });

export type TranscriptRowKind = TranscriptRow['kind'];

export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** Events of the lead (no parent) or of one subagent (tagged with its tool_use id). */
export function eventsFor(events: readonly AgentEvent[], parentToolUseId?: string): AgentEvent[] {
  return parentToolUseId === undefined
    ? events.filter((e) => e.parentToolUseId === undefined)
    : events.filter((e) => e.parentToolUseId === parentToolUseId);
}

/** All subagent-tagged events, grouped by parent tool_use id (one pass). */
export function groupByParent(events: readonly AgentEvent[]): Map<string, AgentEvent[]> {
  const out = new Map<string, AgentEvent[]>();
  for (const e of events) {
    if (e.parentToolUseId === undefined) continue;
    let list = out.get(e.parentToolUseId);
    if (!list) out.set(e.parentToolUseId, (list = []));
    list.push(e);
  }
  return out;
}

const str = (input: unknown, ...keys: string[]): string | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
};

export const toolPath = (input: unknown): string | undefined => str(input, 'file_path', 'notebook_path', 'path');

export function clip(s: string, n = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Canvas-style label for a tool call: "Read src/x.ts", "Bash npm test", "Edit …". */
export function toolLabel(name: string, input: unknown): string {
  const path = toolPath(input);
  switch (name) {
    case 'Read':
      return `Read ${path ?? 'file'}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edit ${path ?? 'file'}`;
    case 'Write':
      return `Write ${path ?? 'file'}`;
    case 'Bash':
    case 'PowerShell':
      return clip(`${name} ${str(input, 'command', 'description') ?? ''}`);
    case 'Grep':
      return clip(`Grep ${str(input, 'pattern') ?? ''}${str(input, 'path') ? ` in ${str(input, 'path')}` : ''}`);
    case 'Glob':
      return clip(`Glob ${str(input, 'pattern') ?? ''}`);
    case 'WebFetch':
      return clip(`Fetch ${str(input, 'url') ?? ''}`);
    case 'WebSearch':
      return clip(`Search the web for ${str(input, 'query') ?? ''}`);
    case 'TodoWrite':
      return 'Update plan';
    case 'ExitPlanMode':
      return 'Plan ready';
    case 'ToolSearch':
      return 'Load tools';
    case 'Task':
    case 'Agent':
      return clip(`Delegate ${str(input, 'description', 'subagent_type') ?? 'a task'}`);
    case 'mcp__oide__submit_for_review':
      return 'Submit for review';
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      return m ? clip(`${m[1]}: ${m[2]!.replace(/_/g, ' ')}`) : clip(name);
    }
  }
}

export type DiffLine = { t: '+' | '-' | ' '; s: string };

const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/** Line diff (LCS) of two short strings; large inputs fall back to "all removed, all added". */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > 250_000) return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', s: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: '-', s: a[i++]! });
    else out.push({ t: '+', s: b[j++]! });
  }
  while (i < n) out.push({ t: '-', s: a[i++]! });
  while (j < m) out.push({ t: '+', s: b[j++]! });
  return out;
}

/** Inline diff for Edit / MultiEdit / Write inputs, or null for other tools. */
export function toolDiff(name: string, input: unknown): DiffLine[] | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  if (name === 'Write' && typeof i.content === 'string') return splitLines(i.content).map((s) => ({ t: '+', s }));
  if (name === 'Edit' && typeof i.new_string === 'string') return lineDiff(typeof i.old_string === 'string' ? i.old_string : '', i.new_string);
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    return i.edits.flatMap((e: unknown) => {
      const ed = (e ?? {}) as Record<string, unknown>;
      return lineDiff(typeof ed.old_string === 'string' ? ed.old_string : '', typeof ed.new_string === 'string' ? ed.new_string : '');
    });
  }
  return null;
}

export function diffCounts(lines: readonly DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.t === '+') additions++;
    else if (l.t === '-') deletions++;
  }
  return { additions, deletions };
}

const firstLine = (s: string): string => clip(s.split('\n').find((l) => l.trim()) ?? '', 60);

/** Right-hand meta for a tool line: "+86 −4", "0 errors", "package.json, src/main/…". */
export function toolMeta(line: ToolLine): { text: string; tone: 'dim' | 'ok' | 'bad' | 'running' | 'diff'; additions?: number; deletions?: number } {
  const calls = line.calls;
  const first = calls[0]!;
  if (calls.length > 1) {
    const paths = calls.map((c) => toolPath(c.input)).filter((p): p is string => !!p);
    return { text: clip(paths.join(', '), 28), tone: 'dim' };
  }
  if (first.result?.isError) return { text: firstLine(first.result.content) || 'error', tone: 'bad' };
  const diff = toolDiff(first.name, first.input);
  if (diff) return { text: '', tone: 'diff', ...diffCounts(diff) };
  if (!first.result) return { text: 'running…', tone: 'running' };
  if (first.name === 'Read' || first.name === 'TodoWrite') return { text: '', tone: 'dim' };
  return { text: firstLine(first.result.content), tone: 'dim' };
}

/** Title of a tool line; merged Reads read "Read 4 files". */
export function toolLineLabel(line: ToolLine): string {
  if (line.calls.length > 1) return `Read ${line.calls.length} files`;
  const c = line.calls[0]!;
  return toolLabel(c.name, c.input);
}

const INVISIBLE: ReadonlySet<AgentEvent['type']> = new Set([
  'init',
  'usage',
  'status',
  'partial',
  'permission-request',
  'permission-resolved',
  'todos',
  'subagent',
  'subagent-task',
  'background-tasks',
  'plan-usage',
  'stderr',
  'unknown',
  'tool-result',
]);

/** CLI-replayed user lines: a notice (interrupt, local command output), hidden, or a real message. */
function classifyUserText(text: string): { notice: string } | 'hide' | 'user' {
  const t = text.trim();
  if (t.startsWith('[Request interrupted')) return { notice: 'Interrupted by you' };
  const m = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(t);
  if (m) return { notice: clip(m[1]!.trim() || 'Command finished', 160) };
  if (t.startsWith('<command-name>') || t.startsWith('<local-command')) return 'hide';
  return 'user';
}

/**
 * Build transcript rows from one transcript's events (already filtered with `eventsFor`).
 */
export function buildRows(events: readonly AgentEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const calls = new Map<string, { call: ToolCall; row: TranscriptRow }>();
  const subRows = new Map<string, Extract<TranscriptRow, { kind: 'subagent' }>>();
  let open: Extract<TranscriptRow, { kind: 'tools' }> | null = null;

  const push = (row: TranscriptRow) => {
    open = null;
    rows.push(row);
  };

  for (const e of events) {
    if (e.type === 'tool-result') {
      const sub = subRows.get(e.toolUseId);
      if (sub) {
        sub.report = { content: e.content, isError: e.isError };
        sub.v = e.seq;
        continue;
      }
      const hit = calls.get(e.toolUseId);
      if (hit) {
        hit.call.result = { content: e.content, isError: e.isError, seq: e.seq };
        hit.row.v = e.seq;
      }
      continue;
    }
    if (e.type === 'tool-use') {
      if (SUBAGENT_TOOLS.has(e.name)) {
        const row: Extract<TranscriptRow, { kind: 'subagent' }> = {
          kind: 'subagent',
          key: `sub:${e.toolUseId}`,
          seq: e.seq,
          v: e.seq,
          toolUseId: e.toolUseId,
          description: str(e.input, 'description') ?? 'Subagent',
          prompt: str(e.input, 'prompt') ?? '',
          subagentType: str(e.input, 'subagent_type'),
        };
        subRows.set(e.toolUseId, row);
        push(row);
        continue;
      }
      const call: ToolCall = { id: e.toolUseId, name: e.name, input: e.input, seq: e.seq };
      if (!open) {
        open = { kind: 'tools', key: `tools:${e.seq}`, seq: e.seq, v: e.seq, lines: [] };
        rows.push(open);
      }
      const current: Extract<TranscriptRow, { kind: 'tools' }> = open;
      const last = current.lines[current.lines.length - 1];
      if (e.name === 'Read' && last && last.calls[0]!.name === 'Read') last.calls.push(call);
      else current.lines.push({ key: `t:${e.toolUseId}`, calls: [call] });
      current.v = e.seq;
      calls.set(e.toolUseId, { call, row: current });
      continue;
    }
    if (INVISIBLE.has(e.type)) continue;

    const base = { key: `e:${e.seq}`, seq: e.seq, v: e.seq };
    switch (e.type) {
      case 'user-text': {
        const c = classifyUserText(e.text);
        if (c === 'hide') break;
        if (c === 'user') push({ ...base, kind: 'user', text: e.text, ...(e.attachments?.length ? { attachments: e.attachments } : {}) });
        else push({ ...base, kind: 'notice', tone: 'info', text: c.notice });
        break;
      }
      case 'assistant-text':
        if (e.text.trim()) push({ ...base, kind: 'assistant', text: e.text });
        break;
      case 'thinking': {
        // Consecutive thinking blocks of one message read as one collapsed row.
        const prev = rows[rows.length - 1];
        if (prev?.kind === 'thinking') {
          prev.text = prev.text && e.text ? `${prev.text}\n\n${e.text}` : prev.text || e.text;
          prev.v = e.seq;
        } else push({ ...base, kind: 'thinking', text: e.text });
        break;
      }
      case 'result':
        push({
          ...base,
          kind: 'result',
          isError: e.isError,
          subtype: e.subtype,
          durationMs: e.durationMs,
          numTurns: e.numTurns,
          text: e.text,
          localCommand: e.localCommand,
        });
        break;
      case 'error':
        push({ ...base, kind: 'error', message: e.message, code: e.code });
        break;
      case 'rate-limit':
        push({ ...base, kind: 'rate-limit', message: e.message, resetAt: e.resetAt });
        break;
      case 'compact':
        push({
          ...base,
          kind: 'notice',
          tone: e.phase === 'failed' ? 'bad' : 'info',
          text:
            e.phase === 'started'
              ? 'Compacting the conversation…'
              : e.phase === 'done'
                ? `Compacted${e.preTokens && e.postTokens ? ` · ${Math.round(e.preTokens / 1000)}k → ${Math.round(e.postTokens / 1000)}k tokens` : ''}`
                : 'Compacting failed',
        });
        break;
      case 'mode-changed':
        push({ ...base, kind: 'notice', tone: 'info', text: `Mode changed to ${modeName(e.mode)}` });
        break;
      case 'review-submitted':
        push({ ...base, kind: 'review', summary: e.review.summary, checks: e.review.checks });
        break;
      case 'exit':
        if (e.code !== 0 || e.signal) push({ ...base, kind: 'notice', tone: 'bad', text: `The CLI process exited${e.code !== null ? ` with code ${e.code}` : ''}${e.signal ? ` (${e.signal})` : ''}` });
        break;
      default:
        break;
    }
  }
  return rows;
}

const MODE_NAMES: Record<string, string> = {
  default: 'Manual',
  manual: 'Manual',
  acceptEdits: 'Edit automatically',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't ask",
};
export const modeName = (mode: string): string => MODE_NAMES[mode] ?? mode;

// ---------- subagent steps (card rows and the collapsed "latest" line) ----------

export type StepState = 'done' | 'run' | 'need' | 'error';
export interface SubagentStep {
  key: string;
  state: StepState;
  text: string;
  meta: string;
}

/**
 * Steps of one subagent from its tagged events: one per tool call, a trailing "working" line
 * from its latest text while it runs, and its report once done.
 */
export function subagentSteps(
  events: readonly AgentEvent[],
  opts: { status?: string; report?: string; pendingToolUseId?: string } = {},
): SubagentStep[] {
  const steps: SubagentStep[] = [];
  const byId = new Map<string, SubagentStep>();
  let trailing: string | null = null;
  for (const e of events) {
    if (e.type === 'tool-use') {
      trailing = null;
      const diff = toolDiff(e.name, e.input);
      const counts = diff ? diffCounts(diff) : null;
      const step: SubagentStep = {
        key: e.toolUseId,
        state: 'run',
        text: toolLabel(e.name, e.input),
        meta: counts ? [counts.additions ? `+${counts.additions}` : '', counts.deletions ? `−${counts.deletions}` : ''].filter(Boolean).join(' ') : '',
      };
      steps.push(step);
      byId.set(e.toolUseId, step);
    } else if (e.type === 'tool-result') {
      const step = byId.get(e.toolUseId);
      if (step) {
        step.state = e.isError ? 'error' : 'done';
        if (!step.meta && !step.text.startsWith('Read ')) step.meta = firstLine(e.content);
      }
    } else if (e.type === 'assistant-text' && e.text.trim()) {
      trailing = e.text;
    }
  }
  const active = opts.status === 'running' || opts.status === 'needs-permission' || opts.status === undefined;
  if (opts.pendingToolUseId) {
    const s = byId.get(opts.pendingToolUseId);
    if (s) {
      s.state = 'need';
      s.meta = 'waiting for you';
    }
  } else if (opts.status === 'needs-permission') {
    const last = [...steps].reverse().find((s) => s.state === 'run');
    if (last) {
      last.state = 'need';
      last.meta = 'waiting for you';
    }
  }
  if (!active) for (const s of steps) if (s.state === 'run') s.state = 'done';
  if (active && trailing && opts.status === 'running') steps.push({ key: 'trailing', state: 'run', text: clip(trailing, 90), meta: '' });
  if (opts.status === 'done' && opts.report) steps.push({ key: 'report', state: 'done', text: clip(opts.report.split('\n')[0] ?? opts.report, 90), meta: '' });
  return steps;
}

/** Files a subagent touched, for "read 6 files" / "package.json" / "2 files". */
export function subagentFiles(events: readonly AgentEvent[]): string {
  const written = new Set<string>();
  const read = new Set<string>();
  for (const e of events) {
    if (e.type !== 'tool-use') continue;
    const p = toolPath(e.input);
    if (!p) continue;
    if (e.name === 'Read') read.add(p);
    else if (e.name === 'Edit' || e.name === 'Write' || e.name === 'MultiEdit' || e.name === 'NotebookEdit') written.add(p);
  }
  if (written.size === 1) return [...written][0]!.split(/[\\/]/).pop()!;
  if (written.size > 1) return `${written.size} files`;
  if (read.size) return `read ${read.size} ${read.size === 1 ? 'file' : 'files'}`;
  return 'no files yet';
}

/** Slash commands the CLI reported in its latest init (`slash_commands`), if any. */
export function reportedSlashCommands(events: readonly AgentEvent[]): string[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'init' && e.parentToolUseId === undefined && e.slashCommands?.length) return e.slashCommands;
  }
  return undefined;
}
