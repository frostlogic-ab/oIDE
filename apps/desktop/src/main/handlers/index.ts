import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';
import { registerAppHandlers } from './app.js';
import { registerDialogHandlers } from './dialog.js';
import { registerShellHandlers } from './shell.js';
import { registerTerminalHandlers } from './terminal.js';

/**
 * Seam for IPC handlers. One file per domain (`handlers/agents.ts`, `handlers/git.ts`, …), each
 * exporting `register<Domain>Handlers(router, services, ctx)`, called from here. Commands without
 * a handler answer `not_implemented`, so the renderer degrades gracefully.
 */
export function registerAllHandlers(router: IpcRouter, services: Services, ctx: MainContext): void {
  registerAppHandlers(router, services, ctx);
  registerShellHandlers(router, services, ctx);
  registerDialogHandlers(router, services, ctx);
  registerTerminalHandlers(router, services, ctx);
}
