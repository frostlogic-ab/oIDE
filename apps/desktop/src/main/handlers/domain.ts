import type { MainContext } from '../context.js';
import type { IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';
import { registerAgentHandlers } from './agents.js';
import { registerAppHandlers } from './app.js';
import { registerArtifactHandlers } from './artifacts.js';
import { registerDialogHandlers } from './dialog.js';
import { registerExtensionHandlers } from './extensions.js';
import { registerFileHandlers } from './files.js';
import { registerLspHandlers } from './lsp.js';
import { registerGitHandlers, registerReviewHandlers } from './git.js';
import { registerAccountHandlers, registerCliHandlers, registerProjectHandlers } from './projects.js';
import { registerSettingsHandlers } from './settings.js';
import { registerTelemetryHandlers } from './telemetry.js';
import { registerTerminalHandlers } from './terminal.js';
import { registerUpdateHandlers } from './updates.js';

/** Every handler that does not need Electron directly (Electron pieces come via `services.platform`). */
export function registerDomainHandlers(router: IpcRouter, services: Services, ctx: MainContext): void {
  registerAppHandlers(router, services, ctx);
  registerDialogHandlers(router, services, ctx);
  registerTerminalHandlers(router, services, ctx);
  registerCliHandlers(router, services, ctx);
  registerAccountHandlers(router, services, ctx);
  registerProjectHandlers(router, services, ctx);
  registerAgentHandlers(router, services, ctx);
  registerGitHandlers(router, services, ctx);
  registerReviewHandlers(router, services, ctx);
  registerFileHandlers(router, services, ctx);
  registerLspHandlers(router, services, ctx);
  registerSettingsHandlers(router, services, ctx);
  registerExtensionHandlers(router, services, ctx);
  registerArtifactHandlers(router, services, ctx);
  registerUpdateHandlers(router, services, ctx);
  registerTelemetryHandlers(router, services, ctx);
}
