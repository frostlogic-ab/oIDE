import type { AgentStatus, SubagentStatus } from '@oide/protocol';

/** CSS colour expressions for status colours (work in SVG and inline styles; follow the accent). */
export const C = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-bad)',
  review: 'var(--color-review)',
  accent: 'var(--color-accent)',
  /** ink-4: decorative only (dots, rules). Never for small text: 3.8:1 on a card. */
  muted: 'var(--color-ink-4)',
  dim: 'var(--color-ink-3)',
} as const;

export type StatusTone = 'default' | 'needs' | 'review' | 'error' | 'muted';

export interface StatusMeta {
  label: string;
  color: string;
  /** Card treatment on the Wall: needs = amber card, review = blue card, error = red card. */
  tone: StatusTone;
}

export const AGENT_STATUS_META: Record<AgentStatus, StatusMeta> = {
  queued: { label: 'Queued', color: C.dim, tone: 'muted' },
  starting: { label: 'Starting', color: C.accent, tone: 'default' },
  running: { label: 'Running', color: C.ok, tone: 'default' },
  'needs-permission': { label: 'Needs permission', color: C.warn, tone: 'needs' },
  'has-question': { label: 'Has a question', color: C.warn, tone: 'needs' },
  'ready-for-review': { label: 'Ready for review', color: C.review, tone: 'review' },
  paused: { label: 'Paused', color: C.dim, tone: 'default' },
  stopped: { label: 'Stopped', color: C.dim, tone: 'muted' },
  'rate-limited': { label: 'Rate limited', color: C.warn, tone: 'needs' },
  error: { label: 'Error', color: C.bad, tone: 'error' },
  done: { label: 'Done', color: C.ok, tone: 'default' },
};

export const SUBAGENT_STATUS_META: Record<SubagentStatus, StatusMeta> = {
  queued: { label: 'Queued', color: C.dim, tone: 'muted' },
  running: { label: 'Running', color: C.accent, tone: 'default' },
  'needs-permission': { label: 'Needs permission', color: C.warn, tone: 'needs' },
  done: { label: 'Done', color: C.ok, tone: 'default' },
  error: { label: 'Error', color: C.bad, tone: 'error' },
  stopped: { label: 'Stopped', color: C.dim, tone: 'muted' },
};

export function agentStatusMeta(status: AgentStatus): StatusMeta {
  return AGENT_STATUS_META[status] ?? { label: status, color: C.dim, tone: 'default' };
}

export function subagentStatusMeta(status: SubagentStatus): StatusMeta {
  return SUBAGENT_STATUS_META[status] ?? { label: status, color: C.dim, tone: 'default' };
}

/** Letter shown on subagent chips: the model family (H = Haiku, S = Sonnet, O = Opus …). */
export function modelLetter(model: string | undefined): string {
  if (!model) return '?';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'O';
  if (m.includes('sonnet')) return 'S';
  if (m.includes('haiku')) return 'H';
  if (m.includes('fable')) return 'F';
  const first = model.replace(/^claude-/i, '').trim()[0];
  return first ? first.toUpperCase() : '?';
}

/** Human model family name ("Haiku", "Sonnet", "Opus") or the raw id. */
export function modelFamily(model: string | undefined): string {
  if (!model) return 'Unknown model';
  const letter = modelLetter(model);
  return ({ O: 'Opus', S: 'Sonnet', H: 'Haiku', F: 'Fable' } as Record<string, string>)[letter] ?? model;
}
