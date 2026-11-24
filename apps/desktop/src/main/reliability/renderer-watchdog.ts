/**
 * Crash isolation for the window. The main process owns every agent, worktree, the database and
 * the extension host, so a renderer crash or hang never touches them. When the renderer process
 * goes away (`render-process-gone`), the watchdog reloads the page after a short delay; the new
 * page re-subscribes and its stores rehydrate from `agents.list` / `agents.events`. If it keeps
 * crashing (more than `maxCrashes` within `windowMs`), it stops reloading and shows a static
 * error page with a Reload button instead of looping. An `unresponsive` window gets a choice to
 * wait or reload; agents keep running either way.
 */

export interface CrashLoopOptions {
  maxCrashes?: number;
  windowMs?: number;
  /** First reload delay; doubles per crash in the window (default 250 ms, capped at 5 s). */
  baseDelayMs?: number;
  now?: () => number;
}

/** Decides whether (and when) to reload after a crash. Pure; tested on its own. */
export class CrashLoopGuard {
  private crashes: number[] = [];
  private readonly maxCrashes: number;
  private readonly windowMs: number;
  private readonly baseDelayMs: number;
  private readonly now: () => number;

  constructor(o: CrashLoopOptions = {}) {
    this.maxCrashes = o.maxCrashes ?? 3;
    this.windowMs = o.windowMs ?? 60_000;
    this.baseDelayMs = o.baseDelayMs ?? 250;
    this.now = o.now ?? Date.now;
  }

  /** Record a crash. Returns the reload delay, or null when it is crash-looping. */
  onCrash(): number | null {
    const t = this.now();
    this.crashes = this.crashes.filter((c) => t - c < this.windowMs);
    this.crashes.push(t);
    if (this.crashes.length > this.maxCrashes) return null;
    return Math.min(this.baseDelayMs * 2 ** (this.crashes.length - 1), 5000);
  }

  get recent(): number {
    const t = this.now();
    return this.crashes.filter((c) => t - c < this.windowMs).length;
  }

  reset(): void {
    this.crashes = [];
  }
}

/** The parts of `webContents` the watchdog uses (an EventEmitter in tests). */
export interface WatchedContents {
  on(event: 'render-process-gone', fn: (e: unknown, details: { reason: string; exitCode: number }) => void): unknown;
  on(event: 'unresponsive' | 'responsive', fn: () => void): unknown;
  on(event: 'did-fail-load', fn: (e: unknown, code: number, desc: string, url: string, isMainFrame: boolean) => void): unknown;
  isDestroyed(): boolean;
  reload(): void;
  loadURL(url: string): Promise<void>;
}

export interface WatchdogHooks {
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** Reload the app page (the normal URL, not `reload()` of an error page). */
  reloadApp(): void;
  /** Crash report hook (opt-in summaries). */
  onCrash?(details: { reason: string; exitCode: number }): void;
  onUnresponsive?(): void;
  /** Ask the user what to do with a hung window; resolves 'reload' or 'wait'. */
  askUnresponsive?(): Promise<'reload' | 'wait'>;
  /** Crash loop: the error page is showing; ask whether to reload once more. Resolves true to reload. */
  askCrashLoop?(): Promise<boolean>;
  /** True while the app quits (never reload then). */
  quitting(): boolean;
  guard?: CrashLoopGuard;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

/** Inline error page shown when the renderer crash-loops (no scripts: the CSP forbids them anyway). */
export function crashLoopPage(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>oIDE</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0E1013;color:#E6E8EB;font:13px Inter,system-ui,sans-serif}
main{max-width:460px;padding:24px;border:1px solid #262B33;border-radius:12px;background:#15181D}h1{font-size:16px;margin:0 0 8px}p{color:#C9CED6;line-height:1.5;margin:0 0 8px}
code{font-family:'JetBrains Mono',monospace;color:#9DBBFA}</style></head><body><main role="alert">
<h1>The oIDE window keeps crashing</h1>
<p>Your agents are still running in the background; nothing was lost.</p>
<p>Choose Reload in the dialog to try again, or quit and restart oIDE. Logs are in the <code>logs</code> folder of oIDE's app data.</p>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function watchRenderer(wc: WatchedContents, hooks: WatchdogHooks): { guard: CrashLoopGuard } {
  const guard = hooks.guard ?? new CrashLoopGuard();
  const later = hooks.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let asking = false;

  wc.on('render-process-gone', (_e, details) => {
    const reason = details?.reason ?? 'unknown';
    const exitCode = details?.exitCode ?? -1;
    if (reason === 'clean-exit') {
      hooks.log.info('renderer exited cleanly');
      return;
    }
    hooks.log.error('renderer process gone', { reason, exitCode });
    hooks.onCrash?.({ reason, exitCode });
    if (hooks.quitting()) return;
    const delay = guard.onCrash();
    if (delay === null) {
      hooks.log.error('renderer is crash-looping; showing the error page', { crashes: guard.recent });
      later(() => {
        if (wc.isDestroyed()) return;
        void wc.loadURL(crashLoopPage()).catch(() => undefined);
        void hooks
          .askCrashLoop?.()
          .then((again) => {
            if (again && !wc.isDestroyed() && !hooks.quitting()) {
              guard.reset();
              hooks.reloadApp();
            }
          })
          .catch(() => undefined);
      }, 0);
      return;
    }
    later(() => {
      if (wc.isDestroyed() || hooks.quitting()) return;
      hooks.log.info('reloading the window after a renderer crash', { delayMs: delay });
      hooks.reloadApp();
    }, delay);
  });

  wc.on('unresponsive', () => {
    hooks.log.warn('window unresponsive');
    hooks.onUnresponsive?.();
    if (asking || !hooks.askUnresponsive || hooks.quitting()) return;
    asking = true;
    void hooks
      .askUnresponsive()
      .then((choice) => {
        if (choice === 'reload' && !wc.isDestroyed() && !hooks.quitting()) {
          hooks.log.info('reloading the unresponsive window (user choice)');
          hooks.reloadApp();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        asking = false;
      });
  });

  wc.on('responsive', () => hooks.log.info('window responsive again'));

  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) hooks.log.warn('page failed to load', { code, desc });
  });

  return { guard };
}
