import { join, win32 } from 'node:path';

/** Windows taskbar identity; matches `appId` in electron-builder.yml so dev and installed builds group alike. */
export const APP_USER_MODEL_ID = 'dev.oide.app';

export interface AppIconInput {
  packaged: boolean;
  platform: NodeJS.Platform;
  /** apps/desktop when unpackaged (out/main/index.js is two levels below it in dev, e2e and `electron .`). */
  appPath: string;
  /** `process.resourcesPath` when packaged. */
  resourcesPath: string;
  exists: (path: string) => boolean;
}

export interface AppIcon {
  /** `BrowserWindow({ icon })` (Windows, Linux). */
  window?: string;
  /** `app.dock.setIcon` (macOS, unpackaged only: a packaged .app has its own icns). */
  dock?: string;
}

/**
 * The oIDE icon at runtime (docs/brand/README.md). Packaged Windows and macOS builds carry the icon
 * in the executable / bundle, so nothing is set there. Packaged Linux reads `<resources>/icon.png`
 * (extraResources). Unpackaged runs (`pnpm dev`, e2e, `electron .`) would otherwise show Electron's
 * default icon, so they point at apps/desktop/build (written by `pnpm icons`).
 */
export function resolveAppIcon(i: AppIconInput): AppIcon {
  const pick = (p: string): string | undefined => (i.exists(p) ? p : undefined);
  if (i.packaged) {
    return i.platform === 'linux' ? { window: pick(join(i.resourcesPath, 'icon.png')) } : {};
  }
  const build = join(i.appPath, 'build');
  switch (i.platform) {
    case 'win32':
      return { window: pick(join(build, 'icon.ico')) };
    case 'darwin':
      return { dock: pick(join(build, 'icon.png')) };
    default:
      return { window: pick(join(build, 'icons', '512x512.png')) };
  }
}

/** What `shell.readShortcutLink` reports, reduced to the fields the taskbar fix needs. */
export interface ShortcutInfo {
  target: string;
  appUserModelId?: string;
  icon?: string;
  iconIndex?: number;
}

export interface ShortcutIconDeps {
  /** Absolute paths of the `.lnk` files in the per-user Start Menu Programs folder. */
  list: () => string[];
  /** Throws when the file is not a readable shortcut. */
  read: (path: string) => ShortcutInfo;
  /** Sets the icon on an existing shortcut, keeping `target`; false when Windows refused. */
  setIcon: (path: string, icon: string, target: string) => boolean;
}

const samePath = (a: string, b: string): boolean => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();

/**
 * Windows, unpackaged runs only. For toast notifications Electron writes `<exe ProductName>.lnk`
 * (`Electron.lnk` for `pnpm dev`) into the Start Menu with our AppUserModelID, the running exe as target
 * and no icon. Windows then draws every window with that AUMID with the shortcut's icon, which is
 * electron.exe's, so the taskbar showed Electron's logo even though `BrowserWindow({ icon })` was set.
 * Electron's check for rewriting that shortcut compares target, working dir, AUMID and toast CLSID but not
 * the icon, so giving it the oIDE icon sticks. Only shortcuts that point at this exe with our AUMID are
 * touched; packaged builds don't need this (their exe carries the oIDE icon). Returns the paths updated.
 */
export function brandAppShortcuts(deps: ShortcutIconDeps, o: { execPath: string; appId: string; icon: string }): string[] {
  const updated: string[] = [];
  for (const path of deps.list()) {
    let info: ShortcutInfo;
    try {
      info = deps.read(path);
    } catch {
      continue;
    }
    if (info.appUserModelId !== o.appId || !info.target || !samePath(info.target, o.execPath)) continue;
    if (info.icon && samePath(info.icon, o.icon) && (info.iconIndex ?? 0) === 0) continue;
    try {
      if (deps.setIcon(path, o.icon, info.target)) updated.push(path);
    } catch {
      // Best effort: a locked or read-only shortcut only costs the taskbar icon.
    }
  }
  return updated;
}
