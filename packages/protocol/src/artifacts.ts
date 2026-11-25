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

/** True for an HTML page or fragment (what a design's `index.html` must hold). */
export function looksLikeHtml(content: string): boolean {
  const text = stripBom(content).trimStart();
  const head = text.slice(0, 4096);
  if (/^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<\?xml\s[^>]*\?>\s*<svg[\s>])/i.test(head)) return true;
  // A fragment: starts with a tag and closes one (`<div>…</div>`, `<svg …/>`). JSX source starts with `import`/`export`.
  return /^<[a-z][\w-]*[\s/>]/i.test(head) && /<\/[a-z][\w-]*\s*>|\/>/i.test(text);
}

/** Kind of pasted content: HTML → design, Excalidraw JSON → whiteboard, anything else → doc. */
export function inferKindFromContent(content: string): ArtifactKind {
  const text = stripBom(content).trim();
  if (looksLikeHtml(text)) return 'design';
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

/** A title from the content: an HTML `<title>` or `<h1>`, or a Markdown `# heading`. */
export function titleFromContent(kind: ArtifactKind, content: string): string | undefined {
  let t: string | undefined;
  if (kind === 'design') {
    const m = /<title[^>]*>([^<]{1,400})<\/title>/i.exec(content) ?? /<h1[^>]*>([^<]{1,400})<\/h1>/i.exec(content);
    t = m?.[1]?.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_x, e: string) => HTML_ENTITIES[e] ?? '');
  } else if (kind === 'doc') {
    t = /^#[ \t]+(.{1,400})$/m.exec(content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''))?.[1]?.replace(/[ \t]#+[ \t]*$/, '');
  }
  t = t?.replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return t || undefined;
}
