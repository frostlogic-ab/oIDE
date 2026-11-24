import { z } from 'zod';
import { DiffStat, Id } from './agent.js';

export const Project = z.object({
  id: Id,
  name: z.string(),
  /** Absolute path of the main checkout. */
  path: z.string(),
  trusted: z.boolean().default(false),
  createdAt: z.number(),
});
export type Project = z.infer<typeof Project>;

export const SyncState = z.object({
  branch: z.string(),
  upstream: z.string().optional(),
  ahead: z.number().int().default(0),
  behind: z.number().int().default(0),
  dirtyFiles: z.array(z.string()).default([]),
  lastFetchAt: z.number().optional(),
});
export type SyncState = z.infer<typeof SyncState>;

export const WorktreeInfo = z.object({
  agentId: Id.optional(),
  projectId: Id,
  path: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  ahead: z.number().int().default(0),
  behind: z.number().int().default(0),
  diff: DiffStat.optional(),
  changedFiles: z.array(z.string()).default([]),
  pr: z.object({ state: z.string(), number: z.number().optional(), url: z.string().optional() }).optional(),
  orphaned: z.boolean().default(false),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfo>;

export const CommitInfo = z.object({
  sha: z.string(),
  /** Subject line. */
  message: z.string(),
  /** Rest of the message (including trailers), when present. Added by @oide/git. */
  body: z.string().optional(),
  author: z.string(),
  /** Agent name from the `Oide-Agent:` trailer, if any. */
  agent: z.string().optional(),
  ts: z.number(),
});
export type CommitInfo = z.infer<typeof CommitInfo>;

export const OverlapWarning = z.object({
  projectId: Id,
  agentIds: z.tuple([Id, Id]),
  files: z.array(z.string()),
  /** From `git merge-tree --write-tree`: true = a real conflict. */
  conflicts: z.boolean().optional(),
});
export type OverlapWarning = z.infer<typeof OverlapWarning>;

export const FileDiff = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean().default(false),
  /** Unified diff hunks text. */
  patch: z.string(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const ReviewComment = z.object({
  id: Id,
  agentId: Id,
  path: z.string(),
  line: z.number().int().optional(),
  /** Which side of the diff `line` numbers: `old` for a removed line, `new` (default) otherwise. */
  side: z.enum(['old', 'new']).default('new'),
  body: z.string().min(1),
  sent: z.boolean().default(false),
  createdAt: z.number(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const FileNode = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'dir']),
});
export type FileNode = z.infer<typeof FileNode>;
