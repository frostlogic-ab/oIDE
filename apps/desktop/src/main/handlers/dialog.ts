import { dialog } from 'electron';
import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

export function registerDialogHandlers(router: IpcRouter, _services: Services, ctx: MainContext): void {
  router.register('dialog.pickFolder', async ({ title }) => {
    const win = ctx.getWindow();
    const options: Electron.OpenDialogOptions = {
      title: title ?? 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}
