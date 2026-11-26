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
  /** Commits on the branch that its upstream (the pushed branch, e.g. the PR head) does not have yet; absent when the branch was never pushed. */
  unpushed: z.number().int().nonnegative().optional(),
  /** Files with uncommitted changes in the worktree (tracked and untracked, not ignored). */
  uncommitted: z.number().int().nonnegative().optional(),
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

/**
 * "Merge into main?" before merging: what `git merge-tree --write-tree` predicts for merging the agent
 * branch into the main checkout's HEAD (`git.predictMerge`). Cached in main per (HEAD, branch) commit pair.
 */
export const MergePrediction = z.object({
  agentId: Id,
  /**
   * `clean`: merges without conflicts. `conflicts`: `files` would conflict. `unknown`: could not
   * predict (git older than 2.38); the merge still stops on conflicts. `unavailable`: nothing to merge
   * (the agent works in the project folder, or its branch is gone); see `reason`.
   */
  status: z.enum(['clean', 'conflicts', 'unknown', 'unavailable']),
  reason: z.string().optional(),
  /** The main checkout's branch (absent on a detached HEAD) and commit. */
  target: z.object({ branch: z.string().optional(), sha: z.string() }).optional(),
  branchSha: z.string().optional(),
  files: z.array(z.string()).default([]),
  /** Conflicted files git cannot merge line by line. */
  binary: z.array(z.string()).default([]),
  /** Conflicted submodule pointers. */
  submodules: z.array(z.string()).default([]),
  /** Commits on the target the branch does not have ("Behind main by N"). */
  behind: z.number().int().nonnegative().default(0),
  ahead: z.number().int().nonnegative().default(0),
  /** Uncommitted changes in the main checkout (`withMainStatus`): git refuses to merge over the ones the merge touches. */
  mainDirty: z.array(z.string()).optional(),
  /** Whether "Ask <agent> to resolve" can work; `askBlocked` says why not. */
  canAsk: z.boolean().default(false),
  askBlocked: z.string().optional(),
  computedAt: z.number(),
});
export type MergePrediction = z.infer<typeof MergePrediction>;

export const FileDiff = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean().default(false),
  /** Unified diff hunks text. */
  patch: z.string(),
  /**
   * Set when the file configures agents, git or MCP (`.oide/`, `.claude/`, `.mcp.json`,
   * `.gitattributes`, `.gitmodules`): why merging it deserves a closer look (SEC-12).
   */
  sensitive: z.string().optional(),
});
export type FileDiff = z.infer<typeof FileDiff>;

/** Why a changed path is security-sensitive, or undefined (SEC-12). */
export function sensitivePathReason(path: string): string | undefined {
  const p = path.replace(/\\/g, '/').toLowerCase();
  const segs = p.split('/');
  if (segs.includes('.oide')) return 'oIDE project config (.oide/): permissions, setup command, extensions';
  if (segs.includes('.claude')) return 'Claude Code project config (.claude/): settings, hooks, agents, commands';
  const name = segs.at(-1);
  if (name === '.mcp.json') return 'MCP servers (.mcp.json)';
  if (name === '.gitattributes') return 'git attributes (.gitattributes): filters and diff/merge drivers';
  if (name === '.gitmodules') return 'git submodules (.gitmodules)';
  return undefined;
}

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
