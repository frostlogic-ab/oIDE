import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

export function registerTerminalHandlers(router: IpcRouter, { terminals }: Services, ctx: MainContext): void {
  router.register('terminal.create', ({ cwd, command, cols, rows }) => {
    // A renderer may only open terminals inside a known project, worktree or artifact folder.
    const realCwd = ctx.roots.assertAllowed(cwd);
    return terminals.create({ cwd: realCwd, command, cols, rows });
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
