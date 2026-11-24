import type { BrowserWindow } from 'electron';
import type { AgentEvent } from '@oide/protocol';
import type { Emit, FrameBatcher } from './ipc/emit.js';
import type { Logger } from './ipc/router.js';
import type { ReliabilityContext } from './reliability/index.js';
import type { AllowedRoots } from './security/roots.js';

/**
 * Everything a service or handler may need from the shell. Created once in src/main/index.ts and
 * passed to `createServices(ctx)` and `registerAllHandlers(router, services, ctx)`.
 */
export interface MainContext {
  isDev: boolean;
  platform: NodeJS.Platform;
  appVersion: string;
  /** Electron userData folder (or OIDE_USER_DATA when set, used by e2e tests). */
  userDataDir: string;
  /** Validated main → renderer event. */
  emit: Emit;
  /** Push normalized agent events here; they leave as one `agents.batch` per ~16 ms. */
  agentEvents: FrameBatcher<AgentEvent>;
  /** Folders renderer paths may point into. Register projects/worktrees/artifact stores here. */
  roots: AllowedRoots;
  getWindow(): BrowserWindow | null;
  log: Logger;
  /**
   * Register cleanup that runs before quit (kill ptys, deny pending permissions, close db). Hooks
   * run one after another in registration order, each with a timeout (reliability/shutdown.ts).
   */
  onQuit(fn: () => void | Promise<void>, name?: string): void;
  /** Rotating file logs and opt-in crash reports (the Electron app; absent in plain-Node tests). */
  reliability?: ReliabilityContext;
}
