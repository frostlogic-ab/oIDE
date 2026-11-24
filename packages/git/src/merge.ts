import { toGit, type Repo } from './git.js';

export interface MergeResult {
  ok: boolean;
  /** Files that conflicted (the merge was aborted, the checkout is as before). */
  conflicts: string[];
  /** The merge commit on success. */
  sha?: string;
  /** Why the merge could not start or failed for another reason (e.g. local changes in the way). */
  error?: string;
}

/**
 * Merge an agent branch into the main checkout with `git merge --no-ff`. On conflicts the merge is
 * aborted and the conflicted files are reported, so the main checkout is never left mid-merge.
 */
export async function mergeLocal(mainCheckout: Repo, branch: string, opts: { message?: string } = {}): Promise<MergeResult> {
  const git = toGit(mainCheckout);
  if (await git.test(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])) {
    return { ok: false, conflicts: [], error: 'A merge is already in progress in the main checkout.' };
  }
  if (!(await git.revParse(branch))) return { ok: false, conflicts: [], error: `Unknown branch: ${branch}` };
  const before = await git.revParse('HEAD');
  const message = opts.message ?? `Merge ${branch}`;
  const r = await git.run(['merge', '--no-ff', '--no-edit', '-m', message, '--end-of-options', branch], { okExitCodes: [0, 1, 2, 128] });
  if (r.exitCode === 0) {
    const sha = await git.revParse('HEAD');
    // "Already up to date" also exits 0: report success only when the checkout actually moved.
    if (sha === before) return { ok: false, conflicts: [], error: `Nothing to merge: ${branch} has no commits that are not already in the main checkout.` };
    return { ok: true, conflicts: [], ...(sha ? { sha } : {}) };
  }
  const conflicted = (await git.out(['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
  const inMerge = await git.test(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  if (inMerge) await git.run(['merge', '--abort'], { okExitCodes: [0, 128] });
  if (conflicted.length) return { ok: false, conflicts: conflicted.sort() };
  const detail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 6).join('\n');
  return { ok: false, conflicts: [], error: detail || `git merge exited with ${r.exitCode}` };
}

export interface ConflictPrediction {
  conflicts: boolean;
  /** Conflicted paths (empty when clean). */
  files: string[];
  /** Tree oid git would write for the merge. */
  tree?: string;
}

/**
 * Would merging `a` and `b` conflict? Uses `git merge-tree --write-tree` (no checkout touched,
 * git ≥ 2.38). Exit code 1 means conflicts. Only committed changes are considered.
 */
export async function predictConflicts(repo: Repo, a: string, b: string): Promise<ConflictPrediction> {
  const git = toGit(repo);
  const r = await git.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], { okExitCodes: [0, 1] });
  // Output: <tree>\0<file>\0<file>\0 [\0 messages]
  const head = r.stdout.split('\0\0')[0] ?? '';
  const [tree, ...files] = head.split('\0').filter(Boolean);
  return { conflicts: r.exitCode === 1, files: r.exitCode === 1 ? [...new Set(files)].sort() : [], tree };
}
