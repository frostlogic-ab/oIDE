import { plainFs, plainFsPromises } from './plain-fs.js';
import { dirname, join } from 'node:path';
import { WorktreeInfo } from '@oide/protocol';
import { diffStat, changedFiles } from './diff.js';
import { status } from './status.js';
import { Git, GitError, isSafeRef, runShellCommand, toGit, type Repo, type StreamResult } from './git.js';
import { fromGitPath, isInside, pathKey, samePath, worktreeRoot } from './paths.js';

// Not node:fs: in Electron it treats `*.asar` files as folders and keeps them open (plain-fs.ts).
const { existsSync } = plainFs;
const { mkdir, readdir, rm } = plainFsPromises;

/** Branch prefix for every agent branch. */
export const BRANCH_PREFIX = 'oide/';

export interface WorktreeEntry {
  path: string;
  head?: string;
  /** Short branch name (`oide/foo`), undefined when detached. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  /** The first entry: the main checkout. */
  main: boolean;
}

export interface OrphanWorktree extends WorktreeEntry {
  /** False for a leftover folder under our worktree root that git no longer knows about. */
  registered: boolean;
}

export type WorktreeBase = 'main' | 'current' | (string & {});

export interface CreateWorktreeOptions {
  projectPath: string;
  projectId: string;
  /** Wanted slug; made safe and unique (`-2`, `-3`, …). */
  agentSlug: string;
  /** `main` = the default branch, `current` = the main checkout's current branch, or any ref. */
  base: WorktreeBase;
  location?: 'app-data' | 'sibling';
}

export interface CreatedWorktree {
  path: string;
  /** `oide/<slug>` */
  branch: string;
  slug: string;
  /** Ref the branch was created from, as used for later diffs (`main`, `origin/main`, a sha). */
  baseRef: string;
  baseSha: string;
}

export interface WorktreeManagerOptions {
  /** Electron `userData` (`<app-data>`). Worktrees go to `<app-data>/worktrees/<project-id>/<slug>`. */
  appDataDir: string;
  gitBinary?: string;
  timeoutMs?: number;
  /** Default location when `create` does not say. */
  location?: 'app-data' | 'sibling';
  /**
   * Injected for tests: the waits between delete retries of a held folder (`removeTree`). Long
   * paths and junctions no longer cost any (git's errors used to be backed off for ~9 s).
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Parse `git worktree list --porcelain -z`. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const line of text.split('\0')) {
    if (line === '') {
      if (cur) out.push(cur);
      cur = undefined;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: fromGitPath(value), detached: false, bare: false, locked: false, prunable: false, main: out.length === 0 };
    } else if (!cur) continue;
    else if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** Lower-case, ASCII, dash-separated, ≤ 48 chars. Never empty. */
export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'agent';
}

/**
 * A delete error that means "a program holds a file or folder open" (as opposed to a refusal, a
 * permissions problem or git giving up on long paths / junctions): `EBUSY`, or the Windows
 * sharing-violation text. Only these are worth waiting for.
 */
export function isLockError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; stderr?: unknown } | null;
  if (e?.code === 'EBUSY') return true;
  return /\bEBUSY\b|resource busy|being used by another process|sharing violation/i.test(`${String(e?.message ?? err)} ${String(e?.stderr ?? '')}`);
}

const RETRY_DELETE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

/**
 * `fs.rm(recursive)` of a folder tree, retried as a whole `retries` times (linear `delayMs`) on
 * errors that may clear (a held file, a running exe, a file being written). Not `fs.rm`'s own
 * `maxRetries`: it retries per directory level, so one held folder deep in a pnpm tree multiplied
 * the waits and the delete hung for minutes. `fs.rm` removes junctions and symlinks without
 * following them, and handles paths over 260 characters.
 */
export async function removeTree(path: string, opts: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const retries = opts.retries ?? 5;
  const delay = opts.delayMs ?? 300;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= retries || !code || !RETRY_DELETE_CODES.has(code)) throw err;
      await sleep(delay * (attempt + 1));
    }
  }
}

export class WorktreeManager {
  private readonly appDataDir: string;
  private readonly gitBinary: string | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly defaultLocation: 'app-data' | 'sibling';
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * One `create` at a time per project: picking a free slug and `git worktree add` are not atomic, so
   * parallel attempts whose titles slug the same (long titles cut the `#1` / `#2` suffix) raced and
   * the loser failed with "cannot lock ref … reference already exists".
   */
  private readonly createLocks = new Map<string, Promise<unknown>>();

  constructor(opts: WorktreeManagerOptions) {
    this.appDataDir = opts.appDataDir;
    this.gitBinary = opts.gitBinary;
    this.timeoutMs = opts.timeoutMs;
    this.defaultLocation = opts.location ?? 'app-data';
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  git(cwd: string): Git {
    return new Git({ cwd, gitBinary: this.gitBinary, timeoutMs: this.timeoutMs });
  }

  /** Folder that holds this project's worktrees. */
  root(projectId: string, projectPath: string, location: 'app-data' | 'sibling' = this.defaultLocation): string {
    return worktreeRoot({ appDataDir: this.appDataDir, projectId, projectPath, location });
  }

  /** The default branch: `origin/HEAD`, else local `main`, else `master`, else `init.defaultBranch`, else current. */
  async defaultBranch(projectPath: string): Promise<string> {
    return defaultBranch(this.git(projectPath));
  }

  async create(opts: CreateWorktreeOptions): Promise<CreatedWorktree> {
    const key = pathKey(opts.projectPath);
    const prev = this.createLocks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.createUnlocked(opts));
    this.createLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.createLocks.get(key) === run) this.createLocks.delete(key);
    }
  }

  private async createUnlocked(opts: CreateWorktreeOptions): Promise<CreatedWorktree> {
    const git = this.git(opts.projectPath);
    if (!(await git.revParse('HEAD'))) throw new Error('The project has no commits yet. Make a first commit before starting an agent in a worktree.');
    const baseRef = await this.resolveBase(git, opts.base);
    const baseSha = await git.revParse(baseRef);
    if (!baseSha) throw new Error(`Unknown base ref: ${baseRef}`);

    const root = this.root(opts.projectId, opts.projectPath, opts.location);
    const registered = (await this.list(opts.projectPath)).map((w) => pathKey(w.path));
    const base = slugify(opts.agentSlug);
    let slug = base;
    for (let n = 2; ; n++) {
      const path = join(root, slug);
      const taken = (await git.branchExists(BRANCH_PREFIX + slug)) || existsSync(path) || registered.includes(pathKey(path));
      if (!taken) break;
      slug = `${base}-${n}`;
      if (n > 999) throw new Error('Could not find a free worktree name.');
    }
    const path = join(root, slug);
    const branch = BRANCH_PREFIX + slug;
    await mkdir(dirname(path), { recursive: true });
    if (!isSafeRef(baseRef)) throw new Error(`Invalid base ref: ${baseRef}`);
    await git.run(['worktree', 'add', '-b', branch, '--', path, baseRef], { timeoutMs: 10 * 60_000 });
    return { path, branch, slug, baseRef, baseSha };
  }

  private async resolveBase(git: Git, base: WorktreeBase): Promise<string> {
    if (base === 'main') {
      const name = await defaultBranch(git);
      if (await git.branchExists(name)) return name;
      if (await git.revParse(`origin/${name}`)) return `origin/${name}`;
      return name;
    }
    if (base === 'current') {
      return (await git.currentBranch()) ?? (await git.revParse('HEAD'))!;
    }
    return base;
  }

  async list(projectPath: string): Promise<WorktreeEntry[]> {
    const out = await this.git(projectPath).out(['worktree', 'list', '--porcelain', '-z']);
    return parseWorktreeList(out);
  }

  /**
   * Remove a worktree: git's own safety checks, then oIDE deletes the folder, then
   * `git worktree prune`.
   *
   * The folder is not deleted with `git worktree remove`: on Windows git (2.51) follows directory
   * junctions, so a pnpm-style `node_modules` junction to a folder outside the worktree had that
   * folder's files deleted; and it fails on paths over 260 characters ("Filename too long") or
   * leaves "Directory not empty" behind. `removeTree` (`fs.rm`) removes junctions without following
   * them, handles long paths, and retries `EBUSY`/`EPERM`/`ENOTEMPTY` (`retries` × linear `delayMs`,
   * through the injected `sleep`).
   *
   * Without `force`, the checks `git worktree remove` makes before it deletes anything still apply:
   * a locked worktree, or one with modified or untracked files (`git status --porcelain
   * --ignore-submodules=none`; ignored files such as `node_modules` do not count), is refused and
   * left untouched. Errors are thrown as they are; `isLockError` tells a held file from the rest.
   */
  async remove(projectPath: string, worktreePath: string, opts: { force?: boolean; deleteBranch?: boolean; retries?: number; delayMs?: number } = {}): Promise<void> {
    const git = this.git(projectPath);
    const entries = await this.list(projectPath);
    const entry = entries.find((w) => samePath(w.path, worktreePath));
    if (entry?.main) throw new Error('Refusing to remove the main checkout.');
    const retries = opts.retries ?? 5;
    const delay = opts.delayMs ?? 300;
    const del = (p: string) => removeTree(p, { retries, delayMs: delay, sleep: this.sleep });
    if (entry) {
      if (existsSync(entry.path)) {
        if (!opts.force) await this.assertRemovable(entry);
        else if (entry.locked) await git.run(['worktree', 'unlock', '--', entry.path], { okExitCodes: [0, 128] });
        await del(entry.path);
      } else if (entry.locked && opts.force) {
        await git.run(['worktree', 'unlock', '--', entry.path], { okExitCodes: [0, 128] });
      }
    } else if (existsSync(worktreePath) && opts.force) {
      await del(worktreePath);
    }
    await git.run(['worktree', 'prune']);
    if (opts.deleteBranch && entry?.branch) {
      await git.run(['branch', '-D', entry.branch], { okExitCodes: [0, 1] });
    }
  }

  /** What `git worktree remove` (without `--force`) checks before it deletes anything. Throws a `GitError`. */
  private async assertRemovable(entry: WorktreeEntry): Promise<void> {
    const args = ['worktree', 'remove', entry.path];
    if (entry.locked) {
      throw new GitError(`git worktree failed: cannot remove a locked working tree; unlock it first or remove it with force`, args, 128, `fatal: cannot remove a locked working tree`, '');
    }
    const st = await this.git(entry.path).out(['status', '--porcelain', '-z', '--ignore-submodules=none'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
    if (st.length) {
      const msg = `'${entry.path}' contains modified or untracked files, use --force to delete it`;
      throw new GitError(`git worktree failed: ${msg}`, args, 128, `fatal: ${msg}`, '');
    }
  }

  /** `git worktree prune`; returns git's verbose lines. */
  async prune(projectPath: string): Promise<string[]> {
    const r = await this.git(projectPath).run(['worktree', 'prune', '-v']);
    return (r.stderr + r.stdout).split(/\r?\n/).filter(Boolean);
  }

  /**
   * Worktrees under oIDE's folders for this project (app-data and sibling roots) that no known agent
   * owns, plus leftover folders there that git no longer lists.
   */
  async orphans(projectPath: string, projectId: string, knownPaths: string[]): Promise<OrphanWorktree[]> {
    const known = new Set(knownPaths.map(pathKey));
    const roots = [this.root(projectId, projectPath, 'app-data'), this.root(projectId, projectPath, 'sibling')];
    const entries = await this.list(projectPath);
    const out: OrphanWorktree[] = [];
    for (const w of entries) {
      if (w.main || known.has(pathKey(w.path))) continue;
      if (roots.some((r) => isInside(r, w.path))) out.push({ ...w, registered: true });
    }
    const registered = new Set(entries.map((w) => pathKey(w.path)));
    for (const root of roots) {
      let names: string[];
      try {
        names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        continue;
      }
      for (const name of names) {
        const p = join(root, name);
        if (registered.has(pathKey(p)) || known.has(pathKey(p))) continue;
        out.push({ path: p, detached: false, bare: false, locked: false, prunable: true, main: false, registered: false });
      }
    }
    return out;
  }

  /** Run the project's setup command in a worktree, streaming output. The caller checks workspace trust. */
  runSetup(worktreePath: string, command: string, opts: { onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<StreamResult> {
    return runShellCommand(worktreePath, command, opts);
  }

  aheadBehind(cwd: string, branch: string, base: string): Promise<{ ahead: number; behind: number }> {
    return aheadBehind(this.git(cwd), branch, base);
  }

  /** Everything Source control shows for one agent worktree. */
  async info(opts: { projectId: string; path: string; branch: string; baseRef: string; agentId?: string }): Promise<WorktreeInfo> {
    const git = this.git(opts.path);
    if (!existsSync(opts.path)) {
      return WorktreeInfo.parse({ ...opts, orphaned: true });
    }
    const [ab, diff, files, push] = await Promise.all([
      aheadBehind(git, 'HEAD', opts.baseRef).catch(() => ({ ahead: 0, behind: 0 })),
      diffStat(git, opts.baseRef).catch(() => undefined),
      changedFiles(git, opts.baseRef).catch(() => [] as string[]),
      pushState(git, opts.branch).catch(() => ({ uncommitted: 0 })),
    ]);
    return WorktreeInfo.parse({ ...opts, ahead: ab.ahead, behind: ab.behind, diff, changedFiles: files, ...push });
  }
}

/**
 * What "Push to PR" would send: commits on HEAD that the branch's own remote branch (the PR head)
 * lacks, and files with uncommitted changes. The remote branch is the upstream when it carries the
 * branch's name, else `origin/<branch>`: a worktree made from `origin/main` may track `origin/main`,
 * which is not where its PR lives. `unpushed` is absent when the branch was never pushed.
 */
export async function pushState(repo: Repo, branch: string): Promise<{ unpushed?: number; uncommitted: number }> {
  const git = toGit(repo);
  const st = await status(git);
  const uncommitted = st.entries.filter((e) => e.kind !== 'ignored').length;
  const name = branch.replace(/^refs\/heads\//, '');
  if (st.upstream && st.upstream.endsWith(`/${name}`)) return { unpushed: st.ahead, uncommitted };
  if (!isSafeRef(name)) return { uncommitted };
  const remote = `refs/remotes/origin/${name}`;
  if (!(await git.test(['rev-parse', '--verify', '--quiet', remote]))) return { uncommitted };
  const out = await git.out(['rev-list', '--count', `${remote}..HEAD`, '--']);
  return { unpushed: Number(out.trim()) || 0, uncommitted };
}

/** `git rev-list --left-right --count <base>...<branch>`: commits only on branch (ahead) and only on base (behind). */
export async function aheadBehind(repo: Repo, branch: string, base: string): Promise<{ ahead: number; behind: number }> {
  const out = await toGit(repo).out(['rev-list', '--left-right', '--count', `${base}...${branch}`, '--']);
  const [behind, ahead] = out.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export async function defaultBranch(repo: Repo): Promise<string> {
  const git = toGit(repo);
  const r = await git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { okExitCodes: [0, 1, 128] });
  const remoteHead = r.exitCode === 0 ? r.stdout.trim() : '';
  if (remoteHead.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  for (const name of ['main', 'master']) if (await git.branchExists(name)) return name;
  const cfg = await git.run(['config', '--get', 'init.defaultBranch'], { okExitCodes: [0, 1] });
  const configured = cfg.stdout.trim();
  if (configured && (await git.branchExists(configured))) return configured;
  return (await git.currentBranch()) ?? 'main';
}
