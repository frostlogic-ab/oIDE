import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_USER_MODEL_ID, appUserModelId, brandAppShortcuts, DEV_APP_USER_MODEL_ID, releaseForeignShortcuts, resolveAppIcon, type ShortcutInfo } from './app-icon.js';

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
  const programs = win32.join('C:/', 'Users', 'u', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const exe = win32.join('C:/', 'repo', 'node_modules', 'electron', 'dist', 'electron.exe');
  const icon = win32.join('C:/', 'repo', 'apps', 'desktop', 'build', 'icon.ico');
  const lnk = (name: string): string => win32.join(programs, name);
  const o = { execPath: exe, appId: 'dev.oide.app', icon };

  function run(shortcuts: Record<string, ShortcutInfo | Error>, setIcon: (p: string) => boolean = () => true) {
    const set: string[] = [];
    const updated = brandAppShortcuts(
      {
        list: () => Object.keys(shortcuts).map(lnk),
        read: (p) => {
          const s = shortcuts[p.slice(programs.length + 1)]!;
          if (s instanceof Error) throw s;
          return s;
        },
        setIcon: (p, i, target) => {
          expect(i).toBe(icon);
          expect(target).toBe((shortcuts[p.slice(programs.length + 1)] as ShortcutInfo).target);
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
    expect(updated).toEqual([lnk('Electron.lnk')]);
  });

  it('matches paths case-insensitively and skips a shortcut that already has the icon', () => {
    const { set } = run({ 'Electron.lnk': { target: exe.toUpperCase(), appUserModelId: 'dev.oide.app', icon: icon.toLowerCase(), iconIndex: 0 } });
    expect(set).toEqual([]);
  });

  it('fixes a stale icon path or index', () => {
    const { updated } = run({
      'a.lnk': { target: exe, appUserModelId: 'dev.oide.app', icon: win32.join('C:/', 'old', 'worktree', 'icon.ico'), iconIndex: 0 },
      'b.lnk': { target: exe, appUserModelId: 'dev.oide.app', icon, iconIndex: 3 },
    });
    expect(updated).toHaveLength(2);
  });

  it('leaves other apps, other exes, unreadable and refused shortcuts alone', () => {
    const { updated, set } = run(
      {
        'Other.lnk': { target: exe, appUserModelId: 'electron.app.Other' },
        'NoId.lnk': { target: exe },
        'Installed.lnk': { target: win32.join('C:/', 'Program Files', 'oIDE', 'oide.exe'), appUserModelId: 'dev.oide.app' },
        'NoTarget.lnk': { target: '', appUserModelId: 'dev.oide.app' },
        'Broken.lnk': new Error('not a shortcut'),
        'Locked.lnk': { target: exe, appUserModelId: 'dev.oide.app' },
      },
      () => false,
    );
    expect(set).toEqual([lnk('Locked.lnk')]);
    expect(updated).toEqual([]);
  });

  it('survives a writer that throws', () => {
    const { updated } = run({ 'Electron.lnk': { target: exe, appUserModelId: 'dev.oide.app' } }, () => {
      throw new Error('access denied');
    });
    expect(updated).toEqual([]);
  });
});

describe('appUserModelId', () => {
  it('gives unpackaged runs their own taskbar identity, apart from the installed app', () => {
    expect(appUserModelId(true)).toBe('dev.oide.app');
    expect(appUserModelId(false)).toBe(DEV_APP_USER_MODEL_ID);
    expect(DEV_APP_USER_MODEL_ID).not.toBe(APP_USER_MODEL_ID);
  });

  it('keeps the installed id equal to electron-builder appId (the installer shortcut names the toasts)', () => {
    const yml = readFileSync(join(import.meta.dirname, '..', '..', 'electron-builder.yml'), 'utf8');
    expect(yml.split(/\r?\n/)).toContain(`appId: ${APP_USER_MODEL_ID}`);
  });
});

describe('releaseForeignShortcuts', () => {
  const programs = win32.join('C:/', 'Users', 'u', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const installed = win32.join('C:/', 'Users', 'u', 'AppData', 'Local', 'Programs', 'oide', 'oide.exe');
  const liveDev = win32.join('C:/', 'repo', 'node_modules', 'electron', 'dist', 'electron.exe');
  const goneDev = win32.join('C:/', 'deleted-worktree', 'node_modules', 'electron', 'dist', 'electron.exe');
  const lnk = (name: string): string => win32.join(programs, name);
  const o = { execPath: installed, appId: APP_USER_MODEL_ID, devAppId: DEV_APP_USER_MODEL_ID };

  function run(shortcuts: Record<string, ShortcutInfo | Error>, opts: { retag?: () => boolean; remove?: () => void } = {}) {
    const removedFiles: string[] = [];
    const retagCalls: Array<{ path: string; appId: string; target: string }> = [];
    const result = releaseForeignShortcuts(
      {
        list: () => Object.keys(shortcuts).map(lnk),
        read: (p) => {
          const s = shortcuts[p.slice(programs.length + 1)]!;
          if (s instanceof Error) throw s;
          return s;
        },
        exists: (p) => p !== goneDev,
        remove: (p) => {
          opts.remove?.();
          removedFiles.push(p);
        },
        setAppUserModelId: (path, appId, target) => {
          retagCalls.push({ path, appId, target });
          return opts.retag ? opts.retag() : true;
        },
      },
      o,
    );
    return { ...result, removedFiles, retagCalls };
  }

  it("removes a deleted worktree's Electron.lnk that carried the installed app's AUMID (the blank taskbar icon)", () => {
    const r = run({ 'Electron.lnk': { target: goneDev, appUserModelId: APP_USER_MODEL_ID, icon: win32.join('C:/', 'deleted-worktree', 'icon.ico') } });
    expect(r.removed).toEqual([lnk('Electron.lnk')]);
    expect(r.retagCalls).toEqual([]);
  });

  it('moves a live dev shortcut to the dev AUMID instead of deleting it', () => {
    const r = run({ 'Electron.lnk': { target: liveDev, appUserModelId: APP_USER_MODEL_ID } });
    expect(r.removedFiles).toEqual([]);
    expect(r.retagged).toEqual([lnk('Electron.lnk')]);
    expect(r.retagCalls).toEqual([{ path: lnk('Electron.lnk'), appId: DEV_APP_USER_MODEL_ID, target: liveDev }]);
  });

  it("keeps the installer's shortcuts, other apps' and unreadable shortcuts", () => {
    const r = run({
      'oIDE.lnk': { target: installed.toUpperCase(), appUserModelId: APP_USER_MODEL_ID },
      'Other.lnk': { target: goneDev, appUserModelId: 'electron.app.Other' },
      'NoId.lnk': { target: goneDev },
      'Dev.lnk': { target: goneDev, appUserModelId: DEV_APP_USER_MODEL_ID },
      'Broken.lnk': new Error('not a shortcut'),
    });
    expect(r.removedFiles).toEqual([]);
    expect(r.retagCalls).toEqual([]);
  });

  it('survives a refused or throwing writer', () => {
    expect(run({ 'a.lnk': { target: liveDev, appUserModelId: APP_USER_MODEL_ID } }, { retag: () => false }).retagged).toEqual([]);
    const r = run(
      { 'a.lnk': { target: goneDev, appUserModelId: APP_USER_MODEL_ID }, 'b.lnk': { target: liveDev, appUserModelId: APP_USER_MODEL_ID } },
      {
        remove: () => {
          throw new Error('access denied');
        },
      },
    );
    expect(r.removed).toEqual([]);
    expect(r.retagged).toEqual([lnk('b.lnk')]);
  });
});
