import type { Store } from '@oide/store';
import type { MainContext } from '../context.js';
import { createCoreServices, type Services } from './core.js';
import { electronPlatform, handleArtifactScheme } from './electron-platform.js';
import { TerminalService } from './terminals.js';

export type { Services } from './core.js';

/**
 * Seam for domain services. The domain layer lives in `core.ts` and runs in plain Node
 * (test/integration); this wrapper injects the Electron pieces (`electron-platform.ts`):
 * safeStorage, dialogs, notifications, utility processes and the artifact preview protocol.
 * `opts.store` is the database main opened with recovery prompts (reliability/db-recovery.ts).
 */
export async function createServices(ctx: MainContext, opts: { store?: Store } = {}): Promise<Services> {
  const terminals = new TerminalService({ emit: ctx.emit });
  ctx.onQuit(() => terminals.disposeAll(), 'terminals');
  const services = await createCoreServices({ ctx, platform: electronPlatform(ctx, terminals), terminals, ...(opts.store ? { store: opts.store } : {}) });
  handleArtifactScheme(services.artifacts);
  // In order: deny pending prompts and close the MCP server, stop agents (sessions resumable),
  // git watchers and in-flight git work, extension host, then the database (core.ts dispose()).
  ctx.onQuit(() => services.dispose(), 'services');
  return services;
}
