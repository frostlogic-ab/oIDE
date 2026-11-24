import { resolve } from 'node:path';
import { pathKey } from '@oide/git';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

const OK = { ok: true as const };

/** A path counts as user-picked only when the native dialog returned it in this session. */
export function wasPicked(s: Services, p: string): boolean {
  return s.picked.has(pathKey(resolve(p)));
}

/** extensions.* and custom.* */
export function registerExtensionHandlers(router: IpcRouter, s: Services, _ctx: MainContext): void {
  const x = s.extensions;
  router.register('extensions.installed', () => x.installed());
  router.register('extensions.index', ({ refresh }) => x.index(refresh));
  router.register('extensions.install', ({ name, version }) => x.install(name, version));
  router.register('extensions.uninstall', async ({ id }) => {
    await x.uninstall(id);
    return OK;
  });
  router.register('extensions.setEnabled', ({ id, projectId, enabled }) => x.setEnabled(id, enabled, projectId));
  // Folder extensions run unreviewed host code: only folders the user picked in the native dialog.
  router.register('extensions.addFromFolder', async ({ path, devMode }) => {
    let dir = path;
    if (dir) {
      if (!wasPicked(s, dir)) throw new IpcError('Pick the extension folder with the folder dialog first.', 'forbidden_path');
    } else {
      dir = (await s.platform.pickFolder('Add an extension from a folder')) ?? undefined;
      if (!dir) return null;
    }
    return x.addFromFolder(dir, devMode);
  });
  router.register('extensions.setToolEnabled', ({ id, tool, server, enabled }) => x.setToolEnabled(id, tool, enabled, server));
  router.register('extensions.addFromGit', ({ url }) => x.addFromGit(url));
  router.register('extensions.runCommand', ({ commandId, args }) => x.runCommand(commandId, args));
  router.register('extensions.updates', () => x.updates());
  router.register('extensions.update', ({ id, consent }) => x.update(id, consent));
  // Extension UI: panels and artifact viewers (sandboxed oide-ext:// iframes), settings fields, deploy targets.
  router.register('extensions.uiUrl', ({ extension, kind, id }) => x.uiUrl(extension, kind, id));
  router.register('extensions.panelMessage', async ({ extension, panelId, data }) => {
    await x.panelMessage(extension, panelId, data);
    return OK;
  });
  router.register('extensions.settings', ({ id }) => x.settingsFor(id));
  router.register('extensions.setSetting', async ({ id, key, value }) => {
    await x.setSetting(id, key, value);
    return OK;
  });
  router.register('extensions.runDeployTarget', ({ extension, targetId, agentId }) => x.runDeployTarget(extension, targetId, agentId));

  const c = x.custom;
  router.register('custom.list', () => c.list());
  router.register('custom.probeUrl', ({ url }) => c.probeUrl(url));
  router.register('custom.probeCommand', ({ command, args, env }) => c.probeCommand(command, args, env));
  router.register('custom.scanImports', () => c.scanImports());
  router.register('custom.importSelected', ({ items, savedTo, projects, allProjects }) => c.importSelected(items, { savedTo, projects, allProjects }));
  router.register('custom.setHeaderToken', async ({ id, header, token }) => {
    await c.setHeaderToken(id, header, token);
    return OK;
  });
  // Env values go to the keychain store; the record keeps only their names. Read per agent launch.
  router.register('custom.save', ({ server, secrets }) => c.save(server, secrets));
  router.register('custom.remove', async ({ id }) => {
    await c.remove(id);
    return OK;
  });
  router.register('custom.authorize', ({ id, clientId }) => c.authorize(id, clientId ? { clientId } : {}));
}
