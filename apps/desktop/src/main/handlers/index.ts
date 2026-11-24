import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';
import { registerShellHandlers } from './shell.js';
import { registerDomainHandlers } from './domain.js';

export { registerDomainHandlers } from './domain.js';

/**
 * Seam for IPC handlers. One file per domain (`handlers/agents.ts`, `handlers/git.ts`, …), each
 * exporting `register<Domain>Handlers(router, services, ctx)`. Domain handlers never import
 * Electron (they run in plain Node in test/integration); `shell.ts` is the Electron-only part.
 */
export function registerAllHandlers(router: IpcRouter, services: Services, ctx: MainContext): void {
  registerDomainHandlers(router, services, ctx);
  registerShellHandlers(router, services, ctx);
}
