import { assertInsideAny } from './paths.js';

export type RootKind = 'project' | 'worktree' | 'artifact' | 'app-data' | 'extension';

/**
 * The set of folders renderer-supplied paths may point into. Domain services register their
 * folders here (projects on open, worktrees on create, the artifact store on start) and remove
 * them when they go away. Handlers call `assertAllowed(path)` before touching the filesystem.
 */
export class AllowedRoots {
  private readonly roots = new Map<string, RootKind>();

  add(root: string, kind: RootKind): void {
    this.roots.set(root, kind);
  }

  remove(root: string): void {
    this.roots.delete(root);
  }

  list(kind?: RootKind): string[] {
    return [...this.roots.entries()].filter(([, k]) => !kind || k === kind).map(([r]) => r);
  }

  /** Returns the resolved real path, or throws `PathOutsideRootError`. */
  assertAllowed(candidate: string, kinds?: RootKind[]): string {
    const roots = [...this.roots.entries()].filter(([, k]) => !kinds || kinds.includes(k)).map(([r]) => r);
    return assertInsideAny(roots, candidate).path;
  }
}
