import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

export function registerTerminalHandlers(router: IpcRouter, { terminals }: Services, ctx: MainContext): void {
  router.register('terminal.create', ({ cwd, cols, rows }) => {
    // SEC-05: an interactive shell only (no renderer-chosen command line), and only inside a known
    // project or agent worktree, never app-data, artifact or extension folders.
    const realCwd = ctx.roots.assertAllowed(cwd, ['project', 'worktree']);
    return terminals.create({ cwd: realCwd, cols, rows });
  });
  router.register('terminal.write', ({ terminalId, data }) => {
    terminals.write(terminalId, data);
    return { ok: true as const };
  });
  router.register('terminal.resize', ({ terminalId, cols, rows }) => {
    terminals.resize(terminalId, cols, rows);
    return { ok: true as const };
  });
  router.register('terminal.kill', ({ terminalId }) => {
    terminals.kill(terminalId);
    return { ok: true as const };
  });
}
