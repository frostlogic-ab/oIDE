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
  /** Entry file relative to the artifact folder (index.html, doc.md, board.excalidraw). */
  entry: z.string(),
  importedFrom: z.string().url().optional(),
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
  if (/^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<\?xml\s[^>]*\?>\s*(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]|<!doctype\s+svg[^>]*>\s*<svg[\s>])/i.test(head)) return 'document';
  // JSX source starts with `import` / `export`, so it is not a fragment.
  return /^<[a-z][\w-]*[\s/>]/i.test(head) && /<\/[a-z][\w-]*\s*>|\/>/i.test(text) ? 'fragment' : null;
}

/** True for an HTML page or fragment (what a design's `index.html` must hold). */
export function looksLikeHtml(content: string): boolean {
  return htmlStart(content) !== null;
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
