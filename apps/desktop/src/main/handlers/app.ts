import { mkdirSync } from 'node:fs';
import { TELEMETRY_SCREENS } from '@oide/protocol';
import { join } from 'node:path';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { folderName } from '../reliability/cleanup-queue.js';
import { collectDiagnostics } from '../reliability/diagnostics.js';
import { Redactor } from '../reliability/redact.js';
import type { Services } from '../services/index.js';

/** Screen error reports written per minute; more are dropped. */
export const REPORTS_PER_MINUTE = 20;

export function registerAppHandlers(router: IpcRouter, services: Services, ctx: MainContext): void {
  router.register('app.info', () => ({
    version: ctx.appVersion,
    platform: ctx.platform,
    userData: ctx.userDataDir,
  }));

  const redactor = () => ctx.reliability?.logs.redactor ?? new Redactor({ paths: { [ctx.userDataDir]: '<userData>' } });

  router.register('app.diagnostics', () =>
    collectDiagnostics({
      appVersion: ctx.appVersion,
      userDataDir: ctx.userDataDir,
      logsDir: ctx.reliability?.logs.dir ?? join(ctx.userDataDir, 'logs'),
      dbFile: services.store.database.file,
      cli: () => services.cli.ensure(),
      mcpPort: () => services.mcpPort(),
      keychainAvailable: () => services.platform.cipher.available?.(),
      crashReportsEnabled: () => ctx.reliability?.crashReports.enabled ?? false,
      fileLoggingOk: () => ctx.reliability?.logs.fileLoggingOk() ?? true,
      redactor: redactor(),
    }),
  );

  router.register('app.openLogsFolder', async () => {
    const dir = ctx.reliability?.logs.dir ?? join(ctx.userDataDir, 'logs');
    mkdirSync(dir, { recursive: true });
    if (!services.platform.openPath) throw new IpcError('Opening folders is not available here', 'not_implemented');
    const err = await services.platform.openPath(dir);
    if (err) throw new IpcError(`Could not open the logs folder: ${err}`, 'internal');
    return { ok: true as const };
  });

  // Settings › Diagnostics › Folders waiting to be removed. The renderer can only name folders that
  // are already in the queue: any other path is refused, so these commands never touch or probe
  // arbitrary folders.
  const queued = (path: string) => {
    const e = services.cleanup.queue.find(path);
    if (!e) throw new IpcError('That folder is not waiting to be removed.', 'not_found');
    return e;
  };
  router.register('app.pendingCleanups', () =>
    services.cleanup.queue.list().map((e) => ({
      path: e.path,
      name: folderName(e.path),
      addedAt: e.addedAt,
      attempts: e.attempts,
      ...(e.nextAttemptAt !== undefined ? { nextAttemptAt: e.nextAttemptAt } : {}),
      ...(e.lastError ? { lastError: e.lastError } : {}),
      holders: e.holders ?? [],
    })),
  );
  router.register('app.retryCleanup', async ({ path }) => {
    const r = await services.cleanup.retryNow(path !== undefined ? queued(path).path : undefined);
    return { removed: r.removed, stillPending: r.stillLocked, gaveUp: r.gaveUp };
  });
  router.register('app.cleanupHolders', async ({ path }) => {
    const e = queued(path);
    if (!services.findHolders) return { supported: false, holders: [] };
    const r = await services.findHolders(e.path, { excludePids: [process.pid] });
    services.cleanup.queue.noteHolders(e.path, r.holders);
    return { supported: r.supported, holders: r.holders, ...(r.error ? { error: r.error } : {}) };
  });

  // Renderer error boundaries: the page sends only the error and component stack (no props,
  // state, prompts or code); it is redacted again here before it reaches the log file.
  // At most REPORTS_PER_MINUTE reports reach the log, so a renderer stuck in a crash loop (or a
  // compromised one) cannot flood it and rotate the useful lines away (SEC-35).
  let budget = { start: 0, n: 0 };
  router.register('app.reportError', ({ screen, name, message, stack, componentStack }) => {
    const now = Date.now();
    if (now - budget.start >= 60_000) budget = { start: now, n: 0 };
    if (++budget.n > REPORTS_PER_MINUTE) return { ok: true as const };
    const log = ctx.reliability?.logs.channel('renderer') ?? ctx.log;
    log.error(`screen "${screen}" crashed`, { name, message, ...(stack ? { stack } : {}), ...(componentStack ? { componentStack } : {}) });
    // Opt-in error reports (scrubbed in main; dropped unless "Send crash and error reports" is on).
    const tags = (TELEMETRY_SCREENS as readonly string[]).includes(screen) ? { screen } : undefined;
    ctx.telemetry?.service.error({ name, message, stack }, { source: 'boundary', process: 'renderer', handled: true, ...(tags ? { tags } : {}) });
    return { ok: true as const };
  });
}
