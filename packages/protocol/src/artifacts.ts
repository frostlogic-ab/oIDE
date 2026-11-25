import { z } from 'zod';
import { Id } from './agent.js';

export const ArtifactKind = z.enum(['design', 'doc', 'whiteboard']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** `artifact.json` next to the content. */
export const ArtifactMeta = z.object({
  id: Id,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string(),
  kind: ArtifactKind,
  projectId: Id.optional(),
  location: z.enum(['repo', 'app-data']),
  version: z.number().int().positive(),
  /** Entry file relative to the artifact folder (index.html or App.jsx, doc.md, board.excalidraw). */
  entry: z.string(),
  importedFrom: z.string().url().optional(),
  /**
   * Derived when read, never stored: a link-only import made by an older oIDE, whose only version
   * holds the "cannot fetch" placeholder instead of the artifact. The UI asks for the real content.
   */
  brokenImport: z.boolean().optional(),
  /**
   * Extension artifact type (`contributes.artifactTypes`) as `<extension name>:<type id>`. The kind
   * still decides the storage format; the extension's viewer iframe shows and edits the content.
   */
  type: z.string().max(300).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMeta>;

export const ArtifactVersion = z.object({
  version: z.number().int().positive(),
  ts: z.number(),
  author: z.string(),
  note: z.string().optional(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersion>;

export const ArtifactUse = z.object({
  artifactId: Id,
  agentId: Id,
  op: z.enum(['read', 'write', 'create', 'list']),
  ts: z.number(),
});
export type ArtifactUse = z.infer<typeof ArtifactUse>;

/** What `artifacts.get` returns and the MCP `artifacts.read` tool reads. */
export interface ArtifactContent {
  meta: ArtifactMeta;
  content: string;
}

/**
 * The shape oIDE's MCP server needs for the `artifacts.*` tools. Implemented by `ArtifactStore`
 * in `@oide/store`; every call is logged as an `ArtifactUse` (fills "Agents using it").
 */
export interface ArtifactsBackend {
  list(filter: { projectId?: string; kind?: ArtifactKind }, agentId?: string): Promise<ArtifactMeta[]>;
  read(id: string, agentId?: string): Promise<ArtifactContent>;
  write(id: string, content: string, agentId: string): Promise<ArtifactMeta>;
  create(input: { title: string; kind: ArtifactKind; content?: string; projectId?: string }, agentId: string): Promise<ArtifactMeta>;
}

/**
 * Future sync source (claude.ai or another service). Not implemented in v1: there is no public
 * API for claude.ai artifacts. Kept so a source can be added without changing how agents use artifacts.
 */
export interface ArtifactSource {
  readonly id: string;
  list(): Promise<Array<{ remoteId: string; title: string; kind: ArtifactKind; url: string; updatedAt?: number }>>;
  fetch(remoteId: string): Promise<{ title: string; kind: ArtifactKind; content: string; url: string }>;
  push(meta: ArtifactMeta, content: string): Promise<{ remoteId: string; url: string }>;
}

/* ---------------------------------------------------------------- import helpers (main + renderer) */

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * How the content starts, after a BOM, whitespace and leading `<!-- … -->` comments: `document` for
 * a page (`<!doctype html>`, `<html>`, `<head>`, `<body>`, an SVG file), `fragment` for markup that
 * starts with a tag and closes one (`<div>…</div>`, `<svg …/>`), else null. Comments are skipped with
 * indexOf and every pattern has one way to match, so 10 MB of hostile input stays linear.
 */
function htmlStart(content: string): 'document' | 'fragment' | null {
  const text = stripBom(content).trimStart();
  let start = 0;
  while (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start + 4);
    if (end < 0) return null;
    start = end + 3;
    while (start < text.length && /\s/.test(text[start]!)) start++;
  }
  const head = text.slice(start, start + 4096);
  if (/^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(head)) return 'document';
  if (/^<\?xml\s|^<!doctype\s+svg/i.test(head) && isSvgDocument(head)) return 'document';
  // JSX source starts with `import` / `export`, so it is not a fragment.
  return /^<[a-z][\w-]*[\s/>]/i.test(head) && /<\/[a-z][\w-]*\s*>|\/>/i.test(text) ? 'fragment' : null;
}

/**
 * An SVG file: an optional `<?xml …?>` header, then comments and an optional SVG doctype in any order
 * (Inkscape and Illustrator put a comment after the header), then `<svg`. Only the first 4 KB are
 * looked at, with indexOf, so it stays linear.
 */
function isSvgDocument(head: string): boolean {
  let i = 0;
  const skipSpace = () => {
    while (i < head.length && /\s/.test(head[i]!)) i++;
  };
  const xml = /^<\?xml\s[^>]{0,400}\?>/i.exec(head);
  if (xml) i = xml[0].length;
  for (let n = 0; n < 50; n++) {
    skipSpace();
    if (head.startsWith('<!--', i)) {
      const end = head.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    const doctype = /^<!doctype\s+svg[^>]{0,600}>/i.exec(head.slice(i, i + 700));
    if (doctype) {
      i += doctype[0].length;
      continue;
    }
    break;
  }
  return /^<svg[\s>]/i.test(head.slice(i, i + 5));
}

/** True for an HTML page or fragment (what a design's `index.html` must hold). */
export function looksLikeHtml(content: string): boolean {
  return htmlStart(content) !== null;
}

/** Entry file of a React (JSX/TSX) design, rendered by the bundled offline preview runtime. */
export const REACT_DESIGN_ENTRY = 'App.jsx';
/** Entry file of an HTML design. */
export const HTML_DESIGN_ENTRY = 'index.html';

/**
 * True for React component source, the usual shape of a claude.ai design artifact: it imports from
 * `react` and has an `export default` or JSX, or it has an `export default` and JSX. HTML is never
 * React. Only the first 256 KB are scanned, with bounded patterns, so hostile input stays linear.
 */
export function looksLikeReact(content: string): boolean {
  const text = stripBom(content).trimStart().slice(0, 256 * 1024);
  if (!text || htmlStart(text) !== null) return false;
  // Source starts with code (after comments): Markdown that shows a React example in a fenced block
  // (`# Title` … ```jsx … ```) is a doc, not a design.
  if (!/^(?:(?:import|export|const|let|var|function|class|type|interface)\b|['"]use (?:client|strict)['"])/.test(skipLeadingComments(text))) return false;
  if (/^[ \t]{0,3}(?:```|~~~)/m.test(text)) return false;
  // `[^;]` spans lines, so a multi-line `import {\n a,\n b\n} from 'react'` counts; bounded to 400 characters.
  const importsReact = /^[ \t]*import[ \t][^;]{0,400}?from[ \t]*['"]react['"]/m.test(text);
  const exportsDefault = /^[ \t]*export[ \t]+default[ \t]/m.test(text) || /^[ \t]*export[ \t]*\{[^}]{0,200}\bas[ \t]+default\b/m.test(text);
  // JSX: an element right after `return` / `=>`, a component element (`<Card`), or a closing tag.
  const hasJsx =
    /(?:return|=>)[ \t\r\n]{0,40}\(?[ \t\r\n]{0,40}<[A-Za-z>]/.test(text) || /<[A-Z][\w.]{0,60}[\s/>]/.test(text) || /<\/[a-z][\w-]{0,30}>/.test(text);
  return (importsReact && (exportsDefault || hasJsx)) || (exportsDefault && hasJsx);
}

/** The text after leading line and block comments and whitespace (indexOf only: linear). */
function skipLeadingComments(text: string): string {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      if (end < 0) return '';
      i = end + 1;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return '';
      i = end + 2;
    } else return text.slice(i, i + 200);
  }
}

/** The design entry file that fits the content: `App.jsx` for React, else `index.html`. */
export function designEntryFor(content: string): typeof REACT_DESIGN_ENTRY | typeof HTML_DESIGN_ENTRY {
  return looksLikeReact(content) ? REACT_DESIGN_ENTRY : HTML_DESIGN_ENTRY;
}

/** True when the content fits a design: an HTML page or fragment, or React component source. */
export function isDesignContent(content: string): boolean {
  return looksLikeHtml(content) || looksLikeReact(content);
}

/**
 * Text of the placeholder older oIDE versions stored for a link-only import ("Imported from <link>.
 * oIDE cannot fetch claude.ai artifacts: open the link, copy …"). Content holding it is not an
 * artifact: it is refused on import, and stored artifacts holding it are `brokenImport`.
 */
export const LEGACY_IMPORT_STUB_MARKER = 'oIDE cannot fetch claude.ai artifacts';
/**
 * The two wordings older versions wrote: "…artifacts; paste or drop the exported content here…"
 * (first link-only imports) and "…artifacts: open the link, copy the artifact's code…" (later).
 */
const LEGACY_IMPORT_STUB_SENTENCE = /oIDE cannot fetch claude\.ai artifacts(?:: open the link|; paste or drop the exported content)/;
/** The placeholder page was small (a link of at most 2 KB and a title); anything bigger is real content. */
export const LEGACY_IMPORT_STUB_MAX_BYTES = 8 * 1024;

export function isImportStubContent(content: string): boolean {
  return content.length <= LEGACY_IMPORT_STUB_MAX_BYTES && content.includes('Imported from ') && LEGACY_IMPORT_STUB_SENTENCE.test(content);
}

/**
 * Older versions stored a link-only whiteboard import as oIDE's own empty board (no notice text):
 * `source: "oide"` with no elements. Only meaningful for an import still at version 1.
 */
export function isEmptyOideBoard(content: string): boolean {
  if (content.length > 4096) return false;
  try {
    const v = JSON.parse(content) as { type?: unknown; source?: unknown; elements?: unknown };
    return v.type === 'excalidraw' && v.source === 'oide' && Array.isArray(v.elements) && v.elements.length === 0;
  } catch {
    return false;
  }
}

/** Shown when an import has a link but no content. */
export const IMPORT_NEEDS_CONTENT =
  "Paste the artifact's code or pick the file you downloaded. oIDE can't download claude.ai artifacts, even public ones, so a link alone isn't imported.";

export type ClaudeLinkInfo =
  | { ok: true; url: string; type: 'artifact' | 'public-artifact' | 'claude-site' | 'design' }
  | { ok: false; reason: string };

const CLAUDE_AI_HOST = /^(?:[a-z0-9-]+\.)*claude\.ai$/i;
const CLAUDE_SITE_HOST = /^(?:[a-z0-9-]+\.)*claude\.site$/i;
/** An artifact id path segment: an optional `<title>-` prefix, then a 22-character id or a UUID. */
const ARTIFACT_ID = /^(?:[\w%.~-]{0,300}-)?(?:[A-Za-z0-9]{22}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Checks a claude.ai link before anything is imported: https only, no user name or password, and a
 * known artifact shape (`/artifact/<id>`, `/code/artifact/<id>`, `/public/artifacts/<id>`,
 * claude.site `/artifacts/<id>`, `/design/…`). A chat link or another page is refused with a reason.
 */
export function classifyClaudeLink(raw: string): ClaudeLinkInfo {
  if (raw.length > 2048) return { ok: false, reason: 'The link is too long.' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'Not a valid link.' };
  }
  const site = CLAUDE_SITE_HOST.test(u.hostname);
  if (u.protocol !== 'https:' || (!site && !CLAUDE_AI_HOST.test(u.hostname))) return { ok: false, reason: 'Only https links on claude.ai can be imported.' };
  if (u.username || u.password) return { ok: false, reason: 'The link must not contain a user name or password.' };
  const parts = u.pathname.split('/').filter(Boolean);
  const url = u.toString();
  const idAt = (i: number) => parts.length === i + 1 && ARTIFACT_ID.test(parts[i]!);
  if (site) {
    if (parts[0] === 'artifacts' && idAt(1)) return { ok: true, url, type: 'claude-site' };
    return { ok: false, reason: "This isn't a claude.site artifact link." };
  }
  if (parts[0] === 'artifact' && idAt(1)) return { ok: true, url, type: 'artifact' };
  if (parts[0] === 'code' && parts[1] === 'artifact' && idAt(2)) return { ok: true, url, type: 'artifact' };
  if (parts[0] === 'public' && parts[1] === 'artifacts' && idAt(2)) return { ok: true, url, type: 'public-artifact' };
  if (parts[0] === 'design' && parts.length >= 2) return { ok: true, url, type: 'design' };
  if (parts[0] === 'chat') {
    return { ok: false, reason: 'This is a chat link, not an artifact link. Open the artifact in the chat and copy its own link, or paste its code.' };
  }
  return { ok: false, reason: "This isn't a claude.ai artifact link." };
}

/**
 * Kind of pasted content: an HTML page or fragment → design, Excalidraw JSON → whiteboard, anything
 * else → doc. Markdown that opens with HTML (a README's centred `<div>` banner) stays a doc.
 */
export function inferKindFromContent(content: string): ArtifactKind {
  const text = stripBom(content).trim();
  const html = htmlStart(text);
  if (html === 'document') return 'design';
  if (html === 'fragment' && !/^#{1,6}[ \t]/m.test(text.slice(0, 256 * 1024))) return 'design';
  if (looksLikeReact(text)) return 'design';
  if (text.startsWith('{')) {
    try {
      if ((JSON.parse(text) as { type?: unknown }).type === 'excalidraw') return 'whiteboard';
    } catch {
      // not JSON: a doc
    }
  }
  return 'doc';
}

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** The first `# heading` of Markdown outside fenced code, or a front-matter `title:`. */
function markdownTitle(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (close > 0) {
    for (const line of lines.slice(1, close)) {
      const m = /^title:[ \t]*(\S.*)$/.exec(line);
      if (!m) continue;
      const v = m[1]!.trim();
      let title = v;
      if (/^".*"$/.test(v)) {
        // oIDE writes front matter with JSON.stringify; fall back to the raw text when it isn't JSON.
        try {
          title = String(JSON.parse(v));
        } catch {
          title = v.slice(1, -1);
        }
      } else if (/^'.*'$/.test(v)) title = v.slice(1, -1).replace(/''/g, "'");
      if (title.trim()) return title;
      break; // an empty title: use the first heading instead
    }
    i = close + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      // A closing fence uses the same character, is at least as long and carries no info string.
      if (!fence) fence = f[1]!;
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.slice(line.indexOf(f[1]!) + f[1]!.length).trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^#[ \t]+(\S.*)$/.exec(line);
    if (h) return h[1]!.slice(0, 400).replace(/[ \t]#+[ \t]*$/, '');
  }
  return undefined;
}

/**
 * A title from the content: an HTML `<title>` or `<h1>`, or a Markdown front-matter `title:` or first
 * `# heading`. Only the first 256 KB are searched, with patterns that have one way to match.
 */
export function titleFromContent(kind: ArtifactKind, content: string): string | undefined {
  const text = stripBom(content).slice(0, 256 * 1024);
  let t: string | undefined;
  if (kind === 'design') {
    const m = /<title(?:\s[^<>]*)?>([^<]{1,400})<\/title>/i.exec(text) ?? /<h1(?:\s[^<>]*)?>([^<]{1,400})<\/h1>/i.exec(text);
    t = m?.[1]?.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_x, e: string) => HTML_ENTITIES[e] ?? '');
  } else if (kind === 'doc') {
    t = markdownTitle(text);
  }
  t = t?.replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return t || undefined;
}
