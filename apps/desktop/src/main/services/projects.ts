import { existsSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Git, GitError, cloneRepo, pathKey, removeTree, samePath, type GhCli } from '@oide/git';
import { folderNameProblem, type CloneProgress, type GithubRepo, type Project } from '@oide/protocol';
import type { Store } from '@oide/store';
import type { MainContext } from '../context.js';
import { IpcError } from '../ipc/router.js';
import type { Platform } from './platform.js';

export type ProjectHook = (project: Project) => void | Promise<void>;

/**
 * Projects = git repositories the user opened. First open asks for workspace trust through a native
 * dialog in main (`Platform.confirmTrust`); "Not now" stores the project untrusted and the renderer can
 * call `projects.trust` later. Every project folder is registered in `ctx.roots`.
 *
 * New project (the renderer's "New project" dialog) adds three ways in besides opening a repo:
 * `initFolder` (git init in a plain folder), `create` (a new repository) and `clone`.
 */
export class ProjectsService {
  private readonly opened = new Set<ProjectHook>();
  private readonly removed = new Set<ProjectHook>();
  private readonly trustChanged = new Set<ProjectHook>();
  /** The running clone (one at a time), so `cancelClone` can stop it. */
  private cloning: AbortController | undefined;

  constructor(
    private readonly o: {
      ctx: MainContext;
      store: Store;
      platform: Platform;
      /** `Services.picked` (native dialog picks this session). */
      picked?: Set<string>;
      /** The user's GitHub CLI (Clone › From GitHub); a getter because GitService owns it. */
      gh?: () => GhCli | undefined;
    },
  ) {}

  onOpened(fn: ProjectHook): void {
    this.opened.add(fn);
  }
  onRemoved(fn: ProjectHook): void {
    this.removed.add(fn);
  }
  onTrustChanged(fn: ProjectHook): void {
    this.trustChanged.add(fn);
  }

  list(): Project[] {
    return this.o.store.projects.list();
  }

  get(id: string): Project | undefined {
    return this.o.store.projects.get(id);
  }

  require(id: string): Project {
    const p = this.get(id);
    if (!p) throw new IpcError(`Unknown project ${id}`, 'not_found');
    return p;
  }

  /** Register every stored project's folder (startup). */
  async restore(): Promise<Project[]> {
    const list = this.list();
    for (const p of list) {
      this.o.ctx.roots.add(p.path, 'project');
      await this.fire(this.opened, p);
    }
    return list;
  }

  /**
   * Open a folder (picker when `path` is omitted). Must be inside a git repository.
   *
   * SEC-08: an explicit `path` from the renderer is accepted only when the user picked it in a
   * native dialog this session, it is already a known project, or a test-only hook of an unpackaged
   * build lists it (`Platform.openablePaths`). Otherwise a compromised renderer could make main run
   * git in any folder and add it to the file-access roots.
   */
  async open(path?: string): Promise<Project | null> {
    if (path !== undefined && !this.mayOpen(path)) throw new IpcError('Open projects with the folder picker.', 'forbidden_path', 'forbidden_path');
    const picked = path ?? (await this.o.platform.pickFolder('Open a project (a git repository)'));
    if (!picked) return null;
    const abs = resolve(picked);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new IpcError(`Folder not found: ${abs}`, 'not_found');
    const git = new Git({ cwd: abs });
    if (!(await git.isRepo().catch(() => false))) {
      throw new IpcError(`${abs} is not a git repository. Initialize git there to use it as a project.`, 'not_a_repo', 'not_a_repo');
    }
    return this.register(resolve(await git.topLevel()));
  }

  /**
   * Initialise git in a picked folder that is not a repository (Open folder › "Initialize git"):
   * `git init` (on `main` unless `init.defaultBranch` says otherwise) and a first commit, with the
   * folder's files when `commitFiles` (an empty commit otherwise, or when everything is ignored), so
   * agents have a base to branch from. Asks for trust like any open. A folder that already is in a
   * repository just opens. Same SEC-08 rule as `open`.
   */
  async initFolder(path: string, commitFiles = true): Promise<Project> {
    if (!this.mayOpen(path)) throw new IpcError('Choose the folder with the folder picker.', 'forbidden_path', 'forbidden_path');
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new IpcError(`Folder not found: ${abs}`, 'not_found');
    const git = new Git({ cwd: abs });
    if (await git.isRepo().catch(() => false)) return (await this.open(abs))!;
    // A broken `.git` that is not a repository: never touch it.
    if (existsSync(join(abs, '.git'))) throw new IpcError(`${abs} has a .git that git cannot read. Fix or remove it first.`, 'conflict', 'exists');
    await this.requireIdentity(abs);
    try {
      await this.initRepo(git, async () => {
        if (commitFiles) await git.run(['add', '-A'], { timeoutMs: 5 * 60_000 });
      });
    } catch (err) {
      // Leave the folder as it was: only the .git oIDE just made goes.
      await removeTree(join(abs, '.git')).catch(() => undefined);
      throw this.gitFailure(err);
    }
    return this.register(abs);
  }

  /**
   * New repository `<parent>/<name>`: created (or an empty folder reused), `git init`, a README
   * (`readme`) or an empty first commit, then opened as a trusted project (the user just made it).
   */
  async create(parent: string, name: string, readme = true): Promise<Project> {
    const { target, existed } = await this.newTarget(parent, name);
    await this.requireIdentity(dirname(target));
    if (!existed) await mkdir(target);
    const git = new Git({ cwd: target });
    try {
      await this.initRepo(git, async () => {
        if (!readme) return;
        await writeFile(join(target, 'README.md'), `# ${name}\n`, { flag: 'wx' });
        await git.run(['add', '--', 'README.md']);
      });
    } catch (err) {
      await this.clearTarget(target, existed);
      throw this.gitFailure(err);
    }
    return this.register(target, true);
  }

  /**
   * Clone `url` into `<parent>/<name>` and open it. The new checkout asks for trust (someone else's
   * code; until trusted its hooks, filters and `.oide/` setup never run). One clone at a time;
   * progress streams as `projects.cloneProgress`. Cancelled → null. A failed or cancelled clone
   * removes the folder (or, for an empty folder that was there before, what git put in it).
   */
  async clone(url: string, parent: string, name: string): Promise<Project | null> {
    if (this.cloning) throw new IpcError('A clone is already running. Wait for it or cancel it first.', 'conflict');
    const ac = new AbortController();
    this.cloning = ac;
    let r: Awaited<ReturnType<typeof cloneRepo>>;
    let target: string;
    let existed: boolean;
    try {
      ({ target, existed } = await this.newTarget(parent, name));
      let last: CloneProgress | undefined;
      let lastAt = 0;
      this.o.ctx.emit('projects.cloneProgress', { phase: 'Connecting' });
      r = await cloneRepo({
        url,
        target,
        cwd: dirname(target),
        signal: ac.signal,
        onProgress: (p) => {
          const now = Date.now();
          // At most ~10 events a second per phase; a new phase and 100% always go out.
          if (last && last.phase === p.phase && p.percent !== 100 && (last.percent === p.percent || now - lastAt < 100)) return;
          last = { phase: p.phase.slice(0, 80), ...(p.percent !== undefined ? { percent: p.percent } : {}) };
          lastAt = now;
          this.o.ctx.emit('projects.cloneProgress', last);
        },
      });
    } finally {
      this.cloning = undefined;
    }
    if (!r.ok) {
      await this.clearTarget(target, existed);
      if (r.aborted) return null;
      throw new IpcError(r.message ?? 'git clone failed.', 'clone_failed', r.failure ?? 'other');
    }
    return this.register(target);
  }

  /** Stops the running clone (its `projects.clone` resolves null). No-op when none runs. */
  cancelClone(): void {
    this.cloning?.abort();
  }

  /** The user's GitHub repositories through their own `gh` (never its token). */
  async githubRepos(): Promise<{ available: boolean; reason?: string; repos: GithubRepo[] }> {
    const gh = this.o.gh?.();
    if (!gh) return { available: false, reason: 'The GitHub CLI is not available.', repos: [] };
    try {
      const repos = await gh.listRepos();
      if (!repos) return { available: false, reason: 'Install the GitHub CLI (gh) and run `gh auth login` to pick from your repositories.', repos: [] };
      return { available: true, repos };
    } catch (err) {
      return { available: false, reason: (err as Error).message, repos: [] };
    }
  }

  /** Stores (or re-opens) the checkout at `top`. New ones ask for trust unless `trusted` is given. */
  private async register(top: string, trusted?: boolean): Promise<Project> {
    const existing = this.o.store.projects.byPath(top);
    if (existing) {
      this.o.store.projects.open(top);
      this.o.ctx.roots.add(existing.path, 'project');
      this.emitChanged();
      return existing;
    }
    const trust = trusted ?? (await this.o.platform.confirmTrust({ name: basename(top), path: top }));
    const p = this.o.store.projects.open(top, { trusted: trust });
    this.o.ctx.roots.add(p.path, 'project');
    await this.fire(this.opened, p);
    this.emitChanged();
    return p;
  }

  /** `git init`, the branch name, `stage()`, then the first commit (empty when nothing is staged). */
  private async initRepo(git: Git, stage: () => Promise<void>): Promise<void> {
    const configured = (await git.run(['config', '--get', 'init.defaultBranch'], { okExitCodes: [0, 1] })).stdout.trim();
    await git.run(['init', '--quiet']);
    if (!configured) await git.run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await stage();
    await git.run(['commit', '--quiet', '--allow-empty', '--no-edit', '-m', 'Initial commit'], { timeoutMs: 5 * 60_000 });
  }

  /** A first commit needs a name and email: say so before anything is created. */
  private async requireIdentity(cwd: string): Promise<void> {
    const git = new Git({ cwd });
    const get = async (key: string) => (await git.run(['config', '--get', key], { okExitCodes: [0, 1] }).catch(() => ({ stdout: '' }))).stdout.trim();
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    if (name && email) return;
    throw new IpcError(
      'Git needs your name and email for the first commit. In a terminal, run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then try again.',
      'unavailable',
      'no_identity',
    );
  }

  private gitFailure(err: unknown): IpcError {
    if (err instanceof IpcError) return err;
    const stderr = err instanceof GitError ? err.stderr : '';
    if (/Please tell me who you are|Author identity unknown|empty ident/i.test(stderr)) {
      return new IpcError('Git needs your name and email for the first commit (`git config --global user.name` and `user.email`).', 'unavailable', 'no_identity');
    }
    return new IpcError((err as Error)?.message ?? String(err), 'internal');
  }

  /**
   * `<parent>/<name>` for a new checkout. SEC-08: `parent` must be a folder the user picked this
   * session or the folder that holds an open project, so a compromised renderer cannot make main
   * write anywhere. The target must not exist, or be an empty folder.
   */
  private async newTarget(parent: string, name: string): Promise<{ target: string; existed: boolean }> {
    const problem = folderNameProblem(name);
    if (problem) throw new IpcError(problem, 'invalid_input');
    const abs = resolve(parent);
    if (!this.mayUseParent(abs)) throw new IpcError('Choose the location with the folder picker.', 'forbidden_path', 'forbidden_path');
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new IpcError(`Folder not found: ${abs}`, 'not_found');
    const target = join(abs, name);
    // folderNameProblem refuses separators and dot names, so the target sits directly in `abs`.
    if (!samePath(dirname(target), abs)) throw new IpcError('Choose another name.', 'invalid_input');
    const st = await lstat(target).catch(() => undefined);
    if (!st) return { target, existed: false };
    if (!st.isDirectory() || (await readdir(target)).length > 0) {
      throw new IpcError(`${target} already exists. Choose another name or location.`, 'conflict', 'exists');
    }
    return { target, existed: true };
  }

  /** After a failed create or clone: the folder goes (or, if it was there before, what is in it now). */
  private async clearTarget(target: string, existed: boolean): Promise<void> {
    try {
      if (!existed) await removeTree(target);
      else for (const entry of await readdir(target)) await removeTree(join(target, entry));
    } catch (err) {
      this.o.ctx.log.warn('could not clean up after a failed new project', err);
    }
  }

  private mayUseParent(abs: string): boolean {
    const key = pathKey(abs);
    if (this.o.picked?.has(key)) return true;
    if (this.o.platform.openablePaths?.some((p) => pathKey(resolve(p)) === key)) return true;
    return this.list().some((p) => samePath(dirname(p.path), abs));
  }

  private mayOpen(path: string): boolean {
    const abs = resolve(path);
    const key = pathKey(abs);
    if (this.o.picked?.has(key)) return true;
    if (this.o.platform.openablePaths?.some((p) => pathKey(resolve(p)) === key)) return true;
    return this.list().some((p) => samePath(p.path, abs));
  }

  async trust(id: string, trusted: boolean): Promise<Project> {
    this.require(id);
    const p = this.o.store.projects.setTrusted(id, trusted);
    await this.fire(this.trustChanged, p);
    this.emitChanged();
    return p;
  }

  async remove(id: string): Promise<void> {
    const p = this.require(id);
    await this.fire(this.removed, p);
    this.o.store.projects.remove(id);
    this.o.ctx.roots.remove(p.path);
    const scope = this.o.store.ui.scope();
    if (scope === id) this.o.ctx.emit('scope.changed', this.o.store.ui.setScope('all'));
    this.emitChanged();
  }

  emitChanged(): void {
    this.o.ctx.emit('projects.changed', this.list());
  }

  private async fire(set: Set<ProjectHook>, p: Project): Promise<void> {
    for (const fn of set) {
      try {
        await fn(p);
      } catch (err) {
        this.o.ctx.log.warn('project hook failed', err);
      }
    }
  }
}
