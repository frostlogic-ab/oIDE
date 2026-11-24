import type { MainContext } from '../context.js';
import { createCoreServices, type Services } from './core.js';
import { electronPlatform, handleArtifactScheme, handleExtensionScheme } from './electron-platform.js';
import { TerminalService } from './terminals.js';

export type { Services } from './core.js';

/**
 * Seam for domain services. The domain layer lives in `core.ts` and runs in plain Node
 * (test/integration); this wrapper injects the Electron pieces (`electron-platform.ts`):
 * safeStorage, dialogs, notifications, utility processes and the artifact preview protocol.
 */
export async function createServices(ctx: MainContext): Promise<Services> {
  const terminals = new TerminalService({ emit: ctx.emit });
  ctx.onQuit(() => terminals.disposeAll());
  const services = await createCoreServices({ ctx, platform: electronPlatform(ctx, terminals), terminals });
  handleArtifactScheme(services.artifacts);
  handleExtensionScheme((origin) => services.extensions.uiSite(origin));
  ctx.onQuit(() => services.dispose());
  return services;
}
