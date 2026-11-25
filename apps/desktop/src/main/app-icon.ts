import { join } from 'node:path';

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
