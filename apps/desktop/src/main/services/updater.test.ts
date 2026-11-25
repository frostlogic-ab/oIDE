import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishTarget, Settings, UpdateStatus } from '@oide/protocol';
import { buildPublishTarget, loadElectronUpdater, plainNotes, UpdaterService, type AppUpdaterLike, type UpdaterOptions } from './updater.js';

/** Stand-in for electron-updater's autoUpdater: records calls, lets tests fire its events. */
class FakeUpdater extends EventEmitter implements AppUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  allowDowngrade = false;
  private _channel: string | null = null;
  logger: AppUpdaterLike['logger'] = null;
  checkForUpdates = vi.fn(async (): Promise<unknown> => {
    this.emit('checking-for-update');
    return null;
  });
  downloadUpdate = vi.fn(async (): Promise<unknown> => []);
  quitAndInstall = vi.fn();
  get channel() {
    return this._channel;
  }
  set channel(v: string | null) {
    this._channel = v;
    // electron-updater turns allowDowngrade on whenever the channel is set.
    this.allowDowngrade = true;
  }
}

/** A configured release feed (as the release workflow would inject); the default build has none. */
const TARGET = publishTarget('example-owner', 'oide')!;
const RELEASES_URL = TARGET.releasesUrl;

const fake = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('electron-updater', () => ({ autoUpdater: fake.current }));

function settingsStub(initial: Partial<Settings['updates']> = {}) {
  let s = Settings.parse({ claude: {}, models: {}, agents: { notifications: {} }, techniques: [], permissions: {}, ui: {}, updates: initial });
  const listeners = new Set<(s: Settings) => void>();
  return {
    get: () => s,
    onChange: (fn: (s: Settings) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(updates: Partial<Settings['updates']>) {
      s = { ...s, updates: { ...s.updates, ...updates } };
      for (const fn of listeners) fn(s);
    },
  };
}

let dir: string;
let updater: FakeUpdater;
let emitted: UpdateStatus[];
const services: UpdaterService[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oide-updater-'));
  updater = new FakeUpdater();
  fake.current = updater;
  emitted = [];
});
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function make(over: Partial<UpdaterOptions> = {}, settings = settingsStub()) {
  const svc = new UpdaterService({
    currentVersion: '0.1.0',
    platform: 'win32',
    isDev: false,
    settings,
    emit: (s) => emitted.push(UpdateStatus.parse(s)),
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    stateFile: join(dir, 'updates.json'),
    load: async () => updater,
    env: {},
    hasUpdateConfig: () => true,
    isMacSigned: async () => true,
    background: false,
    now: () => 1_700_000_000_000,
    publish: TARGET,
    ...over,
  });
  services.push(svc);
  return { svc, settings };
}

const info = { version: '0.2.0', releaseName: 'oIDE 0.2.0', releaseDate: '2026-12-01T00:00:00Z', releaseNotes: '<p>Faster <b>Wall</b></p><ul><li>One</li><li>Two &amp; three</li></ul>' };

describe('UpdaterService', () => {
  it('loads the real module through electron-updater (mocked)', async () => {
    expect(await loadElectronUpdater()).toBe(updater);
  });

  it('is off in development builds and never loads electron-updater there', async () => {
    const load = vi.fn(async () => updater);
    const { svc } = make({ isDev: true, load });
    expect(svc.getStatus()).toMatchObject({ state: 'disabled', disabledReason: expect.stringMatching(/development/), canInstall: false });
    expect((await svc.check()).state).toBe('disabled');
    expect((await svc.download()).state).toBe('disabled');
    expect(() => svc.install(true)).toThrow();
    expect(load).not.toHaveBeenCalled();
  });

it('is off unless the build was given a release feed (no default org), and never loads electron-updater then', async () => {
    expect(buildPublishTarget()).toBeNull(); // nothing injected outside a configured release build
    const load = vi.fn(async () => updater);
    for (const svc of [make({ publish: null, load }).svc, make({ publish: undefined, load }).svc]) {
      expect(svc.getStatus()).toMatchObject({ state: 'disabled', disabledReason: expect.stringMatching(/no release feed/), canInstall: false });
      expect(svc.getStatus().releaseUrl).toBeUndefined();
      expect((await svc.check()).state).toBe('disabled');
    }
    expect(load).not.toHaveBeenCalled();
    expect(publishTarget('', 'oide')).toBeNull();
    expect(publishTarget('a/b', 'oide')).toBeNull();
    expect(publishTarget('owner', '..')).toBeNull();
    expect(publishTarget(' owner ', 'repo')?.releasesUrl).toBe('https://github.com/owner/repo/releases');
  });

  it('is off for Linux deb/rpm installs, portable builds and OIDE_DISABLE_UPDATES', () => {
    expect(make({ platform: 'linux', env: {} }).svc.getStatus().disabledReason).toMatch(/package manager/);
    expect(make({ platform: 'linux', env: { APPIMAGE: '/x/oIDE.AppImage' } }).svc.getStatus().state).toBe('idle');
    expect(make({ hasUpdateConfig: () => false }).svc.getStatus().disabledReason).toMatch(/no update configuration/);
    expect(make({ env: { OIDE_DISABLE_UPDATES: '1' } }).svc.getStatus().state).toBe('disabled');
  });

  it('never downloads or installs on its own: autoDownload and autoInstallOnAppQuit are off', async () => {
    const { svc } = make();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', info);
      return { updateInfo: info };
    });
    const s = await svc.check();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(s).toMatchObject({ state: 'available', available: { version: '0.2.0', releaseName: 'oIDE 0.2.0' }, releaseUrl: `${RELEASES_URL}/tag/v0.2.0`, canInstall: true });
    expect(s.available?.releaseNotes).toBe('Faster Wall\n- One\n- Two & three');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('download → progress → downloaded, then install only with consent', async () => {
    const { svc } = make();
    expect(() => svc.install(true)).toThrow(/No downloaded update/);
    updater.checkForUpdates.mockImplementation(async () => (updater.emit('update-available', info), null));
    await svc.check();
    expect((await svc.download()).state).toBe('downloading');
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    updater.emit('download-progress', { percent: 42 });
    expect(svc.getStatus()).toMatchObject({ state: 'downloading', progress: 0.42 });
    // A check while downloading does not restart anything.
    await svc.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit('update-downloaded', info);
    expect(svc.getStatus()).toMatchObject({ state: 'downloaded', progress: 1 });
    expect(() => svc.install(false)).toThrow(/confirm/);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    svc.install(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(emitted.map((e) => e.state)).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'downloaded']));
  });

  it('download is refused before a check found an update', async () => {
    const { svc } = make();
    expect((await svc.download()).state).toBe('idle');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('stable channel: latest, no prereleases, no downgrades', async () => {
    const { svc } = make();
    await svc.check();
    expect(updater.channel).toBe('latest');
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(svc.getStatus().state).toBe('not-available');
  });

  it('beta channel: beta, prereleases allowed, still no downgrades; switching resets a found update', async () => {
    const settings = settingsStub({ channel: 'beta' });
    const { svc } = make({}, settings);
    svc.start();
    updater.checkForUpdates.mockImplementation(async () => (updater.emit('update-available', { version: '0.2.0-beta.1' }), null));
    await svc.check();
    expect(updater.channel).toBe('beta');
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
    expect(svc.getStatus()).toMatchObject({ state: 'available', channel: 'beta' });

    settings.set({ channel: 'stable' });
    expect(updater.channel).toBe('latest');
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(svc.getStatus()).toMatchObject({ state: 'idle', channel: 'stable' });
    expect(svc.getStatus().available).toBeUndefined();
  });

  it('remembers the last check across restarts', async () => {
    const { svc } = make();
    expect(svc.getStatus().lastCheckedAt).toBeUndefined();
    await svc.check();
    expect(svc.getStatus().lastCheckedAt).toBe(1_700_000_000_000);
    expect(JSON.parse(readFileSync(join(dir, 'updates.json'), 'utf8'))).toEqual({ lastCheckedAt: 1_700_000_000_000 });
    expect(make().svc.getStatus().lastCheckedAt).toBe(1_700_000_000_000);
  });

  it('ignores a corrupt state file', () => {
    writeFileSync(join(dir, 'updates.json'), '{nope');
    expect(make().svc.getStatus().lastCheckedAt).toBeUndefined();
  });

  it('errors become an error state with a short message, and the next check can recover', async () => {
    const { svc } = make();
    updater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED\n<html>…</html>'));
    expect(await svc.check()).toMatchObject({ state: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
    expect((await svc.check()).state).toBe('not-available');
  });

  it('a failing download reports an error', async () => {
    const { svc } = make();
    updater.checkForUpdates.mockImplementation(async () => (updater.emit('update-available', info), null));
    updater.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch'));
    await svc.check();
    await svc.download();
    await vi.waitFor(() => expect(svc.getStatus()).toMatchObject({ state: 'error', error: 'sha512 checksum mismatch' }));
  });

  it('unsigned macOS builds can check but not install: no Download, release page instead', async () => {
    const { svc } = make({ platform: 'darwin', isMacSigned: async () => false });
    updater.checkForUpdates.mockImplementation(async () => (updater.emit('update-available', info), null));
    expect(await svc.check()).toMatchObject({ state: 'available', canInstall: false, releaseUrl: `${RELEASES_URL}/tag/v0.2.0` });
    expect((await svc.download()).state).toBe('available');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('signed macOS builds install normally', async () => {
    const { svc } = make({ platform: 'darwin', isMacSigned: async () => true });
    updater.checkForUpdates.mockImplementation(async () => (updater.emit('update-available', info), null));
    expect((await svc.check()).canInstall).toBe(true);
  });

  it('a failing electron-updater load is an error state, not a crash', async () => {
    const { svc } = make({ load: async () => Promise.reject(new Error('Cannot find module')) });
    expect(await svc.check()).toMatchObject({ state: 'error', error: expect.stringMatching(/Updater unavailable/) });
  });

  it('background checks only when Settings › Check automatically is on', async () => {
    vi.useFakeTimers();
    const settings = settingsStub({ checkAutomatically: false });
    const { svc } = make({ background: true }, settings);
    svc.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    settings.set({ checkAutomatically: true });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    svc.dispose();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('concurrent checks share one request', async () => {
    const { svc } = make();
    await Promise.all([svc.check(), svc.check(), svc.check()]);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, 'updates.json'))).toBe(true);
  });
});

describe('plainNotes', () => {
  it('strips HTML and joins per-version notes', () => {
    expect(plainNotes(undefined)).toBeUndefined();
    expect(plainNotes('<h2>Hi</h2><p>a<br>b</p>')).toBe('Hi\na\nb');
    expect(plainNotes([{ version: '0.2.0', note: 'x' }, { version: '0.1.1', note: null }])).toBe('0.2.0\nx\n\n0.1.1');
  });
});
