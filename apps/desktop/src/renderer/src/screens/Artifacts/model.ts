/**
 * Pure helpers for the Artifacts screen: filtering, "used by agents" lines, history labels,
 * claude.ai link checks and front-matter handling. No React, no bridge (unit-testable).
 */
import type { AgentStatus, AgentSummary, ArtifactKind, ArtifactMeta, ArtifactUse, ArtifactVersion } from '@oide/protocol';

export type KindTab = 'all' | ArtifactKind;

export const KIND_TABS: ReadonlyArray<{ id: KindTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'design', label: 'Designs' },
  { id: 'doc', label: 'Docs' },
  { id: 'whiteboard', label: 'Whiteboards' },
];

export const KIND_LABEL: Record<ArtifactKind, string> = { design: 'Design', doc: 'Doc', whiteboard: 'Whiteboard' };

export interface ArtifactFilter {
  kind: KindTab;
  /** `'all'` or a project id (the shared project scope). */
  project: string;
  query: string;
}

export function filterArtifacts(list: ArtifactMeta[], f: ArtifactFilter, projectName: (id: string | undefined) => string = (id) => id ?? ''): ArtifactMeta[] {
  const q = f.query.trim().toLowerCase();
  return list.filter((a) => {
    if (f.kind !== 'all' && a.kind !== f.kind) return false;
    if (f.project !== 'all' && a.projectId !== f.project) return false;
    if (!q) return true;
    return [a.title, KIND_LABEL[a.kind], projectName(a.projectId), a.slug].some((s) => s.toLowerCase().includes(q));
  });
}

/** A write by a running agent within this window counts as "being written". */
export const LIVE_WINDOW_MS = 10 * 60_000;

export interface UsageLine {
  text: string;
  live: boolean;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

const RUNNING: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['starting', 'running', 'needs-permission', 'has-question', 'queued']);

/** The grid card's third line: "Being written by an agent", "Read by 2 agents", … */
export function usageLine(uses: ArtifactUse[] | undefined, agents: Record<string, AgentSummary | undefined>, now = Date.now()): UsageLine {
  const list = uses ?? [];
  const writes = list.filter((u) => u.op === 'write' || u.op === 'create').sort((a, b) => b.ts - a.ts);
  const latest = writes[0];
  if (latest) {
    const agent = agents[latest.agentId];
    if (now - latest.ts < LIVE_WINDOW_MS && agent && RUNNING.has(agent.status)) return { text: 'Being written by an agent', live: true };
    return { text: `Written by an agent · ${relativeTime(latest.ts, now)}`, live: false };
  }
  const readers = new Set(list.filter((u) => u.op === 'read').map((u) => u.agentId));
  if (readers.size) return { text: `Read by ${readers.size} ${readers.size === 1 ? 'agent' : 'agents'}`, live: false };
  return { text: 'Not used by agents', live: false };
}

/** "Agents using it": one row per agent, "writes" when it ever wrote, else "reads". */
export function agentsUsing(uses: ArtifactUse[]): Array<{ agentId: string; op: 'reads' | 'writes'; ts: number }> {
  const by = new Map<string, { agentId: string; op: 'reads' | 'writes'; ts: number }>();
  for (const u of uses) {
    if (u.op === 'list') continue;
    const prev = by.get(u.agentId);
    const op = u.op === 'read' ? 'reads' : 'writes';
    by.set(u.agentId, { agentId: u.agentId, op: prev?.op === 'writes' || op === 'writes' ? 'writes' : 'reads', ts: Math.max(prev?.ts ?? 0, u.ts) });
  }
  return [...by.values()].sort((a, b) => b.ts - a.ts);
}

export function clockTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return sameDay ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

/** "v4 · edited by you · 11:20", "v3 · Window shell layout agent · added a focus view · 10:52". */
export function versionLabel(v: ArtifactVersion, agentTitle: (id: string) => string | undefined, now = Date.now()): string {
  const agentId = v.author.startsWith('agent:') ? v.author.slice(6) : undefined;
  const who = agentId ? `${agentTitle(agentId) ?? agentId} agent` : v.author === 'user' ? 'edited by you' : v.author;
  const note = v.note && !/^edited by you$/i.test(v.note) ? ` · ${v.note.charAt(0).toLowerCase()}${v.note.slice(1)}` : '';
  return `v${v.version} · ${who}${note} · ${clockTime(v.ts, now)}`;
}

const CLAUDE_HOSTS = ['claude.ai', 'claude.site'];

/** True for https links on claude.ai / claude.site (the only hosts "Open in claude.ai" opens). */
export function isClaudeLink(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && CLAUDE_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Removes a leading `---` front-matter block from Markdown. */
export function stripFrontMatter(md: string): string {
  const BOM = String.fromCharCode(0xfeff);
  return (md.startsWith(BOM) ? md.slice(1) : md).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function kindFromFileName(name: string): ArtifactKind {
  if (/\.html?$/i.test(name)) return 'design';
  if (/\.(excalidraw|json)$/i.test(name)) return 'whiteboard';
  return 'doc';
}

/** Whiteboards must be a JSON object; returns an error message or null. */
export function validateContent(kind: ArtifactKind, content: string): string | null {
  if (kind !== 'whiteboard') return null;
  try {
    const v: unknown = JSON.parse(content);
    return v && typeof v === 'object' && !Array.isArray(v) ? null : 'A whiteboard must be a JSON object.';
  } catch (err) {
    return `Not valid JSON: ${(err as Error).message}`;
  }
}
