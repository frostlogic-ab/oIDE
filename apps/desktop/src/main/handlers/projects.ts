import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

const OK = { ok: true as const };

/** projects.* and scope.* */
export function registerProjectHandlers(router: IpcRouter, s: Services, _ctx: MainContext): void {
  router.register('projects.list', () => s.projects.list());
  // No path: native folder picker. First open asks for trust with a native dialog (see security.md).
  router.register('projects.open', ({ path }) => s.projects.open(path));
  router.register('projects.remove', async ({ projectId }) => {
    await s.projects.remove(projectId);
    return OK;
  });
  router.register('projects.trust', ({ projectId, trusted }) => s.projects.trust(projectId, trusted));
  // New project: picked folders only (SEC-08); clones ask for trust, new repositories are trusted.
  router.register('projects.initFolder', ({ path, commitFiles }) => s.projects.initFolder(path, commitFiles));
  router.register('projects.create', ({ parent, name, readme }) => s.projects.create(parent, name, readme));
  router.register('projects.clone', ({ url, parent, name }) => s.projects.clone(url, parent, name));
  router.register('projects.cancelClone', () => {
    s.projects.cancelClone();
    return OK;
  });
  router.register('projects.githubRepos', () => s.projects.githubRepos());

  router.register('scope.get', () => s.store.ui.scope());
  // Each window keeps its own scope (docs/wiki/pages/windows.md): the last choice is saved, so new
  // windows and the next launch start on it, but it is not pushed into the other open windows.
  router.register('scope.set', ({ scope }) => {
    if (scope !== 'all' && !s.projects.get(scope)) throw new IpcError(`Unknown project ${scope}`, 'not_found');
    return s.store.ui.setScope(scope);
  });
}

/** cli.* */
export function registerCliHandlers(router: IpcRouter, s: Services, ctx: MainContext): void {
  router.register('cli.detect', () => s.cli.detect());
  // Sign-in only through Anthropic's own flow: a terminal running the user's `claude`.
  router.register('cli.openSignIn', async () => {
    const info = await s.cli.ensure();
    // Quoted for the user's shell (PowerShell on Windows, a POSIX shell elsewhere); no other input.
    const p = info.found && info.path && !/\.(mjs|cjs|js)$/i.test(info.path) ? info.path : undefined;
    const command = !p ? 'claude' : ctx.platform === 'win32' ? `& '${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, `'\\''`)}'`;
    return s.platform.terminals.create({ cwd: ctx.userDataDir, command });
  });
}
