import type { OverlapWarning } from '@oide/protocol';
import { changedFiles } from './diff.js';
import { toGit, type Repo } from './git.js';
import { predictConflicts } from './merge.js';
import { CASE_INSENSITIVE } from './paths.js';

export interface LiveWorktree {
  agentId: string;
  path: string;
  branch: string;
  baseRef: string;
  /** Precomputed changed files (skips the diff call). */
  changedFiles?: string[];
}

/** Pairwise intersection of changed-file sets. Pure; `caseInsensitive` folds paths for comparison. */
export function intersectChangedFiles(
  sets: Array<{ agentId: string; files: string[] }>,
  caseInsensitive = CASE_INSENSITIVE,
): Array<{ agentIds: [string, string]; files: string[] }> {
  const key = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const indexed = sets.map((s) => ({ agentId: s.agentId, map: new Map(s.files.map((f) => [key(f), f])) }));
  const out: Array<{ agentIds: [string, string]; files: string[] }> = [];
  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      const a = indexed[i]!;
      const b = indexed[j]!;
      const files: string[] = [];
      for (const [k, f] of a.map) if (b.map.has(k)) files.push(f);
      if (files.length) out.push({ agentIds: [a.agentId, b.agentId], files: files.sort() });
    }
  }
  return out;
}

/**
 * Heads-up for Source control: which pairs of live worktrees in a project change the same files,
 * and (with `predict`, default on) whether merging their branches would truly conflict, via
 * `git merge-tree --write-tree`. Prediction only sees commits, not uncommitted edits.
 */
export async function detectOverlaps(
  projectId: string,
  projectRepo: Repo,
  worktrees: LiveWorktree[],
  opts: { predict?: boolean } = {},
): Promise<OverlapWarning[]> {
  const git = toGit(projectRepo);
  const sets = await Promise.all(
    worktrees.map(async (w) => ({
      agentId: w.agentId,
      branch: w.branch,
      files: w.changedFiles ?? (await changedFiles(git.at(w.path), w.baseRef).catch(() => [] as string[])),
    })),
  );
  const pairs = intersectChangedFiles(sets);
  const byAgent = new Map(sets.map((s) => [s.agentId, s]));
  const out: OverlapWarning[] = [];
  for (const p of pairs) {
    const warning: OverlapWarning = { projectId, agentIds: p.agentIds, files: p.files };
    if (opts.predict !== false) {
      const a = byAgent.get(p.agentIds[0])!.branch;
      const b = byAgent.get(p.agentIds[1])!.branch;
      try {
        warning.conflicts = (await predictConflicts(git, a, b)).conflicts;
      } catch {
        // Unknown branch or old git: leave `conflicts` undefined.
      }
    }
    out.push(warning);
  }
  return out;
}
