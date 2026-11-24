import { shell } from 'electron';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { isAllowedExternalUrl } from '../security/external.js';
import type { Services } from '../services/index.js';

export function registerShellHandlers(router: IpcRouter, _services: Services, ctx: MainContext): void {
  router.register('shell.openExternal', async ({ url }) => {
    if (!isAllowedExternalUrl(url)) throw new IpcError('Only allow-listed https links can be opened', 'forbidden');
    await shell.openExternal(url);
    return { ok: true as const };
  });

  router.register('shell.revealPath', ({ path }) => {
    const real = ctx.roots.assertAllowed(path);
    shell.showItemInFolder(real);
    return { ok: true as const };
  });
}
