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
