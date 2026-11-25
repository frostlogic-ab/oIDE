/**
 * Pure helpers for the Artifacts screen: filtering, "used by agents" lines, history labels,
 * claude.ai link checks and front-matter handling. No React, no bridge (unit-testable).
 */
import {
  REACT_DESIGN_ENTRY,
  classifyClaudeLink,
  inferKindFromContent,
  isDesignContent,
  isImportStubContent,
  type AgentStatus,
  type AgentSummary,
  type ArtifactKind,
  type ArtifactMeta,
  type ArtifactUse,
  type ArtifactVersion,
} from '@oide/protocol';

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

/**
 * True for https links on claude.ai / claude.site (host only). Used for links already stored on an
 * artifact; a link about to be imported goes through `classifyClaudeLink` (see `importLinkError`).
 */
export function isClaudeLink(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && CLAUDE_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * True for claude.ai links oIDE can open in the system browser ("Open in claude.ai", the import
 * dialog's Open). claude.site is not on main's external-link allow-list: anyone can publish there.
 */
export function canOpenClaudeLink(url: string | undefined): url is string {
  if (!isClaudeLink(url)) return false;
  const host = new URL(url).hostname.toLowerCase();
  return host === 'claude.ai' || host.endsWith('.claude.ai');
}

/** Why a link can't be imported (a chat link, another host, not a link), or undefined when it can. */
export function importLinkError(raw: string): string | undefined {
  const r = classifyClaudeLink(raw);
  return r.ok ? undefined : r.reason;
}

/** The reason an import has to wait: shown under the Import button while it is disabled. */
export const IMPORT_NEEDS_CODE_REASON = "Paste the artifact's code first. oIDE can't download claude.ai artifacts, even public ones.";

/** Pasted content above this size is refused before it is sent (main checks again). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/**
 * Why `content` can't be stored as `kind` (import or fix): too large, the placeholder older versions
 * stored, not HTML or React as a design, not JSON as a whiteboard. Main applies the same rules.
 */
export function importContentError(kind: ArtifactKind, content: string): string | undefined {
  // UTF-8 is at most 3 bytes per UTF-16 unit: only encode when the paste could be over the limit.
  if (content.length * 3 > MAX_IMPORT_BYTES && new TextEncoder().encode(content).length > MAX_IMPORT_BYTES) return 'The content is larger than 10 MB.';
  if (isImportStubContent(content)) return "That's the placeholder older versions of oIDE stored, not the artifact. Paste the artifact's real code.";
  if (kind === 'design' && !isDesignContent(content)) {
    return "This isn't an HTML page or a React component, so it can't be a design. Pick Doc to keep it as text.";
  }
  if (kind === 'whiteboard') return validateContent('whiteboard', content.charCodeAt(0) === 0xfeff ? content.slice(1) : content) ?? undefined;
  return undefined;
}

/**
 * Fixing a broken import: the pasted content replaces its notice in place when it fits the artifact's
 * kind; otherwise (a doc whose paste is a design, say) a new artifact of the content's kind replaces it.
 */
export function fixImportPlan(kind: ArtifactKind, content: string): { mode: 'save' } | { mode: 'replace'; kind: ArtifactKind } {
  const inferred = inferKindFromContent(content);
  if (inferred === kind || (kind === 'design' && isDesignContent(content))) return { mode: 'save' };
  return { mode: 'replace', kind: inferred };
}

/** Removes a leading `---` front-matter block from Markdown. */
export function stripFrontMatter(md: string): string {
  const BOM = String.fromCharCode(0xfeff);
  return (md.startsWith(BOM) ? md.slice(1) : md).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** Files an import takes, for the picker filter and the drop check. */
export const IMPORT_EXTENSIONS = ['html', 'htm', 'jsx', 'tsx', 'svg', 'md', 'markdown', 'txt', 'excalidraw', 'json'] as const;

export function kindFromFileName(name: string): ArtifactKind {
  if (/\.(html?|jsx|tsx|svg)$/i.test(name)) return 'design';
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

/** "you", "Window shell layout agent", or the raw author string. */
export function authorLabel(author: string | undefined, agentTitle: (id: string) => string | undefined): string {
  if (!author || author === 'user') return 'you';
  if (author.startsWith('agent:')) {
    const id = author.slice(6);
    return `${agentTitle(id) ?? id} agent`;
  }
  return author;
}

/**
 * What an open editor does when the artifact's current version moves on (an `artifacts.changed`
 * reload):
 * - `none`: same version as the editor's base (or older: a stale reply).
 * - `own`: the editor saved it itself.
 * - `reload`: someone else saved it and there are no unsaved edits: load it and say who.
 * - `conflict`: someone else saved it while there are unsaved edits: keep the edits, show a banner.
 */
export type LiveDecision = 'none' | 'own' | 'reload' | 'conflict';

export function liveDecision(opts: { baseVersion: number; incomingVersion: number; ownVersions: ReadonlySet<number>; dirty: boolean }): LiveDecision {
  if (opts.incomingVersion <= opts.baseVersion) return 'none';
  if (opts.ownVersions.has(opts.incomingVersion)) return 'own';
  return opts.dirty ? 'conflict' : 'reload';
}

export type SourceLanguage = 'markdown' | 'html' | 'javascript' | 'json';

/** Monaco language for an artifact's source: a React design (entry App.jsx) is JavaScript. */
export function sourceLanguage(kind: ArtifactKind, entry?: string): SourceLanguage {
  if (kind === 'design') return entry === REACT_DESIGN_ENTRY ? 'javascript' : 'html';
  return kind === 'doc' ? 'markdown' : 'json';
}

/** Whiteboard JSON is pretty-printed for the version diff (one property per line); other kinds as is. */
export function contentForDiff(kind: ArtifactKind, content: string): string {
  if (kind !== 'whiteboard') return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2) + '\n';
  } catch {
    return content;
  }
}

/** Title for a rename, or an error message. */
export function validateTitle(title: string): { title: string } | { error: string } {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) return { error: 'Give it a title.' };
  if (t.length > 200) return { error: 'Use at most 200 characters.' };
  return { title: t };
}
