import { resolve } from 'node:path';
import { z } from 'zod';
import { pathKey } from '@oide/git';
import { IPC_DROP_CHANNEL, type PickedAttachments } from '@oide/protocol';
import type { MainContext } from '../context.js';
import type { IpcMainLike, IpcRouter } from '../ipc/router.js';
import { readPickedFiles } from '../services/attachments.js';
import type { Services } from '../services/index.js';

/**
 * Native pickers (through the injected platform). Picked paths are remembered for this session so
 * commands that act on a user-chosen path (artifacts.import, extensions.addFromFolder, message
 * attachments) accept them. `dialog.pickCli` fills its own set (`pickedCli`), the only one that
 * skips the CLI path confirmation (SEC-29); its picks are not added to `picked`.
 */
export function registerDialogHandlers(router: IpcRouter, services: Services, _ctx: MainContext): void {
  const remember = (p: string | null) => {
    if (p) services.picked.add(pathKey(resolve(p)));
    return p;
  };
  router.register('dialog.pickFolder', async ({ title }) => remember(await services.platform.pickFolder(title)));
  router.register('dialog.pickFile', async ({ title, filters }) => remember(await services.platform.pickFile(title, filters)));
  // Attach file: images come back inline (≤ 5 MB), other files by path (≤ 25 MB); paths are registered as picked.
  router.register('dialog.pickFiles', async ({ title }) => {
    const { platform } = services;
    const paths = platform.pickFiles ? await platform.pickFiles(title) : [await platform.pickFile(title, [])].filter((p): p is string => !!p);
    return readPickedFiles(paths, services.picked);
  });
  router.register('dialog.pickCli', async () => {
    const p = await services.platform.pickFile('Choose the Claude Code CLI', []);
    if (p) services.pickedCli.add(pathKey(resolve(p)));
    return p;
  });
}

const DroppedPaths = z.array(z.string().min(1).max(4096)).max(50);

/**
 * The preload-only drop channel (`IPC_DROP_CHANNEL`). Preload sends the paths of real dropped or
 * pasted `File` objects (`webUtils.getPathForFile`); page code has no way to reach this channel, and
 * frames other than the app's own are refused. The paths are registered as picked, like a native pick.
 */
export function attachDropChannel(ipcMain: IpcMainLike, services: Pick<Services, 'picked'>, isTrustedSender: (frameUrl: string) => boolean): () => void {
  ipcMain.handle(IPC_DROP_CHANNEL, async (event, input): Promise<PickedAttachments> => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) throw new Error('Untrusted sender');
    const parsed = DroppedPaths.safeParse(input);
    if (!parsed.success) return { attachments: [], rejected: [{ name: 'Dropped files', reason: 'Drop at most 50 files at a time.' }] };
    return readPickedFiles(parsed.data, services.picked);
  });
  return () => ipcMain.removeHandler(IPC_DROP_CHANNEL);
}
