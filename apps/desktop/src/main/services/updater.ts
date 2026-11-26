import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { publishTarget, type PublishTarget, type Settings, type UpdateChannel, type UpdateStatus } from '@oide/protocol';

/**
 * Auto-update on GitHub Releases (M7), wrapping electron-updater. See docs/wiki/pages/packaging.md.
 *
 * Consent rules (never broken):
 * - `autoDownload` and `autoInstallOnAppQuit` are off. A check only finds out whether a newer
 *   version exists; downloading is a click (`updates.download`) and installing is another click
 *   (`updates.install` with `consent: true`), which quits oIDE and runs the installer.
 * - Off unless the build was given a release feed (`OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO` at build
 *   time, see `buildPublishTarget`): the GitHub org is not claimed yet, so no default feed exists.
 * - Off in development builds, in builds without `app-update.yml`, for the Windows portable zip
 *   (it carries `app-update.yml` too, because electron-builder packs the zip and the NSIS installer
 *   from one folder, but running the installer would add a second, installed copy instead of updating
 *   the portable one), for Linux deb/rpm installs (the package manager updates those) and when
 *   `OIDE_DISABLE_UPDATES=1`.
 * - Unsigned macOS builds can check but cannot install (Squirrel.Mac only installs signed apps), so
 *   `canInstall` is false and the UI links to the release page instead.
 *
 * Channels: `stable` asks GitHub for the release marked latest (prereleases and drafts never are)
 * and reads its `latest*.yml`. `beta` allows prereleases: electron-updater takes the newest release
 * in the repository's releases feed, stable or prerelease, tries `beta*.yml` and falls back to
 * `latest*.yml`. electron-builder's GitHub publisher only writes `latest*.yml` (it ignores
 * `generateUpdatesFilesForAllChannels`), so that fallback is what beta users read. Downgrades are
 * never offered: going back from beta to stable waits for the next stable version above the
 * installed beta.
 */

/** Injected by electron-vite (`define` in electron.vite.config.ts) from the build's env; absent in tests. */
declare const __OIDE_PUBLISH_OWNER__: string | undefined;
declare const __OIDE_PUBLISH_REPO__: string | undefined;

/**
 * The GitHub Releases feed this build was configured with, or null. The release workflow sets
 * `OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO` (repository variables) for both the bundle and
 * electron-builder's `-c.publish.*`, so `app-update.yml` and this value name the same repo.
 * Local and CI builds without them have no feed, and the updater stays off.
 */
export function buildPublishTarget(): PublishTarget | null {
  const owner = typeof __OIDE_PUBLISH_OWNER__ === 'string' ? __OIDE_PUBLISH_OWNER__ : undefined;
  const repo = typeof __OIDE_PUBLISH_REPO__ === 'string' ? __OIDE_PUBLISH_REPO__ : undefined;
  return publishTarget(owner, repo);
}

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The part of electron-updater's `AppUpdater` oIDE uses (mocked in tests). */
export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  channel: string | null;
  logger: { info(m?: unknown): void; warn(m?: unknown): void; error(m?: unknown): void; debug?(m: string): void } | null;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- electron-updater's own listener type
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface UpdateInfoLike {
  version: string;
  releaseName?: string | null;
  releaseDate?: string;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
}

export interface UpdaterOptions {
  currentVersion: string;
  platform: NodeJS.Platform;
  /** `!app.isPackaged`. */
  isDev: boolean;
  settings: { get(): Settings; onChange(fn: (s: Settings) => void): () => void };
  emit(status: UpdateStatus): void;
  log: { debug(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** Where `lastCheckedAt` survives restarts (`<userData>/updates.json`). */
  stateFile: string;
  /** Loads electron-updater's `autoUpdater` (lazy, so dev and tests never touch it). */
  load?: () => Promise<AppUpdaterLike>;
  /** Env to read (`OIDE_DISABLE_UPDATES`, `APPIMAGE`); default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** True when the packaged app carries `app-update.yml`; default checks `process.resourcesPath`. */
  hasUpdateConfig?: () => boolean;
  /**
   * Windows: true when oIDE runs from an NSIS install (its uninstaller sits next to the exe), false
   * for the portable zip. Default looks for `Uninstall *.exe` next to `process.execPath`.
   */
  isWindowsInstall?: () => boolean;
  /** macOS: true when the running app is Developer ID signed; default asks `codesign`. */
  isMacSigned?: () => Promise<boolean>;
  /** Run background checks (startup + every 6 h) when Settings allow. Default true. */
  background?: boolean;
  /** Called once per finished check (telemetry `update_checked`; main decides whether to send). */
  onChecked?: (e: { outcome: UpdateCheckOutcome; channel: UpdateChannel }) => void;
  /** The release feed; default `buildPublishTarget()`. null: this build has none, updates are off. */
  publish?: PublishTarget | null;
  now?: () => number;
}

export async function loadElectronUpdater(): Promise<AppUpdaterLike> {
  // electron-updater is CommonJS; ESM sees it as a default export (or named, depending on the bundler).
  const mod = (await import('electron-updater')) as unknown as { autoUpdater?: AppUpdaterLike; default?: { autoUpdater: AppUpdaterLike } };
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!updater) throw new Error('electron-updater did not export autoUpdater');
  return updater;
}

function defaultHasUpdateConfig(): boolean {
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return Boolean(res && existsSync(join(res, 'app-update.yml')));
}

/** The NSIS installer puts `Uninstall <productName>.exe` in the install folder; the portable zip has none. */
function defaultIsWindowsInstall(): boolean {
  try {
    return readdirSync(dirname(process.execPath)).some((f) => /^Uninstall .+.exe$/i.test(f));
  } catch {
    return false;
  }
}

/** `codesign -dv` on the .app bundle; Developer ID signatures name their authority. */
function defaultIsMacSigned(): Promise<boolean> {
  // process.execPath = /Applications/oIDE.app/Contents/MacOS/oIDE
  const bundle = dirname(dirname(dirname(process.execPath)));
  return new Promise((resolve) => {
    execFile('codesign', ['-dv', '--verbose=2', bundle], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return resolve(false);
      resolve(/Authority=Developer ID Application/.test(`${stdout}\n${stderr}`));
    });
  });
}

/** GitHub release notes arrive as HTML; the Settings row shows plain text. */
export function plainNotes(notes: UpdateInfoLike['releaseNotes']): string | undefined {
  if (!notes) return undefined;
  const html = typeof notes === 'string' ? notes : notes.map((n) => `${n.version}\n${n.note ?? ''}`).join('\n\n');
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, 4000) : undefined;
}

/**
 * What a failed check means for the Settings row. electron-updater's GitHub provider reports "no
 * release is published yet" as an error; for the user that is simply "no newer version".
 */
export function checkFailure(err: unknown): { state: 'not-available'; reason: 'no_release' } | { state: 'error'; reason: 'feed_missing' | 'error'; error: string } {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') return { state: 'not-available', reason: 'no_release' };
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    // A release's tag is in the feed before its files are public (a draft still being built and
    // published, or a release published without its latest*.yml).
    return { state: 'error', reason: 'feed_missing', error: 'The newest release on GitHub has no update file for this platform yet. It may still be publishing; try again later.' };
  }
  return { state: 'error', reason: 'error', error: errorText(err) };
}

/** How a finished check ended, for the `update_checked` telemetry event (no free text). */
export type UpdateCheckOutcome = 'available' | 'not_available' | ReturnType<typeof checkFailure>['reason'];

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // electron-updater errors can carry whole HTTP responses; keep the first line.
  return (msg.split('\n')[0] ?? msg).slice(0, 300) || 'Update failed';
}

/** A change to the status; `undefined` removes a field. */
type StatusPatch = Partial<{ [K in keyof UpdateStatus]: UpdateStatus[K] | undefined }>;

export class UpdaterService {
  private status: UpdateStatus;
  private updater: AppUpdaterLike | null = null;
  private loading: Promise<AppUpdaterLike | null> | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private offSettings: (() => void) | null = null;
  private checking: Promise<UpdateStatus> | null = null;
  private appliedChannel: UpdateChannel;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly releasesUrl: string | undefined;
  private readonly target: PublishTarget | null;

  constructor(private readonly opts: UpdaterOptions) {
    this.env = opts.env ?? process.env;
    this.target = opts.publish === undefined ? buildPublishTarget() : opts.publish;
    this.releasesUrl = this.target?.releasesUrl;
    this.now = opts.now ?? Date.now;
    const channel = opts.settings.get().updates.channel;
    this.appliedChannel = channel;
    const lastCheckedAt = this.readLastChecked();
    const disabledReason = this.disabledReason();
    this.status = {
      state: disabledReason ? 'disabled' : 'idle',
      currentVersion: opts.currentVersion,
      channel,
      canInstall: !disabledReason,
      ...(this.releasesUrl ? { releaseUrl: this.releasesUrl } : {}),
      ...(disabledReason ? { disabledReason } : {}),
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
    };
  }

  /** Why this build does not update itself, or undefined when it does. */
  private disabledReason(): string | undefined {
    const { opts, env } = this;
    if (env.OIDE_DISABLE_UPDATES === '1') return 'Updates are turned off for this install (OIDE_DISABLE_UPDATES).';
    if (opts.isDev) return 'Updates are off in development builds.';
    if (!this.target) return 'This build has no release feed (it was built without OIDE_PUBLISH_OWNER and OIDE_PUBLISH_REPO), so it never checks for updates. Download new versions by hand.';
    if (opts.platform === 'linux' && !env.APPIMAGE) return 'Installed from a .deb or .rpm package: update oIDE through your package manager.';
    if (!(opts.hasUpdateConfig ?? defaultHasUpdateConfig)()) return 'This build has no update configuration (for example a portable zip). Download new versions from the releases page.';
    if (opts.platform === 'win32' && !(opts.isWindowsInstall ?? defaultIsWindowsInstall)()) return 'This is the portable zip, which does not update itself. Download new versions from the releases page, or use the installer to get automatic updates.';
    return undefined;
  }

  get enabled(): boolean {
    return this.status.state !== 'disabled';
  }

  getStatus(): UpdateStatus {
    return structuredClone(this.status);
  }

  /** Background checks and the settings listener. Safe to call once at startup. */
  start(): void {
    if (!this.enabled) return;
    this.offSettings = this.opts.settings.onChange((s) => this.onSettings(s));
    if (this.opts.background === false) return;
    const tick = () => {
      if (this.opts.settings.get().updates.checkAutomatically) void this.check().catch(() => undefined);
    };
    this.timers.push(setTimeout(tick, FIRST_CHECK_DELAY_MS));
    this.timers.push(setInterval(tick, CHECK_INTERVAL_MS));
  }

  dispose(): void {
    for (const t of this.timers.splice(0)) clearTimeout(t);
    this.offSettings?.();
    this.offSettings = null;
  }

  /** Ask GitHub Releases whether a newer version exists on the current channel. Never downloads. */
  async check(): Promise<UpdateStatus> {
    if (!this.enabled) return this.getStatus();
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') return this.getStatus();
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const u = await this.ensure();
      if (!u) return this.getStatus();
      this.set({ state: 'checking', error: undefined });
      let outcome: UpdateCheckOutcome = 'error';
      try {
        await u.checkForUpdates();
        // The 'update-available' / 'update-not-available' / 'error' listeners set the state; a null
        // result (updater inactive) leaves 'checking', so settle it here.
        if (this.status.state === 'checking') this.set({ state: 'not-available' });
        outcome = this.status.state === 'available' ? 'available' : this.status.state === 'error' ? 'error' : 'not_available';
      } catch (err) {
        outcome = checkFailure(err).reason;
        this.set(this.failedCheck(err));
      } finally {
        this.markChecked();
      }
      try {
        this.opts.onChecked?.({ outcome, channel: this.status.channel });
      } catch (err) {
        this.opts.log.warn('update check observer failed', err);
      }
      return this.getStatus();
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** The user clicked Download. Only valid after a check found an update this build can install. */
  async download(): Promise<UpdateStatus> {
    if (!this.enabled || this.status.state !== 'available' || !this.status.canInstall) return this.getStatus();
    const u = await this.ensure();
    if (!u) return this.getStatus();
    this.set({ state: 'downloading', progress: 0, error: undefined });
    u.downloadUpdate().catch((err: unknown) => this.set({ state: 'error', error: errorText(err), progress: undefined }));
    return this.getStatus();
  }

  /**
   * The user clicked Restart to update. Quits oIDE (quit hooks deny pending permission prompts and
   * stop agents as on any quit) and runs the downloaded installer.
   */
  install(consent: boolean): void {
    if (consent !== true) throw new Error('Installing an update needs the user to confirm it.');
    if (!this.updater || this.status.state !== 'downloaded') throw new Error('No downloaded update to install.');
    this.opts.log.debug('quitAndInstall', this.status.available?.version);
    // isSilent=false (show the installer UI on Windows), isForceRunAfter=true (start oIDE again).
    this.updater.quitAndInstall(false, true);
  }

  // ---------------------------------------------------------------- internals

  private async ensure(): Promise<AppUpdaterLike | null> {
    if (this.updater) return this.updater;
    this.loading ??= (async () => {
      try {
        const u = await (this.opts.load ?? loadElectronUpdater)();
        this.configure(u);
        if (this.opts.platform === 'darwin') {
          const signed = await (this.opts.isMacSigned ?? defaultIsMacSigned)().catch(() => false);
          if (!signed) this.set({ canInstall: false });
        }
        this.updater = u;
        return u;
      } catch (err) {
        this.opts.log.error('electron-updater failed to load', err);
        this.set({ state: 'error', error: `Updater unavailable: ${errorText(err)}` });
        this.loading = null;
        return null;
      }
    })();
    return this.loading;
  }

  private configure(u: AppUpdaterLike): void {
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    const log = this.opts.log;
    u.logger = { info: (m) => log.debug('[updater]', m), warn: (m) => log.warn('[updater]', m), error: (m) => log.error('[updater]', m) };
    this.applyChannel(u, this.appliedChannel);

    u.on('checking-for-update', () => this.set({ state: 'checking' }));
    u.on('update-available', (info: UpdateInfoLike) => this.set({ state: 'available', available: this.infoOf(info), releaseUrl: this.releasesUrl ? `${this.releasesUrl}/tag/v${info.version}` : undefined }));
    u.on('update-not-available', () => this.set({ state: 'not-available', available: undefined, releaseUrl: this.releasesUrl }));
    u.on('download-progress', (p: { percent?: number }) => {
      const progress = Math.max(0, Math.min(1, (p.percent ?? 0) / 100));
      this.set({ state: 'downloading', progress });
    });
    u.on('update-downloaded', (info: UpdateInfoLike) => this.set({ state: 'downloaded', progress: 1, available: this.infoOf(info) }));
    u.on('error', (err: unknown) => {
      // The same error also rejects checkForUpdates(); a check maps it there too.
      if (this.status.state === 'checking') this.set(this.failedCheck(err));
      else this.set({ state: 'error', error: errorText(err), progress: undefined });
    });
  }

  private failedCheck(err: unknown): StatusPatch {
    const f = checkFailure(err);
    if (f.state === 'not-available') this.opts.log.debug('no published release yet', errorText(err));
    return f.state === 'not-available'
      ? { state: 'not-available', available: undefined, error: undefined, releaseUrl: this.releasesUrl }
      : { state: 'error', error: f.error, progress: undefined };
  }

  private applyChannel(u: AppUpdaterLike, channel: UpdateChannel): void {
    // Setting `channel` turns allowDowngrade on; set it back explicitly afterwards.
    u.channel = channel === 'beta' ? 'beta' : 'latest';
    u.allowPrerelease = channel === 'beta';
    u.allowDowngrade = false;
  }

  private onSettings(s: Settings): void {
    const channel = s.updates.channel;
    if (channel === this.appliedChannel) return;
    this.appliedChannel = channel;
    if (this.updater) this.applyChannel(this.updater, channel);
    // A found (not yet downloaded) update belongs to the old channel; forget it.
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') this.set({ channel });
    else this.set({ channel, state: 'idle', available: undefined, error: undefined, releaseUrl: this.releasesUrl });
  }

  private infoOf(info: UpdateInfoLike): NonNullable<UpdateStatus['available']> {
    const notes = plainNotes(info.releaseNotes);
    return {
      version: info.version,
      ...(info.releaseName ? { releaseName: info.releaseName } : {}),
      ...(info.releaseDate ? { releaseDate: info.releaseDate } : {}),
      ...(notes ? { releaseNotes: notes } : {}),
    };
  }

  private set(patch: StatusPatch): void {
    const next = { ...this.status, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    this.status = next as UpdateStatus;
    this.opts.emit(this.getStatus());
  }

  private markChecked(): void {
    const at = this.now();
    this.set({ lastCheckedAt: at });
    try {
      mkdirSync(dirname(this.opts.stateFile), { recursive: true });
      writeFileSync(this.opts.stateFile, JSON.stringify({ lastCheckedAt: at }));
    } catch (err) {
      this.opts.log.warn('could not save update state', err);
    }
  }

  private readLastChecked(): number | undefined {
    try {
      const v = (JSON.parse(readFileSync(this.opts.stateFile, 'utf8')) as { lastCheckedAt?: unknown }).lastCheckedAt;
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }
}
