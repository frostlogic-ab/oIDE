import type { BrowserWindow } from 'electron';
import type { AgentEvent, WindowOpenTrigger } from '@oide/protocol';
import type { Emit, FrameBatcher } from './ipc/emit.js';
import type { Logger } from './ipc/router.js';
import type { ReliabilityContext } from './reliability/index.js';
import type { AllowedRoots } from './security/roots.js';
import type { TelemetryObservers } from './telemetry/observers.js';
import type { TelemetryService } from './telemetry/service.js';

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
  /** Validated main → renderer event, sent to every open window (they all show the same profile). */
  emit: Emit;
  /**
   * The same, sent only to the window the user used last: for events that open something in one
   * window (an extension panel), not state every window mirrors. Absent in plain-Node tests.
   */
  emitActive?: Emit;
  /** Push normalized agent events here; they leave as one `agents.batch` per ~16 ms. */
  agentEvents: FrameBatcher<AgentEvent>;
  /** Folders renderer paths may point into. Register projects/worktrees/artifact stores here. */
  roots: AllowedRoots;
  /** The window the user used last (dialogs, notification clicks), or null when none is open. */
  getWindow(): BrowserWindow | null;
  /** Opens another window on the same profile (main/windows.ts). Absent in plain-Node tests. */
  openWindow?(trigger: WindowOpenTrigger): void;
  log: Logger;
  /**
   * Register cleanup that runs before quit (kill ptys, deny pending permissions, close db). Hooks
   * run one after another in registration order, each with a timeout (reliability/shutdown.ts).
   */
  onQuit(fn: () => void | Promise<void>, name?: string): void;
  /** Rotating file logs and opt-in crash reports (the Electron app; absent in plain-Node tests). */
  reliability?: ReliabilityContext;
  /** Opt-in usage analytics and error reports (ADR 0011; absent in plain-Node tests). Main is the only sender. */
  telemetry?: { service: TelemetryService; observers: TelemetryObservers };
}
