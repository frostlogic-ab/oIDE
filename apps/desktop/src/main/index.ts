// Must stay the first import: no bare-name program lookup in the cwd on Windows (SEC-01).
import './security/early-env.js';
// Must stay before the rest: silences the node:sqlite ExperimentalWarning before anything loads it.
import './warnings.js';

import { existsSync, readdirSync } from 'node:fs';
import { hostname, release, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Notification, screen, shell } from 'electron';
import { openStore, type Store } from '@oide/store';
import { AppVersion, cliVersionBucket, countBucket, screenBucket, telemetryTarget, type AgentEvent } from '@oide/protocol';
import type { MainContext } from './context.js';
import { createAgentEventBatcher, createEmitter } from './ipc/emit.js';
import { attachRouter, IpcRouter, type Logger } from './ipc/router.js';
import { attachDropChannel } from './handlers/dialog.js';
import { registerAllHandlers } from './handlers/index.js';
import { createServices } from './services/index.js';
import { registerArtifactScheme } from './services/electron-platform.js';
import { hardenApp } from './security/hardening.js';
import { AllowedRoots } from './security/roots.js';
import { loadWindowState, MIN_HEIGHT, MIN_WIDTH, trackWindowState } from './window-state.js';
import { APP_USER_MODEL_ID, DEV_APP_USER_MODEL_ID, appUserModelId, brandAppShortcuts, releaseInstalledAppId, resolveAppIcon } from './app-icon.js';
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

// The oIDE icon in the taskbar/dock, also in dev and unpackaged runs (main/app-icon.ts). The installed app's
// AppUserModelID matches electron-builder's appId; unpackaged runs use their own, or their `Electron.lnk`
// claims the installed app's identity and its notifications come from "Electron".
const APP_ID = appUserModelId(app.isPackaged);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
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
  session: { os: process.platform, osVersion: osVersion(), arch: process.arch, electron: process.versions.electron ?? 'unknown' },
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
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

  let mainWindow: BrowserWindow | null = null;
  const quitHooks: Array<{ name: string; fn: () => void | Promise<void> }> = [];

  let observers: TelemetryObservers | null = null;
  const sendEvent = createEmitter(() => (mainWindow && !mainWindow.isDestroyed() ? [mainWindow.webContents] : []), log);
  // Telemetry observes what main tells the renderer (search results, removed agents); it never changes it.
  const emit: typeof sendEvent = (event, payload) => {
    const sent = sendEvent(event, payload);
    try {
      observers?.emitted(event, payload);
    } catch {}
    return sent;
  };
  const agentEvents = createAgentEventBatcher(emit);
  const pushAgentEvent = agentEvents.push.bind(agentEvents);
  agentEvents.push = (e: AgentEvent) => {
    pushAgentEvent(e);
    try {
      observers?.agentEvent(e);
    } catch {}
  };
  const roots = new AllowedRoots();

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
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
  if (process.platform === 'win32' && app.isPackaged) setTimeout(releaseDevShortcuts, 0).unref();

  await hardenApp({ isAppUrl, dev: Boolean(devServerUrl) });
  setMenu();

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
    agentEvents,
    roots,
    getWindow: () => mainWindow,
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
  attachRouter(router, ipcMain, isAppUrl);
  // Paths of files dropped or pasted on a prompt input, sent only by preload (webUtils.getPathForFile).
  attachDropChannel(ipcMain, services, isAppUrl);

  const loadApp = (win: BrowserWindow): Promise<void> => (devServerUrl ? win.loadURL(devServerUrl) : win.loadFile(join(rendererDir, 'index.html')));
  /**
   * Crash isolation: the renderer only draws. When its process dies or hangs, agents, worktrees,
   * the database and the extension host keep running in main; the page reloads and its stores
   * rehydrate from `agents.list` / `agents.events` (reliability/renderer-watchdog.ts).
   */
  const openWindow = (): BrowserWindow => {
    const win = createWindow(userDataDir);
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => services.flushNotices(), 500);
      void reportStart();
    });
    // Open pull requests are looked at again when the user comes back (throttled, see pr-watch.ts).
    win.on('focus', () => services.git.onWindowFocus());
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

  mainWindow = openWindow();
  await loadApp(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = openWindow();
      void loadApp(mainWindow);
    }
  });
}

/** The per-user Start Menu Programs folder, where Electron writes its notification shortcut. */
function startMenuPrograms(): string {
  return join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

const listShortcuts = (dir: string): string[] =>
  readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.lnk'))
    .map((n) => join(dir, n));

/**
 * Installed Windows runs: shortcuts that older dev runs left with the installed AUMID (`Electron.lnk`,
 * target electron.exe) make Windows name oIDE's notifications "Electron". Move them to the dev AUMID
 * (main/app-icon.ts). Once per start; a no-op when there are none.
 */
function releaseDevShortcuts(): void {
  try {
    const programs = startMenuPrograms();
    const updated = releaseInstalledAppId(
      {
        list: () => listShortcuts(programs),
        read: (path) => shell.readShortcutLink(path),
        // 'update' only rewrites the given fields; `target` is required by the type and kept as is.
        setAppId: (path, appUserModelId, target) => shell.writeShortcutLink(path, 'update', { target, appUserModelId }),
      },
      { appId: APP_USER_MODEL_ID, devAppId: DEV_APP_USER_MODEL_ID },
    );
    if (updated.length > 0) log.info('moved dev shortcuts off the installed app id', { count: updated.length });
  } catch (err) {
    log.warn('could not check Start Menu shortcuts for the installed app id', { error: String(err) });
  }
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
          list: () => listShortcuts(programs),
          read: (path) => shell.readShortcutLink(path),
          // 'update' only rewrites the given fields; `target` is required by the type and kept as is.
          setIcon: (path, ico, target) => shell.writeShortcutLink(path, 'update', { target, icon: ico, iconIndex: 0 }),
        },
        { execPath: process.execPath, appId: APP_ID, icon },
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

function createWindow(userDataDir: string): BrowserWindow {
  const state = loadWindowState(
    userDataDir,
    screen.getAllDisplays().map((d) => d.workArea),
  );
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

function setMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]),
    );
  } else if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }
}
