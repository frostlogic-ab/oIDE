import { resolve } from 'node:path';
import { pathKey } from '@oide/git';
import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

/**
 * Native pickers (through the injected platform). Picked paths are remembered for this session so
 * commands that act on a user-chosen path (artifacts.import, extensions.addFromFolder) accept them.
 * `dialog.pickCli` fills its own set (`pickedCli`), the only one that skips the CLI path
 * confirmation (SEC-29); its picks are not added to `picked`.
 */
export function registerDialogHandlers(router: IpcRouter, services: Services, _ctx: MainContext): void {
  const remember = (p: string | null) => {
    if (p) services.picked.add(pathKey(resolve(p)));
    return p;
  };
  router.register('dialog.pickFolder', async ({ title }) => remember(await services.platform.pickFolder(title)));
  router.register('dialog.pickFile', async ({ title, filters }) => remember(await services.platform.pickFile(title, filters)));
  router.register('dialog.pickCli', async () => {
    const p = await services.platform.pickFile('Choose the Claude Code CLI', []);
    if (p) services.pickedCli.add(pathKey(resolve(p)));
    return p;
  });
}
