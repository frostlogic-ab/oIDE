import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppIcon } from './app-icon.js';

const appPath = join('/repo', 'apps', 'desktop');
const resourcesPath = join('/opt', 'oIDE', 'resources');
const all = () => true;

describe('resolveAppIcon', () => {
  it('points unpackaged runs at apps/desktop/build so the taskbar/dock shows the oIDE icon', () => {
    expect(resolveAppIcon({ packaged: false, platform: 'win32', appPath, resourcesPath, exists: all })).toEqual({ window: join(appPath, 'build', 'icon.ico') });
    expect(resolveAppIcon({ packaged: false, platform: 'linux', appPath, resourcesPath, exists: all })).toEqual({ window: join(appPath, 'build', 'icons', '512x512.png') });
    expect(resolveAppIcon({ packaged: false, platform: 'darwin', appPath, resourcesPath, exists: all })).toEqual({ dock: join(appPath, 'build', 'icon.png') });
  });

  it('leaves packaged Windows/macOS to the executable icon and gives Linux the shipped PNG', () => {
    expect(resolveAppIcon({ packaged: true, platform: 'win32', appPath, resourcesPath, exists: all })).toEqual({});
    expect(resolveAppIcon({ packaged: true, platform: 'darwin', appPath, resourcesPath, exists: all })).toEqual({});
    expect(resolveAppIcon({ packaged: true, platform: 'linux', appPath, resourcesPath, exists: all })).toEqual({ window: join(resourcesPath, 'icon.png') });
  });

  it('sets nothing when the file is missing', () => {
    expect(resolveAppIcon({ packaged: false, platform: 'win32', appPath, resourcesPath, exists: () => false })).toEqual({ window: undefined });
  });

  it('finds the real icons in this checkout', () => {
    const desktop = join(import.meta.dirname, '..', '..');
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const icon = resolveAppIcon({ packaged: false, platform, appPath: desktop, resourcesPath, exists: existsSync });
      expect(icon.window ?? icon.dock).toBeTruthy();
    }
  });
});
