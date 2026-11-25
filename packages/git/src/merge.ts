import { toGit, type Git, type Repo } from './git.js';

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
  /**
   * The main checkout had uncommitted changes in the way: they were stashed, the branch merged, and
   * the stash re-applied. `restored: false` means re-applying clashed with the merge: the files were
   * left as merged and the changes stay in the stash named `stash` (`git stash list`).
   */
  autoStash?: { files: string[]; restored: boolean; stash?: string };
}

/** git refuses to merge over local changes: "Your local changes to the following files would be overwritten by merge". */
export function parseBlockedByLocalChanges(stderr: string): string[] | undefined {
  // Tracked and untracked files come as two separate refusals in one stderr. git indents each file
  // (a tab, or two spaces for staged files); the lines after the list ("Please …", "Aborting",
  // "Merge with strategy ort failed.") are not indented.
  const re = /(?:local changes to the following files|untracked working tree files) would be overwritten by merge:\r?\n((?:[ \t]+[^\r\n]*\r?\n?)+)/g;
  const files: string[] = [];
  for (const m of stderr.matchAll(re)) {
    for (const l of m[1]!.split(/\r?\n/)) if (l.trim()) files.push(l.trim());
  }
  return files.length ? [...new Set(files)] : undefined;
}

type MergeAttempt = { merged: true; sha?: string } | { merged: false; result: MergeResult; blockedBy?: string[] };

/** One `git merge --no-ff`; on any failure the checkout is left as it was (merge aborted). */
async function attemptMerge(git: Git, branch: string, message: string): Promise<MergeAttempt> {
  const before = await git.revParse('HEAD');
  const r = await git.run(['merge', '--no-ff', '--no-edit', '-m', message, '--end-of-options', branch], { okExitCodes: [0, 1, 2, 128] });
  if (r.exitCode === 0) {
    const sha = await git.revParse('HEAD');
    // "Already up to date" also exits 0: report success only when the checkout actually moved.
    if (sha === before) return { merged: false, result: { ok: false, conflicts: [], error: `Nothing to merge: ${branch} has no commits that are not already in the main checkout.` } };
    return { merged: true, ...(sha ? { sha } : {}) };
  }
  const conflicted = (await git.out(['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
  const inMerge = await git.test(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  if (inMerge) await git.run(['merge', '--abort'], { okExitCodes: [0, 128] });
  if (conflicted.length) return { merged: false, result: { ok: false, conflicts: conflicted.sort() } };
  const blockedBy = parseBlockedByLocalChanges(r.stderr);
  if (blockedBy) return { merged: false, blockedBy, result: { ok: false, conflicts: [], blockedBy, error: blockedMessage(blockedBy) } };
  const detail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 6).join('\n');
  return { merged: false, result: { ok: false, conflicts: [], error: detail || `git merge exited with ${r.exitCode}` } };
}

function fileList(files: string[]): string {
  return files.slice(0, 5).join(', ') + (files.length > 5 ? `, and ${files.length - 5} more` : '');
}

function blockedMessage(files: string[]): string {
  return `The main checkout has uncommitted changes that the merge would overwrite (${fileList(files)}). Commit or stash them, then merge again. Nothing was changed.`;
}

/**
 * Stash only `files` (tracked or untracked), so the rest of the main checkout is left alone.
 * Returns the stash commit, or undefined when git would not stash them.
 */
async function stashFiles(git: Git, files: string[], message: string): Promise<string | undefined> {
  const before = await git.revParse('refs/stash');
  const r = await git.run(['stash', 'push', '--include-untracked', '-m', message, '--pathspec-from-file=-', '--pathspec-file-nul'], {
    input: files.map((f) => `:(literal)${f}`).join('\0'),
    okExitCodes: [0, 1, 128],
  });
  const after = await git.revParse('refs/stash');
  return r.exitCode === 0 && after && after !== before ? after : undefined;
}

/** Drop the stash entry whose commit is `sha` (looked up by commit, so other stashes are never touched). */
async function dropStash(git: Git, sha: string): Promise<void> {
  const list = (await git.out(['stash', 'list', '--format=%H'])).split(/\r?\n/);
  const i = list.indexOf(sha);
  if (i >= 0) await git.run(['stash', 'drop', '--quiet', `stash@{${i}}`], { okExitCodes: [0, 1] });
}

/**
 * Re-apply a stash made by `stashFiles`. When it clashes with the working tree, undo the partial
 * apply (`git reset --merge` resets what the apply staged or left unmerged and keeps unrelated local
 * changes) and keep the stash, so nothing is lost and the checkout is never left with conflict markers.
 */
async function restoreStash(git: Git, sha: string): Promise<boolean> {
  const r = await git.run(['stash', 'apply', '--quiet', sha], { okExitCodes: [0, 1, 128] });
  if (r.exitCode === 0) {
    await dropStash(git, sha);
    return true;
  }
  await git.run(['reset', '--quiet', '--merge'], { okExitCodes: [0, 1, 128] });
  return false;
}

/**
 * Merge an agent branch into the main checkout with `git merge --no-ff`. On conflicts the merge is
 * aborted and the conflicted files are reported, so the main checkout is never left mid-merge.
 *
 * When uncommitted changes in the main checkout are in the way, those files (only those) are
 * stashed, the merge is retried and the stash re-applied (`autoStash`). If the merge still fails,
 * the stash is put back on the unchanged checkout. Pass `autoStash: false` to refuse instead.
 */
export async function mergeLocal(mainCheckout: Repo, branch: string, opts: { message?: string; autoStash?: boolean } = {}): Promise<MergeResult> {
  const git = toGit(mainCheckout);
  if (await git.test(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])) {
    return { ok: false, conflicts: [], error: 'A merge is already in progress in the main checkout.' };
  }
  if (!(await git.revParse(branch))) return { ok: false, conflicts: [], error: `Unknown branch: ${branch}` };
  const message = opts.message ?? `Merge ${branch}`;
  const first = await attemptMerge(git, branch, message);
  if (first.merged) return { ok: true, conflicts: [], ...(first.sha ? { sha: first.sha } : {}) };
  if (!first.blockedBy || opts.autoStash === false) return first.result;

  const files = first.blockedBy;
  const stashName = `oide: local changes set aside to merge ${branch}`;
  const stash = await stashFiles(git, files, stashName);
  if (!stash) return first.result;
  const second = await attemptMerge(git, branch, message);
  const restored = await restoreStash(git, stash);
  const autoStash = { files, restored, ...(restored ? {} : { stash: stashName }) };
  if (second.merged) return { ok: true, conflicts: [], ...(second.sha ? { sha: second.sha } : {}), autoStash };
  // The merge failed and was aborted, so HEAD did not move and the stash goes back cleanly.
  const kept = restored ? '' : ` Your uncommitted changes could not be put back; they are kept in the stash "${stashName}".`;
  return { ...second.result, ...(second.result.error ? { error: second.result.error + kept } : {}), autoStash };
}

/** Human summary of an auto-stash, for the caller's success message. */
export function autoStashNote(s: NonNullable<MergeResult['autoStash']>): string {
  return s.restored
    ? `Your uncommitted changes to ${fileList(s.files)} were set aside for the merge and put back.`
    : `Your uncommitted changes to ${fileList(s.files)} clash with the merge, so those files are left as merged. Your changes are kept in the stash "${s.stash}": run git stash pop in the project folder to bring them back.`;
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
