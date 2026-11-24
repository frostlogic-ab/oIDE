/**
 * Pure helpers for the Wall (docs/wiki/pages/screen-wall.md). No React, no stores: easy to test.
 */
import type { AgentSummary, PermissionMode, PermissionRequest, SubagentInfo } from '@oide/protocol';
import { modelFamily } from '@oide/ui';
import { formatDuration } from '../../lib/format';
import { isNeedsYou, isRunning } from '../../stores/agents';
import type { WallFilter } from './wallState';

export function matchesFilter(a: AgentSummary, filter: WallFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs':
      return isNeedsYou(a);
    case 'running':
      return isRunning(a);
    case 'review':
      return a.status === 'ready-for-review';
  }
}

export interface FilterCounts {
  all: number;
  needs: number;
  running: number;
  review: number;
}

export function filterCounts(agents: AgentSummary[]): FilterCounts {
  const c: FilterCounts = { all: agents.length, needs: 0, running: 0, review: 0 };
  for (const a of agents) {
    if (isNeedsYou(a)) c.needs++;
    if (isRunning(a)) c.running++;
    if (a.status === 'ready-for-review') c.review++;
  }
  return c;
}

/** "shell-layout" from "oide/shell-layout"; "project folder" when the agent has no branch. */
export function branchLabel(a: Pick<AgentSummary, 'branch' | 'worktreePath'>): string {
  if (a.branch) return a.branch.split('/').filter(Boolean).pop() ?? a.branch;
  return 'project folder';
}

// ---------- subagents ----------

export interface SubagentCounts {
  total: number;
  running: number;
  needs: number;
  queued: number;
  done: number;
  failed: number;
  stopped: number;
}

export function subagentCounts(subs: SubagentInfo[]): SubagentCounts {
  const c: SubagentCounts = { total: subs.length, running: 0, needs: 0, queued: 0, done: 0, failed: 0, stopped: 0 };
  for (const s of subs) {
    if (s.status === 'running') c.running++;
    else if (s.status === 'needs-permission') c.needs++;
    else if (s.status === 'queued') c.queued++;
    else if (s.status === 'done') c.done++;
    else if (s.status === 'error') c.failed++;
    else c.stopped++;
  }
  return c;
}

/** Chip-row summary from the canvas: "2 of 3 running", "1 needs you", "1 running, 1 queued", "3 done". */
export function subagentSummary(subs: SubagentInfo[]): string {
  const c = subagentCounts(subs);
  if (!c.total) return 'No subagents';
  if (c.needs) return `${c.needs} ${c.needs === 1 ? 'needs' : 'need'} you`;
  if (c.running) return c.queued ? `${c.running} running, ${c.queued} queued` : c.running === c.total ? `${c.running} running` : `${c.running} of ${c.total} running`;
  if (c.queued) return `${c.queued} queued`;
  const parts: string[] = [];
  if (c.done) parts.push(`${c.done} done`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.stopped) parts.push(`${c.stopped} stopped`);
  return parts.join(', ');
}

const STATUS_WORD: Record<SubagentInfo['status'], string> = {
  queued: 'queued',
  running: 'running',
  'needs-permission': 'needs permission',
  done: 'done',
  error: 'failed',
  stopped: 'stopped',
};

/** Lower-case first letter: "Run npm install" → "run npm install". */
function lc(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * Chip tooltip / accessible text, as on the canvas:
 * "Haiku, low effort · routed as simple · done · 2m",
 * "Sonnet, medium effort · routed as standard · needs permission · asking to run npm install".
 */
export function subagentDetail(s: SubagentInfo, pending: PermissionRequest | undefined, now: number): string {
  const parts: string[] = [`${modelFamily(s.model)}${s.effort ? `, ${s.effort} effort` : ''}`];
  if (s.tier && s.tier !== 'custom') parts.push(`routed as ${s.tier}`);
  parts.push(STATUS_WORD[s.status]);
  if (s.status === 'needs-permission' && pending && pending.subagentId === s.id) parts.push(`asking to ${lc(pending.summary)}`);
  else if (s.report) parts.push(s.report);
  else if (s.startedAt && s.status !== 'queued') parts.push(formatDuration((s.endedAt ?? now) - s.startedAt));
  return parts.join(' · ');
}

// ---------- activity lines ----------

export type ActivityLine =
  | { kind: 'step'; text: string; active: boolean; additions?: number; deletions?: number }
  | { kind: 'result'; text: string }
  | { kind: 'sub'; subagent: string; text: string; active: boolean };

const DIFF_TAIL = /\s\+(\d+)\s[−-](\d+)$/;

/**
 * Activity strings from the reducer ("Edit src/x.ts +38 −12", "⎿ 0 errors", "Writing x…",
 * "↳ Grid tests · Write x") → how the tile draws them (● done, ◐ in progress, ⎿ result, ↳ subagent).
 */
export function parseActivity(lines: string[], subagents: SubagentInfo[], live: boolean): ActivityLine[] {
  return lines.map((raw, i) => {
    const line = raw.trim();
    const last = i === lines.length - 1;
    if (line.startsWith('⎿')) return { kind: 'result', text: line.replace(/^⎿\s*/, '') };
    if (line.startsWith('↳')) {
      const body = line.replace(/^↳\s*/, '');
      const sep = body.indexOf(' · ');
      const name = sep >= 0 ? body.slice(0, sep) : body;
      const text = sep >= 0 ? body.slice(sep + 3) : '';
      const sub = subagents.find((s) => s.name === name);
      const active = text.endsWith('…') || sub?.status === 'running' || (!sub && live && last);
      return { kind: 'sub', subagent: name, text, active };
    }
    const m = DIFF_TAIL.exec(line);
    const active = line.endsWith('…') || line === 'Thinking' || (live && last && /^(Thinking|Writing)\b/.test(line));
    if (m) return { kind: 'step', text: line.slice(0, m.index), active, additions: Number(m[1]), deletions: Number(m[2]) };
    return { kind: 'step', text: line, active };
  });
}

// ---------- permission prompt ----------

export interface PermissionView {
  /** Subagent name when the prompt came from one. */
  subagent?: string;
  /** "wants to run:", "wants to edit:", … */
  verb: string;
  /** The command, path or URL (mono, amber). */
  target: string;
  /** Why, when the tool input carries a description. */
  note?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function permissionView(req: PermissionRequest, subagents: SubagentInfo[]): PermissionView {
  const input = (req.input && typeof req.input === 'object' ? req.input : {}) as Record<string, unknown>;
  const sub = req.subagentId ? subagents.find((s) => s.id === req.subagentId) : undefined;
  const note = str(input.description);
  const tool = req.toolName.replace(/^mcp__([^_]+)__/, '$1: ');
  let verb = `wants to use ${tool}:`;
  let target = req.summary;
  if (req.toolName === 'Bash' && str(input.command)) {
    verb = 'wants to run:';
    target = str(input.command)!;
  } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(req.toolName) && (str(input.file_path) ?? str(input.notebook_path))) {
    verb = 'wants to edit:';
    target = (str(input.file_path) ?? str(input.notebook_path))!;
  } else if (req.toolName === 'WebFetch' && str(input.url)) {
    verb = 'wants to fetch:';
    target = str(input.url)!;
  }
  return { subagent: sub?.name, verb, target, note: note && note !== target ? note : undefined };
}

// ---------- mode badge ----------

/** Same words as Spawn and Settings (MODE_OPTIONS), so a badge names the mode the user picked. */
const MODE_BADGE: Record<PermissionMode, string> = {
  default: 'Manual',
  acceptEdits: 'Edit automatically',
  plan: 'Plan mode',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
};

const MODE_TITLE: Record<PermissionMode, string> = {
  default: 'Permission mode: Manual (asks before every edit)',
  acceptEdits: 'Permission mode: Edit automatically (edits files without asking)',
  plan: 'Permission mode: Plan (explores, then presents a plan first)',
  auto: 'Permission mode: Auto (approves safe actions, pauses on risky ones)',
  bypassPermissions: 'Permission mode: Bypass permissions (never asks)',
};

export interface ModeBadge {
  label: string;
  /** Tooltip / accessible description. */
  title: string;
  warn: boolean;
}

/** Badge for a tile whose mode differs from Settings › default mode. Bypass always shows (warning). */
export function modeBadge(mode: PermissionMode, defaultMode: PermissionMode): ModeBadge | null {
  if (mode === 'bypassPermissions') return { label: MODE_BADGE[mode], title: MODE_TITLE[mode], warn: true };
  if (mode === defaultMode) return null;
  return { label: MODE_BADGE[mode], title: MODE_TITLE[mode], warn: false };
}

// ---------- tile body ----------

export type TileBodyKind = 'permission' | 'interrupted' | 'question' | 'review' | 'queued' | 'rate-limited' | 'error' | 'activity';

/** Statuses in which an agent waits for the user (nothing is running on its own). */
const IDLE_FOR_USER = new Set<AgentSummary['status']>(['has-question', 'stopped', 'paused', 'done']);

export function tileBodyKind(a: AgentSummary): TileBodyKind {
  if (a.status === 'needs-permission' && a.pendingPermission) return 'permission';
  // A prompt was still open when oIDE quit (it was denied then): say so until the user replies.
  if (a.interruptedPermission && IDLE_FOR_USER.has(a.status)) return 'interrupted';
  if (a.status === 'has-question') return 'question';
  if (a.status === 'ready-for-review') return 'review';
  if (a.status === 'queued') return 'queued';
  if (a.status === 'rate-limited') return 'rate-limited';
  if (a.status === 'error') return 'error';
  return 'activity';
}

/** Text after the status label: "Running · 14m", "Paused by plan limit". */
export function statusDetail(a: AgentSummary, now: number): string | undefined {
  if (a.status === 'running' || a.status === 'starting') return formatDuration(now - a.createdAt);
  return undefined;
}

/** Status words for the per-tile aria-live region. */
export function statusAnnouncement(a: AgentSummary, label: string): string {
  return `${a.title}: ${label}`;
}
