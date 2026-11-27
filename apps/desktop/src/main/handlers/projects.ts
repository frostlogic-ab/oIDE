import type { CliInfo } from '@oide/protocol';
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
  router.register('cli.openSignIn', async () => s.platform.terminals.create({ cwd: ctx.userDataDir, command: signInCommand(await s.cli.ensure(), ctx.platform) }));
}

/** The user's `claude`, quoted for their shell (PowerShell on Windows, a POSIX shell elsewhere); no other input. */
function signInCommand(info: CliInfo, platform: NodeJS.Platform): string {
  const p = info.found && info.path && !/\.(mjs|cjs|js)$/i.test(info.path) ? info.path : undefined;
  return !p ? 'claude' : platform === 'win32' ? `& '${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** accounts.* (ADR 0021): Claude Code accounts, each its own CLAUDE_CONFIG_DIR. */
export function registerAccountHandlers(router: IpcRouter, s: Services, ctx: MainContext): void {
  router.register('accounts.add', ({ label }) => s.accounts.add(label));
  router.register('accounts.rename', ({ id, label }) => {
    s.accounts.rename(id, label);
    return OK;
  });
  router.register('accounts.remove', ({ id }) => {
    s.accounts.remove(id);
    return OK;
  });
  // Same flow as cli.openSignIn, with the account's CLAUDE_CONFIG_DIR. oIDE never reads what the
  // CLI writes in that folder.
  router.register('accounts.openSignIn', async ({ id }) => {
    const env = s.accounts.signInEnv(id);
    return s.platform.terminals.create({ cwd: ctx.userDataDir, command: signInCommand(await s.cli.ensure(), ctx.platform), env });
  });
  router.register('accounts.usage', () => s.accounts.snapshot());
}
