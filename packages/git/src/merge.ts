import { toGit, type Repo } from './git.js';

export interface MergeResult {
  ok: boolean;
  /** Files that conflicted (the merge was aborted, the checkout is as before). */
  conflicts: string[];
  /** The merge commit on success. */
  sha?: string;
  /** Why the merge could not start or failed for another reason (e.g. local changes in the way). */
  error?: string;
  /** Files with uncommitted (or untracked) changes in the main checkout that the merge would overwrite. */
  blockedBy?: string[];
}

/** git refuses to merge over local changes: "Your local changes to the following files would be overwritten by merge". */
export function parseBlockedByLocalChanges(stderr: string): string[] | undefined {
  const m = /(?:local changes to the following files|untracked working tree files) would be overwritten by merge:\r?\n([\s\S]*?)(?:\r?\n(?:Please|Aborting|error:)|$)/.exec(stderr);
  if (!m) return undefined;
  return m[1]!
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
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
  const blockedBy = parseBlockedByLocalChanges(r.stderr);
  if (blockedBy) {
    const list = blockedBy.slice(0, 5).join(', ') + (blockedBy.length > 5 ? `, and ${blockedBy.length - 5} more` : '');
    return {
      ok: false,
      conflicts: [],
      blockedBy,
      error: `The main checkout has uncommitted changes that the merge would overwrite (${list}). Commit or stash them, then merge again. Nothing was changed.`,
    };
  }
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

/** One conflicted path from `git merge-tree --write-tree` (without `--name-only`). */
export interface MergeTreeConflicts {
  tree?: string;
  /** Every conflicted path, sorted. */
  files: string[];
  /** Conflicted paths git cannot merge line by line (`CONFLICT (binary)`). */
  binary: string[];
  /** Conflicted submodule pointers (mode 160000, or a `CONFLICT (submodule…)` message). */
  submodules: string[];
}

/**
 * Parse `git merge-tree --write-tree -z` output: `<tree>\0`, then `<mode> <oid> <stage>\t<path>\0`
 * per conflicted stage, an empty entry, then messages as `<n>\0<path>×n\0<type>\0<text>\0`. The
 * type strings ("CONFLICT (binary)", "Auto-merging", …) are documented as stable.
 */
export function parseMergeTree(stdout: string): MergeTreeConflicts {
  const parts = stdout.split('\0');
  const tree = parts[0] || undefined;
  const files = new Set<string>();
  const submodules = new Set<string>();
  const binary = new Set<string>();
  let i = 1;
  for (; i < parts.length && parts[i] !== ''; i++) {
    const m = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/.exec(parts[i]!);
    if (!m) continue;
    files.add(m[2]!);
    if (m[1] === '160000') submodules.add(m[2]!);
  }
  i++;
  while (i < parts.length) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || parts[i] === '') break;
    const paths = parts.slice(i + 1, i + 1 + n);
    const type = parts[i + 1 + n] ?? '';
    if (type === 'CONFLICT (binary)') for (const p of paths) binary.add(p);
    if (/^CONFLICT \(submodule/.test(type)) for (const p of paths) submodules.add(p);
    i += n + 3;
  }
  const only = (s: Set<string>) => [...s].filter((p) => files.has(p)).sort();
  return { ...(tree ? { tree } : {}), files: [...files].sort(), binary: only(binary), submodules: only(submodules) };
}

export interface MergeForecast {
  /** False when `git merge-tree --write-tree` could not run (git older than 2.38): no prediction. */
  supported: boolean;
  conflicts: boolean;
  files: string[];
  binary: string[];
  submodules: string[];
  /** The main checkout's branch (undefined on a detached HEAD) and its commit. */
  target: { branch?: string; sha: string };
  branchSha: string;
  /** Commits on the target that the branch does not have yet. */
  behind: number;
  /** Commits on the branch that the target does not have yet. */
  ahead: number;
  /** Why the prediction could not run (supported: false). */
  error?: string;
}

/**
 * What merging `branch` into the main checkout's HEAD would do, without touching any checkout:
 * conflicted files (with binary and submodule ones called out), and how far the branch is behind.
 * Falls back to `supported: false` when git is too old for `merge-tree --write-tree` (< 2.38).
 * Only committed changes are considered.
 */
export async function predictMerge(mainCheckout: Repo, branch: string): Promise<MergeForecast> {
  const git = toGit(mainCheckout);
  const [sha, branchSha, current] = await Promise.all([git.revParse('HEAD'), git.revParse(branch), git.currentBranch()]);
  if (!sha) throw new Error('The main checkout has no commits.');
  if (!branchSha) throw new Error(`Unknown branch: ${branch}`);
  const target = { ...(current && current !== 'HEAD' ? { branch: current } : {}), sha };
  const counts = await git.out(['rev-list', '--left-right', '--count', `${sha}...${branchSha}`, '--']).catch(() => '0 0');
  const [behind, ahead] = counts.trim().split(/\s+/).map((n) => Number(n) || 0);
  const base = { target, branchSha, behind: behind ?? 0, ahead: ahead ?? 0 };
  let r: { stdout: string; stderr: string; exitCode: number };
  try {
    r = await git.run(['merge-tree', '--write-tree', '-z', sha, branchSha], { okExitCodes: [0, 1] });
  } catch (err) {
    const detail = ((err as { stderr?: string }).stderr || (err as Error).message || '').trim().split(/\r?\n/)[0] ?? '';
    return { supported: false, conflicts: false, files: [], binary: [], submodules: [], ...base, error: detail || 'git merge-tree failed' };
  }
  if (r.exitCode === 0) return { supported: true, conflicts: false, files: [], binary: [], submodules: [], ...base };
  const parsed = parseMergeTree(r.stdout);
  return { supported: true, conflicts: true, files: parsed.files, binary: parsed.binary, submodules: parsed.submodules, ...base };
}
