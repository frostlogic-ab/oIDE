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
