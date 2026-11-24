// Must stay the first import: no bare-name program lookup in the cwd on Windows (SEC-01).
import './security/early-env.js';
// Must stay before the rest: silences the node:sqlite ExperimentalWarning before anything loads it.
import './warnings.js';

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron';
import type { MainContext } from './context.js';
import { createAgentEventBatcher, createEmitter } from './ipc/emit.js';
import { attachRouter, IpcRouter, type Logger } from './ipc/router.js';
import { registerAllHandlers } from './handlers/index.js';
import { createServices } from './services/index.js';
import { registerArtifactScheme } from './services/electron-platform.js';
import { hardenApp } from './security/hardening.js';
import { AllowedRoots } from './security/roots.js';
import { loadWindowState, MIN_HEIGHT, MIN_WIDTH, trackWindowState } from './window-state.js';

const log: Logger = {
  debug: (...a) => {
    if (process.env.OIDE_DEBUG) console.debug('[oide]', ...a);
  },
  warn: (...a) => console.warn('[oide]', ...a),
  error: (...a) => console.error('[oide]', ...a),
};

// Tests and portable setups can point userData elsewhere. Must happen before the lock below,
// which is scoped to the userData folder.
if (process.env.OIDE_USER_DATA) app.setPath('userData', process.env.OIDE_USER_DATA);

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
  const quitHooks: Array<() => void | Promise<void>> = [];

  const emit = createEmitter(() => (mainWindow && !mainWindow.isDestroyed() ? [mainWindow.webContents] : []), log);
  const agentEvents = createAgentEventBatcher(emit);
  const roots = new AllowedRoots();

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  let quitting = false;
  app.on('will-quit', (event) => {
    log.debug('will-quit', { quitting, hooks: quitHooks.length });
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    agentEvents.dispose();
    const timeout = new Promise<void>((r) => setTimeout(r, 3000));
    void Promise.race([Promise.allSettled(quitHooks.map(async (fn) => fn())), timeout]).finally(() => {
      log.debug('quit hooks done');
      // app.quit() is a no-op after will-quit was prevented; exit explicitly.
      app.exit(0);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  await app.whenReady();

  hardenApp({ isAppUrl, dev: Boolean(devServerUrl) });
  setMenu();

  const userDataDir = app.getPath('userData');
  roots.add(userDataDir, 'app-data');

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
    onQuit: (fn) => quitHooks.push(fn),
  };

  const router = new IpcRouter({ log, validateOutput: true });
  const services = await createServices(ctx);
  registerAllHandlers(router, services, ctx);
  attachRouter(router, ipcMain, isAppUrl);

  mainWindow = createWindow(userDataDir);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('did-finish-load', () => setTimeout(() => services.flushNotices(), 500));
  if (devServerUrl) await mainWindow.loadURL(devServerUrl);
  else await mainWindow.loadFile(join(rendererDir, 'index.html'));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(userDataDir);
      if (devServerUrl) void mainWindow.loadURL(devServerUrl);
      else void mainWindow.loadFile(join(rendererDir, 'index.html'));
    }
  });
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
