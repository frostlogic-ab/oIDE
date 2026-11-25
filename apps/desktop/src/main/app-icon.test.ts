import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandAppShortcuts, resolveAppIcon, type ShortcutInfo } from './app-icon.js';

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

describe('brandAppShortcuts', () => {
  const programs = 'C:\Users\u\AppData\Roaming\Microsoft\Windows\Start Menu\Programs';
  const exe = 'C:\repo\node_modules\electron\dist\electron.exe';
  const icon = 'C:\repo\apps\desktop\build\icon.ico';
  const o = { execPath: exe, appId: 'dev.oide.app', icon };

  function run(shortcuts: Record<string, ShortcutInfo | Error>, setIcon: (p: string) => boolean = () => true) {
    const set: string[] = [];
    const updated = brandAppShortcuts(
      {
        list: () => Object.keys(shortcuts).map((n) => `${programs}\${n}`),
        read: (p) => {
          const s = shortcuts[p.slice(programs.length + 1)]!;
          if (s instanceof Error) throw s;
          return s;
        },
        setIcon: (p, i) => {
          expect(i).toBe(icon);
          set.push(p);
          return setIcon(p);
        },
      },
      o,
    );
    return { updated, set };
  }

  it("gives Electron's notification shortcut for this exe and AUMID the oIDE icon", () => {
    const { updated } = run({ 'Electron.lnk': { target: exe, appUserModelId: 'dev.oide.app', icon: '', iconIndex: 0 } });
    expect(updated).toEqual([`${programs}\Electron.lnk`]);
  });

  it('matches paths case-insensitively and skips a shortcut that already has the icon', () => {
    const { set } = run({ 'Electron.lnk': { target: exe.toUpperCase(), appUserModelId: 'dev.oide.app', icon: icon.toLowerCase(), iconIndex: 0 } });
    expect(set).toEqual([]);
  });

  it('fixes a stale icon path or index', () => {
    const { updated } = run({
      'a.lnk': { target: exe, appUserModelId: 'dev.oide.app', icon: 'C:\old\worktree\icon.ico', iconIndex: 0 },
      'b.lnk': { target: exe, appUserModelId: 'dev.oide.app', icon, iconIndex: 3 },
    });
    expect(updated).toHaveLength(2);
  });

  it('leaves other apps, other exes, unreadable and refused shortcuts alone', () => {
    const { updated, set } = run(
      {
        'Other.lnk': { target: exe, appUserModelId: 'electron.app.Other' },
        'NoId.lnk': { target: exe },
        'Installed.lnk': { target: 'C:\Program Files\oIDE\oide.exe', appUserModelId: 'dev.oide.app' },
        'NoTarget.lnk': { target: '', appUserModelId: 'dev.oide.app' },
        'Broken.lnk': new Error('not a shortcut'),
        'Locked.lnk': { target: exe, appUserModelId: 'dev.oide.app' },
      },
      () => false,
    );
    expect(set).toEqual([`${programs}\Locked.lnk`]);
    expect(updated).toEqual([]);
  });

  it('survives a writer that throws', () => {
    const { updated } = run({ 'Electron.lnk': { target: exe, appUserModelId: 'dev.oide.app' } }, () => {
      throw new Error('access denied');
    });
    expect(updated).toEqual([]);
  });
});
