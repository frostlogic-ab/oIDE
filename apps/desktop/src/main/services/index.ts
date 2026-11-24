import { join } from 'node:path';
import type { MainContext } from '../context.js';
import { createCoreServices, type Services } from './core.js';
import { electronPlatform, handleArtifactScheme, handleExtensionScheme } from './electron-platform.js';
import { TerminalService } from './terminals.js';
import { UpdaterService } from './updater.js';

export type { Services } from './core.js';

/**
 * Seam for domain services. The domain layer lives in `core.ts` and runs in plain Node
 * (test/integration); this wrapper injects the Electron pieces (`electron-platform.ts`):
 * safeStorage, dialogs, notifications, utility processes, the artifact preview protocol and the
 * auto-updater (`updater.ts`, off in dev builds).
 */
export async function createServices(ctx: MainContext): Promise<Services> {
  const terminals = new TerminalService({ emit: ctx.emit });
  ctx.onQuit(() => terminals.disposeAll());
  const services = await createCoreServices({ ctx, platform: electronPlatform(ctx, terminals), terminals });
  handleArtifactScheme(services.artifacts);
  handleExtensionScheme((origin) => services.extensions.uiSite(origin));
  services.updates = new UpdaterService({
    currentVersion: ctx.appVersion,
    platform: ctx.platform,
    isDev: ctx.isDev,
    settings: services.store.settings,
    emit: (status) => ctx.emit('updates.changed', status),
    log: ctx.log,
    stateFile: join(ctx.userDataDir, 'updates.json'),
  });
  services.updates.start();
  ctx.onQuit(() => services.updates?.dispose());
  ctx.onQuit(() => services.dispose());
  return services;
}
