/**
 * Pure helpers for the Artifacts screen: filtering, "used by agents" lines, history labels,
 * claude.ai link checks, retrieval states, the New artifact dialog's file rules, the Files panel's
 * tree and front-matter handling. No React, no bridge (unit-testable).
 */
import {
  REACT_DESIGN_ENTRY,
  parseBoard,
  classifyClaudeLink,
  type AgentStatus,
  type AgentSummary,
  type ArtifactFile,
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
  { id: 'board', label: 'Boards' },
];

export const KIND_LABEL: Record<ArtifactKind, string> = { design: 'Design', doc: 'Doc', whiteboard: 'Whiteboard', board: 'Board' };

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

/** Why a link can't be retrieved (a chat link, another host, not a link), or undefined when it can. */
export function importLinkError(raw: string): string | undefined {
  const r = classifyClaudeLink(raw);
  return r.ok ? undefined : r.reason;
}

/** Removes a leading `---` front-matter block from Markdown (shared with the Files preview). */
export { stripFrontMatter } from '../../lib/markdown';

/** Whiteboards must be a JSON object, boards an oIDE board; returns an error message or null. */
export function validateContent(kind: ArtifactKind, content: string): string | null {
  if (kind === 'board') {
    try {
      parseBoard(content);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }
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

/** A Monaco language id ('markdown', 'html', 'javascript', 'css', 'plaintext' …). */
export type SourceLanguage = string;

const LANGUAGE_BY_EXT: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  excalidraw: 'json',
  svg: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  txt: 'plaintext',
};

/** Monaco language for a file of a multi-file artifact, by extension. */
export function languageForPath(path: string): SourceLanguage {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (ext && LANGUAGE_BY_EXT[ext]) || 'plaintext';
}

/** Monaco language for an artifact's entry: a React design (App.jsx) is JavaScript, a page HTML. */
export function sourceLanguage(kind: ArtifactKind, entry?: string): SourceLanguage {
  if (kind === 'design') {
    if (entry === REACT_DESIGN_ENTRY) return 'javascript';
    const lang = entry ? languageForPath(entry) : 'html';
    return lang === 'plaintext' ? 'html' : lang;
  }
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

/* ------------------------------------------------------------------ retrieval by an agent (ADR 0014) */

/** The retrieval the UI shows: running, or the last one failed. A finished one shows nothing. */
export function activeRetrieval(meta: ArtifactMeta): 'retrieving' | 'failed' | null {
  const s = meta.retrieval?.status;
  return s === 'retrieving' || s === 'failed' ? s : null;
}

/**
 * The grid card's retrieval line, in place of the use line: "Retrieving with an agent" while it runs,
 * "Retrieval failed" when the first one failed (no files), "Update failed" when an update did.
 */
export function retrievalLine(meta: ArtifactMeta): { text: string; tone: 'live' | 'bad' } | null {
  const r = activeRetrieval(meta);
  if (r === 'retrieving') return { text: 'Retrieving with an agent', tone: 'live' };
  if (r === 'failed') return { text: meta.version === 0 ? 'Retrieval failed' : 'Update failed', tone: 'bad' };
  return null;
}

/** A linked artifact the Update button can retrieve again (a claude.ai link, not claude.site). */
export function canUpdateFromLink(meta: ArtifactMeta): boolean {
  return canOpenClaudeLink(meta.importedFrom);
}

/** Shown when a failed retrieval has no reason of its own. */
export const RETRIEVAL_NO_REASON = 'The agent stopped without handing over the files.';

/* ------------------------------------------------------------------ New artifact › Files */

const DESIGN_FILE = /\.(html?|jsx|tsx|svg|css)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const PAGE_FILE = /\.html?$/i;

/** The last segment of a path (either separator), for the chosen-files list. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The kind the files make, like main detects it: any page, component or stylesheet (or only images)
 * is a design, an .excalidraw board a whiteboard, otherwise a doc.
 */
export function kindFromFiles(names: readonly string[]): ArtifactKind {
  if (names.some((n) => DESIGN_FILE.test(n))) return 'design';
  if (names.some((n) => /\.excalidraw$/i.test(n))) return 'whiteboard';
  if (names.length && names.every((n) => IMAGE_FILE.test(n))) return 'design';
  return 'doc';
}

/** Pages a design made of these files could open on (for "Opens on"); index.html first. */
export function entryCandidates(names: readonly string[]): string[] {
  const pages = [...new Set(names.filter((n) => PAGE_FILE.test(n)))];
  return pages.sort((a, b) => Number(/^index\.html?$/i.test(b)) - Number(/^index\.html?$/i.test(a)) || a.localeCompare(b));
}

/** True for a file the Files panel shows as an image. */
export function isImagePath(path: string): boolean {
  return IMAGE_FILE.test(path);
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** A data: URL for an image read with `artifacts.readFile` (the renderer CSP allows data: images). */
export function imageDataUrl(path: string, base64: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return `data:${IMAGE_MIME[ext] ?? 'application/octet-stream'};base64,${base64}`;
}

/** A page of a design the preview can open on (Files panel › Open on this page). */
export function isPagePath(path: string): boolean {
  return PAGE_FILE.test(path);
}

/* ------------------------------------------------------------------ Files panel */

export interface FileRow {
  /** Full path for a file, the folder's path for a folder row. */
  path: string;
  name: string;
  depth: number;
  dir: boolean;
  size?: number;
  text?: boolean;
}

interface Node {
  dirs: Map<string, Node>;
  files: ArtifactFile[];
}

/** A compact tree of the files (folders first, then files, each sorted by name), flattened to rows. */
export function fileTree(files: readonly ArtifactFile[]): FileRow[] {
  const root: Node = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push(f);
  }
  const rows: FileRow[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name;
      rows.push({ path, name, depth, dir: true });
      walk(child, path, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ path: f.path, name: f.path.split('/').pop()!, depth, dir: false, size: f.size, text: f.text });
    }
  };
  walk(root, '', 0);
  return rows;
}

/* ------------------------------------------------------------------ artifact agent */

/**
 * The artifact's agent (Artifacts › open view › Agent panel): a live (not archived) agent whose
 * summary names this artifact; with several, the newest.
 */
export function artifactAgentOf(agents: Iterable<AgentSummary>, artifactId: string): AgentSummary | undefined {
  let best: AgentSummary | undefined;
  for (const a of agents) {
    if (a.artifactId !== artifactId || a.archived) continue;
    if (!best || a.createdAt > best.createdAt) best = a;
  }
  return best;
}

/** Statuses in which the agent is working (or about to): New conversation waits, Stop is offered. */
const WORKING: ReadonlySet<AgentStatus> = new Set(['queued', 'starting', 'running', 'needs-permission']);
export function isAgentWorking(status: AgentStatus): boolean {
  return WORKING.has(status);
}

/* ------------------------------------------------------------------ point and comment */

/** One comment the user pinned on the preview, waiting to be sent to the artifact agent. */
export interface FeedbackPin {
  id: string;
  /** The marker's number in the preview (stable while the pin lives). */
  n: number;
  /** Design: the page inside the artifact (`index.html`). */
  page?: string;
  /** Design: the element's CSS selector (from the frame's picker; untrusted text). */
  selector?: string;
  /** Design: the element's tag name. */
  tag?: string;
  /** Doc: the nearest heading above the block (or the block itself, when it is a heading). */
  heading?: string;
  /** Doc: the block's kind ("paragraph", "list item", "heading"…) and its index among the blocks. */
  block?: string;
  blockIndex?: number;
  /** The start of the element's text, whitespace collapsed. */
  text: string;
  comment: string;
  /** Sent with the next "Send N to agent". */
  checked: boolean;
}

/** Collapse whitespace and cut to `max` characters (with an ellipsis). Text only, never HTML. */
export function snippet(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** A quoted snippet that cannot break out of its quotes. */
function quoted(text: string, max = 120): string {
  return `"${snippet(text, max).replace(/"/g, "'")}"`;
}

/** A selector inside a code span (backticks in it would end the span early). */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'").slice(0, 500)}\``;
}

/** Where a pin points, for the tray and the message: "index.html › `main > h2`", 'Under "Retry" › paragraph'. */
export function pinWhere(pin: Pick<FeedbackPin, 'page' | 'selector' | 'tag' | 'heading' | 'block'>): string {
  if (pin.selector !== undefined || pin.page !== undefined) {
    const el = pin.selector ? code(pin.selector) : pin.tag ? `<${pin.tag}>` : 'the page';
    return pin.page ? `${pin.page} › ${el}` : el;
  }
  const block = pin.block ?? 'block';
  if (block === 'heading' && pin.heading) return `Heading ${quoted(pin.heading, 80)}`;
  return pin.heading ? `Under ${quoted(pin.heading, 80)} › ${block}` : `Before the first heading › ${block}`;
}

/**
 * The one text message "Send N to agent" sends: the checked pins in marker order, numbered 1..N,
 * each with where it points, the quoted text and the user's comment; then what the user typed in
 * the composer, if anything. Plain text: comments and snippets are the user's or the page's words,
 * sent as they are (no HTML, no markup beyond the selector's code span).
 */
export function buildFeedbackMessage(input: { title: string; version: number; pins: readonly FeedbackPin[]; text?: string }): string {
  const pins = input.pins.filter((p) => p.checked && p.comment.trim()).sort((a, b) => a.n - b.n);
  const extra = input.text?.trim() ?? '';
  if (!pins.length) return extra;
  const lines = pins.map((p, i) => {
    const said = p.comment.trim().replace(/\s*\n\s*/g, ' ');
    const text = p.text.trim() ? ` (${quoted(p.text)})` : '';
    return `${i + 1}. ${pinWhere(p)}${text}: ${said}`;
  });
  return [
    `Feedback on the preview of ${input.title} (v${input.version}):`,
    '',
    ...lines,
    ...(extra ? ['', extra] : []),
    '',
    pins.length === 1 ? 'Change the artifact to address this point.' : 'Change the artifact to address each point.',
  ].join('\n');
}

/** The next marker number for an artifact's pins. */
export function nextPinNumber(pins: readonly FeedbackPin[]): number {
  return pins.reduce((m, p) => Math.max(m, p.n), 0) + 1;
}
