// Must stay the first import: no bare-name program lookup in the cwd on Windows (SEC-01).
import './security/early-env.js';
// Must stay before the rest: silences the node:sqlite ExperimentalWarning before anything loads it.
import './warnings.js';

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { hostname, release, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Notification, screen, shell } from 'electron';
import { openStore, type Store } from '@oide/store';
import { AppVersion, appVersionValue, cliVersionBucket, countBucket, screenBucket, telemetryTarget, type AgentEvent, type WindowOpenTrigger } from '@oide/protocol';
import { buildAppMenuTemplate, type AppMenuDeps } from './app-menu.js';
import type { MainContext } from './context.js';
import { createAgentEventBatcher, createEmitter } from './ipc/emit.js';
import { attachRouter, IpcRouter, type Logger } from './ipc/router.js';
import { attachDropChannel } from './handlers/dialog.js';
import { registerAllHandlers } from './handlers/index.js';
import { createServices } from './services/index.js';
import { registerArtifactScheme } from './services/electron-platform.js';
import { isAllowedExternalUrl } from './security/external.js';
import { hardenApp } from './security/hardening.js';
import { AllowedRoots } from './security/roots.js';
import { loadWindowState, MIN_HEIGHT, MIN_WIDTH, trackWindowState } from './window-state.js';
import { cascadePosition, NEW_WINDOW_ARG, WindowRegistry } from './windows.js';
import { APP_USER_MODEL_ID, DEV_APP_USER_MODEL_ID, appUserModelId, brandAppShortcuts, releaseForeignShortcuts, resolveAppIcon } from './app-icon.js';
import { CrashReports, LogManager, openWithRecovery, parseLevel, readCrashReportsPref, Redactor, runShutdown, watchRenderer, writeCrashReportsPref, type ReliabilityContext } from './reliability/index.js';
import { electronTransport, fileSinkTransport, isOnline } from './telemetry/electron.js';
import { TelemetryObservers } from './telemetry/observers.js';
import { createScrubber } from './telemetry/scrub.js';
import { TelemetryService, unavailableReason } from './telemetry/service.js';

/** Injected by electron-vite from `OIDE_UMAMI_HOST` / `OIDE_UMAMI_WEBSITE_ID` (official defaults; empty = compiled out). */
declare const __OIDE_UMAMI_HOST__: string | undefined;
declare const __OIDE_UMAMI_WEBSITE_ID__: string | undefined;

// Tests and portable setups can point userData elsewhere. Must happen before the lock below,
// which is scoped to the userData folder.
if (process.env.OIDE_USER_DATA) app.setPath('userData', process.env.OIDE_USER_DATA);

// The oIDE icon in the taskbar/dock, also in dev and unpackaged runs (main/app-icon.ts). Installed builds use
// electron-builder's appId as AppUserModelID (the installer's shortcuts carry it); unpackaged runs use their
// own, so a dev shortcut left behind by a deleted worktree can never take over the installed app's icon.
if (process.platform === 'win32') app.setAppUserModelId(appUserModelId(app.isPackaged));
const appIcon = resolveAppIcon({ packaged: app.isPackaged, platform: process.platform, appPath: join(import.meta.dirname, '..', '..'), resourcesPath: process.resourcesPath, exists: existsSync });

// ---------------------------------------------------------------- logs and crash reports (before ready)

const userDataAtBoot = app.getPath('userData');
const redactor = new Redactor({ paths: { [userDataAtBoot]: '<userData>' } });
const logs = new LogManager({
  dir: join(userDataAtBoot, 'logs'),
  level: parseLevel(process.env.OIDE_LOG_LEVEL, process.env.OIDE_DEBUG ? 'debug' : 'info'),
  console: Boolean(process.env.OIDE_DEBUG),
  redactor,
});
const log: Logger & { info(...a: unknown[]): void } = logs.main;
const crashReports = new CrashReports({
  dir: join(userDataAtBoot, 'crash-reports'),
  userDataDir: userDataAtBoot,
  enabled: readCrashReportsPref(userDataAtBoot),
  redactor,
  appVersion: app.getVersion(),
});

// ---------------------------------------------------------------- opt-in telemetry (ADR 0011)

const devServerAtBoot = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const safeUserName = (): string | undefined => {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
};
/** OS version for session data: `10.0.26300` on Windows (the build tells 10 from 11), major.minor elsewhere. */
const osVersion = (): string => {
  const parts = release().split(/[.-]/).filter((p) => /^\d+$/.test(p));
  return parts.slice(0, process.platform === 'win32' ? 3 : 2).join('.') || 'unknown';
};
/** E2E only: unpackaged runs may write telemetry to a file instead of the network (main/telemetry/electron.ts). */
const telemetrySink = !app.isPackaged ? process.env.OIDE_TELEMETRY_SINK || undefined : undefined;
const umamiTarget = telemetryTarget(typeof __OIDE_UMAMI_HOST__ === 'string' ? __OIDE_UMAMI_HOST__ : '', typeof __OIDE_UMAMI_WEBSITE_ID__ === 'string' ? __OIDE_UMAMI_WEBSITE_ID__ : '');
const telemetry = new TelemetryService({
  target: umamiTarget,
  unavailable: unavailableReason(process.env),
  dev: !app.isPackaged,
  appVersion: app.getVersion(),
  session: {
    os: process.platform,
    osVersion: osVersion(),
    arch: process.arch,
    electron: process.versions.electron ?? 'unknown',
    country: app.getLocaleCountryCode(),
  },
  stateFile: join(userDataAtBoot, 'telemetry.json'),
  scrubber: createScrubber({
    redactor,
    username: safeUserName(),
    hostname: hostname(),
    appRoots: [app.getAppPath(), process.resourcesPath].filter((p): p is string => typeof p === 'string' && p.length > 0),
    appOrigins: devServerAtBoot ? [devServerAtBoot] : [],
  }),
  log,
  ...(telemetrySink ? { client: { flushMs: 300, errorFlushMs: 100 } } : {}),
});

let nativeCrashReporterStarted = false;
/** Electron's minidump writer: local only (`uploadToServer: false`), started only when the user opted in. */
function startNativeCrashReporter(): void {
  if (nativeCrashReporterStarted || !crashReports.enabled) return;
  try {
    app.setPath('crashDumps', crashReports.nativeDir);
    crashReporter.start({ uploadToServer: false, compress: true, ignoreSystemCrashHandler: false, globalExtra: { _productName: 'oIDE' } });
    nativeCrashReporterStarted = true;
  } catch (err) {
    log.warn('crash reporter did not start', err);
  }
}
startNativeCrashReporter();

// The main process owns every agent: an exception in one handler must not take them all down.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception in main', err);
  crashReports.record('main-exception', { process: 'main', error: err });
  telemetry.error(err, { source: 'uncaught', process: 'main' });
  logs.flush();
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection in main', reason);
  crashReports.record('unhandled-rejection', { process: 'main', error: reason });
  telemetry.error(reason, { source: 'unhandledrejection', process: 'main' });
});

app.enableSandbox();
// Privileged schemes must be registered before the app is ready.
registerArtifactScheme();

// One main process per profile (it owns the database, agents and worktrees). Starting oIDE again
// while it runs asks the running process for another window on the same profile (`second-instance`
// in start()) and exits at once, before Chromium touches the profile's caches.
if (!app.requestSingleInstanceLock()) {
  if (!app.isPackaged) console.log('oIDE is already running with this profile: opened a new window there. Set OIDE_USER_DATA to run a separate profile.');
  app.exit(0);
} else {
  void start();
}

async function start(): Promise<void> {
  const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const rendererDir = join(import.meta.dirname, '../renderer');
  const rendererFileUrl = pathToFileURL(join(rendererDir, 'index.html')).href;
  const rendererDirUrl = pathToFileURL(rendererDir).href + '/';

  const isAppUrl = (url: string): boolean => {
    if (!url) return false;
    if (devServerUrl) {
      try {
        return new URL(url).origin === new URL(devServerUrl).origin;
      } catch {
        return false;
      }
    }
    return url.startsWith(rendererDirUrl) || url.split('#')[0] === rendererFileUrl;
  };

  // Every window shows the same profile; events go to all of them (main/windows.ts).
  const windows = new WindowRegistry<BrowserWindow>();
  /** Set once the app is ready to open windows; earlier relaunches only focus (the first window is coming). */
  let openAnotherWindow: ((trigger: WindowOpenTrigger) => void) | null = null;
  const quitHooks: Array<{ name: string; fn: () => void | Promise<void> }> = [];

  let observers: TelemetryObservers | null = null;
  const sendEvent = createEmitter(() => windows.all().map((w) => w.webContents), log);
  const sendActive = createEmitter(() => {
    const w = windows.active();
    return w ? [w.webContents] : [];
  }, log);
  // Telemetry observes what main tells the renderer (search results, removed agents); it never changes it.
  const observed =
    (send: typeof sendEvent): typeof sendEvent =>
    (event, payload) => {
      const sent = send(event, payload);
      try {
        observers?.emitted(event, payload);
      } catch {}
      return sent;
    };
  const emit = observed(sendEvent);
  const emitActive = observed(sendActive);
  const agentEvents = createAgentEventBatcher(emit);
  const pushAgentEvent = agentEvents.push.bind(agentEvents);
  agentEvents.push = (e: AgentEvent) => {
    pushAgentEvent(e);
    try {
      observers?.agentEvent(e);
    } catch {}
  };
  const roots = new AllowedRoots();

  // oIDE started again (Start menu, a shortcut, the taskbar "New window" task, `pnpm dev`): another window.
  app.on('second-instance', (_e, argv) => {
    if (openAnotherWindow) {
      openAnotherWindow(argv.includes(NEW_WINDOW_ARG) ? 'taskbar' : 'relaunch');
      return;
    }
    const w = windows.active();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.focus();
  });

  // before-quit: from here on the window is never reloaded after a crash. will-quit: flush the
  // last agent events, run the quit hooks in order (each capped), close the logs, exit.
  let quitRequested = false;
  let quitting = false;
  app.on('before-quit', () => {
    quitRequested = true;
    log.info('quit requested');
  });
  app.on('will-quit', (event) => {
    log.debug('will-quit', { quitting, hooks: quitHooks.length });
    if (quitting) return;
    quitting = true;
    quitRequested = true;
    event.preventDefault();
    agentEvents.dispose();
    void runShutdown(quitHooks, { stepMs: 7000, totalMs: 12_000, log }).finally(() => {
      logs.close();
      // app.quit() is a no-op after will-quit was prevented; exit explicitly.
      app.exit(0);
    });
  });

  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    log.error('child process gone', { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name ?? details.serviceName });
    crashReports.record('child-process-gone', { process: details.serviceName ?? details.type, reason: details.reason, exitCode: details.exitCode });
    telemetry.error({ name: 'ChildProcessGone', message: `${details.type} ${details.reason}`, stack: '' }, { source: 'child-process-gone', process: details.type, handled: true });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  await app.whenReady();
  if (appIcon.dock) app.dock?.setIcon(appIcon.dock);
  if (process.platform === 'win32' && !app.isPackaged && appIcon.window) brandDevShortcut(appIcon.window);
  if (process.platform === 'win32' && app.isPackaged) releaseDevShortcuts();

  await hardenApp({ isAppUrl, dev: Boolean(devServerUrl) });

  const userDataDir = app.getPath('userData');
  roots.add(userDataDir, 'app-data');
  const pruned = logs.prune();
  log.info('oIDE starting', { version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch, prunedLogs: pruned.length });
  const reliability: ReliabilityContext = {
    logs: { dir: logs.dir, channel: (n) => logs.channel(n), agent: (id) => logs.agent(id), fileLoggingOk: () => !logs.fileLoggingDisabled, redactor },
    crashReports,
  };

  // The database, with recovery prompts: locked → Retry; damaged → backed up first, then the
  // user chooses (never silently replaced). Quit when they choose to.
  const dbFile = join(userDataDir, 'oide.db');
  const backupDir = join(userDataDir, 'backups');
  const store = await openWithRecovery<Store>({
    file: dbFile,
    backupDir,
    open: () => openStore(dbFile, { backupDir }),
    ask: async (p) =>
      (await dialog.showMessageBox({ type: 'error', title: p.title, message: p.message, detail: p.detail, buttons: p.buttons.map((b) => b.label), defaultId: p.defaultId, cancelId: p.cancelId, noLink: true })).response,
    openFolder: (dir) => void shell.openPath(dir),
    log,
  });
  if (!store) {
    log.warn('quitting: the database could not be opened');
    logs.close();
    app.exit(1);
    return;
  }

  const ctx: MainContext = {
    isDev: !app.isPackaged,
    platform: process.platform,
    appVersion: app.getVersion(),
    userDataDir,
    emit,
    emitActive,
    agentEvents,
    roots,
    getWindow: () => windows.active(),
    openWindow: (trigger) => openAnotherWindow?.(trigger),
    log,
    onQuit: (fn, name) => quitHooks.push({ name: name ?? `hook ${quitHooks.length + 1}`, fn }),
    reliability,
  };

  const router = new IpcRouter({
    log,
    validateOutput: true,
    observe: (c, i, o) => observers?.command(c, i, o),
    observeFailure: (c, f) => observers?.commandFailed(c, f),
  });
  const services = await createServices(ctx, { store });

  // Telemetry: consent from settings; the network only through its own session (or the e2e file sink).
  observers = new TelemetryObservers(telemetry, { officialIndex: () => services.store.settings.get().marketplace.indexUrl === '' });
  ctx.telemetry = { service: telemetry, observers };
  telemetry.bindSettings(services.store.settings);
  if (telemetry.client && umamiTarget) {
    telemetry.setTransport(telemetrySink ? fileSinkTransport(telemetrySink) : electronTransport(umamiTarget), telemetrySink ? () => true : isOnline);
  }
  const display = screen.getPrimaryDisplay().size;
  telemetry.setContext({ language: app.getLocale(), screen: screenBucket(display.width, display.height) });
  const version = telemetry.noteVersion();
  if (version.changed && AppVersion.safeParse(version.previous).success) telemetry.track('update_installed', { from_version: version.previous!, to_version: app.getVersion() });
  const unknownCliTimer = setInterval(() => observers?.flushUnknownCliEvents(), 30 * 60_000);
  unknownCliTimer.unref();
  ctx.onQuit(async () => {
    clearInterval(unknownCliTimer);
    observers?.flushUnknownCliEvents();
    observers?.dispose();
    await telemetry.shutdown(2_000);
  }, 'telemetry');
  let startReported = false;
  const reportStart = async (): Promise<void> => {
    if (startReported) return;
    startReported = true;
    const coldStartMs = Math.round(performance.now());
    const cli = await Promise.race([services.cli.ensure().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
    telemetry.setCliVersion(cli?.version);
    telemetry.identify();
    telemetry.track('app_started', {
      app_version: appVersionValue(app.getVersion()),
      cold_start_ms: Math.min(coldStartMs, 86_400_000),
      cli_found: !!cli?.found,
      cli_version: cli?.found ? cliVersionBucket(cli.version) : 'none',
      projects: countBucket(services.store.projects.list().length),
      agents: countBucket(services.store.agents.list().length),
    });
  };
  // Settings › Privacy › Crash reports: the database is the source of truth; privacy.json mirrors
  // it so the native crash reporter can start before the app is ready on the next launch.
  const syncCrashPref = (on: boolean) => {
    crashReports.setEnabled(on);
    writeCrashReportsPref(userDataDir, on);
    startNativeCrashReporter();
  };
  syncCrashPref(services.store.settings.get().ui.crashReports);
  services.store.settings.onChange((s) => {
    if (s.ui.crashReports === crashReports.enabled) return;
    log.info('crash reports', s.ui.crashReports ? 'on' : 'off');
    syncCrashPref(s.ui.crashReports);
  });
  registerAllHandlers(router, services, ctx);
  installAppMenu(
    {
      appName: app.name,
      dev: !app.isPackaged,
      send: (item) => emitActive('menu.run', { item }),
      newWindow: () => openAnotherWindow?.('menu'),
      openExternal: (url) => {
        if (isAllowedExternalUrl(url)) void shell.openExternal(url);
      },
      openLogsFolder: () => {
        mkdirSync(logs.dir, { recursive: true });
        void shell.openPath(logs.dir);
      },
      track: (item) => telemetry.track('app_menu_used', { item }),
    },
    services.store.settings,
  );
  attachRouter(router, ipcMain, isAppUrl);
  // Paths of files dropped or pasted on a prompt input, sent only by preload (webUtils.getPathForFile).
  attachDropChannel(ipcMain, services, isAppUrl);

  const loadApp = (win: BrowserWindow): Promise<void> => (devServerUrl ? win.loadURL(devServerUrl) : win.loadFile(join(rendererDir, 'index.html')));
  /**
   * Crash isolation: the renderer only draws. When its process dies or hangs, agents, worktrees,
   * the database and the extension host keep running in main; the page reloads and its stores
   * rehydrate from `agents.list` / `agents.events` (reliability/renderer-watchdog.ts).
   */
  const openWindow = (from?: BrowserWindow): BrowserWindow => {
    const win = createWindow(userDataDir, from);
    windows.add(win);
    win.on('closed', () => windows.remove(win));
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => services.flushNotices(), 500);
      void reportStart();
    });
    // Open pull requests are looked at again when the user comes back (throttled, see pr-watch.ts).
    win.on('focus', () => {
      windows.focused(win);
      services.git.onWindowFocus();
    });
    watchRenderer(win.webContents, {
      log,
      reloadApp: () => void loadApp(win).catch((err) => log.error('window reload failed', err)),
      onCrash: (d) => {
        crashReports.record('renderer-gone', { process: 'renderer', reason: d.reason, exitCode: d.exitCode });
        telemetry.error({ name: 'RendererGone', message: d.reason, stack: '' }, { source: 'renderer-gone', process: 'renderer', handled: true });
      },
      onUnresponsive: () => crashReports.record('renderer-unresponsive', { process: 'renderer' }),
      askUnresponsive: async () => {
        const r = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'oIDE',
          message: 'The oIDE window is not responding.',
          detail: 'Your agents keep running in the background. Wait, or reload the window (nothing is lost).',
          buttons: ['Wait', 'Reload window'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return r.response === 1 ? 'reload' : 'wait';
      },
      askCrashLoop: async () => {
        const r = await dialog.showMessageBox(win, {
          type: 'error',
          title: 'oIDE',
          message: 'The oIDE window keeps crashing.',
          detail: 'Your agents are still running in the background. Reload the window to try again, or quit oIDE (sessions stay resumable).',
          buttons: ['Reload window', 'Quit oIDE'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (r.response === 1) app.quit();
        return r.response === 0;
      },
      quitting: () => quitRequested,
    });
    return win;
  };

  const firstWindow = openWindow();
  await loadApp(firstWindow);

  openAnotherWindow = (trigger) => {
    if (quitRequested) return;
    const win = openWindow(windows.active() ?? undefined);
    void loadApp(win).catch((err) => log.error('window load failed', err));
    log.info('opened a window', { trigger, windows: windows.size });
    telemetry.track('window_opened', { trigger, windows: countBucket(windows.size) });
  };
  // macOS: the Dock menu. Windows: a "New window" task in the taskbar jump list (installed builds;
  // a dev run's electron.exe would need the app path as an argument).
  if (process.platform === 'darwin') app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => openAnotherWindow?.('dock') }]));
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      app.setUserTasks([{ program: process.execPath, arguments: NEW_WINDOW_ARG, title: 'New window', description: 'Open another oIDE window', iconPath: process.execPath, iconIndex: 0 }]);
    } catch (err) {
      log.warn('could not set the taskbar tasks', err);
    }
  }

  app.on('activate', () => {
    if (windows.size === 0 && !quitRequested) void loadApp(openWindow());
  });
}

/**
 * Unpackaged Windows runs: give Electron's notification shortcut (Start Menu `Electron.lnk`, our AUMID,
 * target electron.exe) the oIDE icon, or the taskbar shows Electron's logo (main/app-icon.ts). Asking
 * for notification support makes Electron write or refresh that shortcut now; it does so off-thread, so
 * the pass runs again a moment later.
 */
function brandDevShortcut(icon: string): void {
  const programs = startMenuPrograms();
  const run = (): void => {
    try {
      const updated = brandAppShortcuts(
        {
          list: () => readdirSync(programs).filter((n) => n.toLowerCase().endsWith('.lnk')).map((n) => join(programs, n)),
          read: (path) => shell.readShortcutLink(path),
          // 'update' only rewrites the given fields; `target` is required by the type and kept as is.
          setIcon: (path, ico, target) => shell.writeShortcutLink(path, 'update', { target, icon: ico, iconIndex: 0 }),
        },
        { execPath: process.execPath, appId: DEV_APP_USER_MODEL_ID, icon },
      );
      if (updated.length > 0) log.info('set the oIDE icon on the notification shortcut', { count: updated.length });
    } catch (err) {
      log.warn('could not set the oIDE icon on the notification shortcut', { error: String(err) });
    }
  };
  // Creates Electron's notification presenter, which writes/refreshes the shortcut (once per process).
  void Notification.isSupported();
  // Off the startup path; Electron's write is off-thread and can be slow on a cold start, so a few
  // idempotent passes follow.
  for (const ms of [0, 1000, 3000, 10_000, 30_000]) setTimeout(run, ms).unref();
}

const startMenuPrograms = (): string => join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');

/**
 * Packaged Windows runs: release Start Menu shortcuts that carry the installed app's AUMID but launch
 * something else (a dev run's `Electron.lnk`), or the taskbar can show their (often deleted) icon instead
 * of oIDE's (main/app-icon.ts). Off the startup path.
 */
function releaseDevShortcuts(): void {
  const programs = startMenuPrograms();
  setTimeout(() => {
    try {
      const { removed, retagged } = releaseForeignShortcuts(
        {
          list: () => readdirSync(programs).filter((n) => n.toLowerCase().endsWith('.lnk')).map((n) => join(programs, n)),
          read: (path) => shell.readShortcutLink(path),
          exists: existsSync,
          remove: (path) => rmSync(path),
          // 'update' only rewrites the given fields; `target` is required by the type and kept as is.
          setAppUserModelId: (path, appUserModelId, target) => shell.writeShortcutLink(path, 'update', { target, appUserModelId }),
        },
        { execPath: process.execPath, appId: APP_USER_MODEL_ID, devAppId: DEV_APP_USER_MODEL_ID },
      );
      if (removed.length + retagged.length > 0) log.info('released dev shortcuts that shared the oIDE taskbar identity', { removed: removed.length, retagged: retagged.length });
    } catch (err) {
      log.warn('could not check Start Menu shortcuts for the oIDE taskbar identity', { error: String(err) });
    }
  }, 0).unref();
}

/** A window on the saved bounds; one opened from another window (`from`) cascades from it instead. */
function createWindow(userDataDir: string, from?: BrowserWindow): BrowserWindow {
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const state = loadWindowState(userDataDir, workAreas);
  if (from && !from.isDestroyed()) {
    const base = from.getNormalBounds();
    Object.assign(state, { width: base.width, height: base.height, maximized: from.isMaximized() }, cascadePosition(base, base, workAreas));
  }
  const win = new BrowserWindow({
    title: 'oIDE',
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#0E1013',
    ...(appIcon.window ? { icon: appIcon.window } : {}),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  trackWindowState(win, userDataDir);
  return win;
}

/**
 * macOS: the native menu bar (main/app-menu.ts), rebuilt when the user rebinds a key so the shown
 * shortcuts follow Settings › Keys. Windows and Linux: no menu bar (packaged builds remove
 * Electron's default; the command bar has every item).
 */
function installAppMenu(deps: Omit<AppMenuDeps, 'keybindings'>, settings: Store['settings']): void {
  if (process.platform !== 'darwin') {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    return;
  }
  let shown = '';
  const apply = (keybindings: AppMenuDeps['keybindings']) => {
    const key = JSON.stringify(keybindings);
    if (key === shown) return;
    shown = key;
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({ ...deps, keybindings })));
  };
  apply(settings.get().keybindings);
  settings.onChange((s) => apply(s.keybindings));
}
