import type { MainContext } from '../context.js';
import { TerminalService } from './terminals.js';

/**
 * Seam for domain services (wave 2). Add a field to `Services`, construct it in `createServices`,
 * register its folders with `ctx.roots` and its cleanup with `ctx.onQuit`. Handlers receive the
 * whole object in `registerAllHandlers(router, services, ctx)`.
 *
 * Planned: store (packages/store), supervisor (packages/agent-core), git (packages/git),
 * mcp (packages/mcp-server), extensions (packages/extension-host), projects, settings, artifacts.
 */
export interface Services {
  terminals: TerminalService;
}

export async function createServices(ctx: MainContext): Promise<Services> {
  const terminals = new TerminalService({ emit: ctx.emit });
  ctx.onQuit(() => terminals.disposeAll());

  return { terminals };
}
