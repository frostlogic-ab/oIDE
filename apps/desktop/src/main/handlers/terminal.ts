import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import { IpcError } from '../ipc/router.js';
import { detectScripts } from '../services/scripts.js';
import type { Services } from '../services/index.js';

export function registerTerminalHandlers(router: IpcRouter, { terminals }: Services, ctx: MainContext): void {
  router.register('terminal.create', ({ cwd, cols, rows }) => {
    // SEC-05: an interactive shell only (no renderer-chosen command line), and only inside a known
    // project or agent worktree, never app-data, artifact or extension folders.
    const realCwd = ctx.roots.assertAllowed(cwd, ['project', 'worktree']);
    return terminals.create({ cwd: realCwd, cols, rows });
  });
  // Files › Run: scripts are read from the checkout's own files (package.json, Makefile…).
  router.register('scripts.list', ({ root }) => detectScripts(ctx.roots.assertAllowed(root, ['project', 'worktree'])));
  router.register('terminal.runScript', async ({ cwd, scriptId, cols, rows }) => {
    // SEC-05 holds: the renderer names a script, main finds it again in this checkout and builds
    // the command line from its own detection (plain-word names only), then types it into a new
    // interactive shell.
    const realCwd = ctx.roots.assertAllowed(cwd, ['project', 'worktree']);
    const script = (await detectScripts(realCwd)).find((s) => s.id === scriptId);
    if (!script) throw new IpcError('That script is no longer in this checkout.', 'not_found');
    const { terminalId } = await terminals.create({ cwd: realCwd, cols, rows, input: `${script.command}\r` });
    return { terminalId, script };
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
