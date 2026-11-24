import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Git, pathKey, samePath } from '@oide/git';
import type { Project } from '@oide/protocol';
import type { Store } from '@oide/store';
import type { MainContext } from '../context.js';
import { IpcError } from '../ipc/router.js';
import type { Platform } from './platform.js';

export type ProjectHook = (project: Project) => void | Promise<void>;

/**
 * Projects = git repositories the user opened. First open asks for workspace trust through a native
 * dialog in main (`Platform.confirmTrust`); "Not now" stores the project untrusted and the renderer can
 * call `projects.trust` later. Every project folder is registered in `ctx.roots`.
 */
export class ProjectsService {
  private readonly opened = new Set<ProjectHook>();
  private readonly removed = new Set<ProjectHook>();
  private readonly trustChanged = new Set<ProjectHook>();

  constructor(
    private readonly o: { ctx: MainContext; store: Store; platform: Platform; /** `Services.picked` (native dialog picks this session). */ picked?: Set<string> },
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
    if (path !== undefined && !this.mayOpen(path)) throw new IpcError('Open projects with the folder picker.', 'forbidden_path');
    const picked = path ?? (await this.o.platform.pickFolder('Open a project (a git repository)'));
    if (!picked) return null;
    const abs = resolve(picked);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new IpcError(`Folder not found: ${abs}`, 'not_found');
    const git = new Git({ cwd: abs });
    if (!(await git.isRepo().catch(() => false))) throw new IpcError(`${abs} is not a git repository. Run \`git init\` there first.`, 'not_a_repo');
    const top = resolve(await git.topLevel());
    const existing = this.o.store.projects.byPath(top);
    if (existing) {
      this.o.store.projects.open(top);
      this.o.ctx.roots.add(existing.path, 'project');
      this.emitChanged();
      return existing;
    }
    const trusted = await this.o.platform.confirmTrust({ name: basename(top), path: top });
    const p = this.o.store.projects.open(top, { trusted });
    this.o.ctx.roots.add(p.path, 'project');
    await this.fire(this.opened, p);
    this.emitChanged();
    return p;
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
