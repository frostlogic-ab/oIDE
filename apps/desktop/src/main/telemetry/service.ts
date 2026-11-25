import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MAX_CONSENT_PROMPTS,
  screenPath,
  validateTelemetryEvent,
  type Settings,
  type TelemetryConsentInput,
  type TelemetryEventName,
  type TelemetryEventProps,
  type TelemetryScreen,
  type TelemetryStatus,
  type TelemetryTarget,
  type TelemetryUnavailableReason,
  type TelemetryValue,
} from '@oide/protocol';
import { z } from 'zod';
import type { Scrubber } from './scrub.js';
import {
  errorBody,
  eventBody,
  identifyBody,
  pageviewBody,
  performanceBody,
  UmamiClient,
  type ClientLogger,
  type Transport,
  type UmamiClientOptions,
  type UmamiContext,
  type Vitals,
} from './umami.js';

/**
 * The telemetry service in main (ADR 0011, docs/wiki/pages/telemetry.md). Main is the only sender.
 *
 * Consent rules, enforced here:
 * - Nothing is queued, let alone sent, unless the matching switch is on (`privacy.usageAnalytics`,
 *   `privacy.errorReports`; both default off). Before settings are known, errors wait in memory
 *   (at most 20) and are dropped unless the stored settings say yes.
 * - `unavailable` (no endpoint compiled in, DO_NOT_TRACK, OIDE_TELEMETRY=0, tests) means both
 *   switches count as off, no question is asked and no transport is ever created.
 * - Turning a switch off drops its queue at once (and cancels a request in flight when both are off).
 * - The anonymous install id is a random UUID made when a switch first goes on, kept in
 *   `<userData>/telemetry.json`, and deleted when both are off, so off-then-on gives a new id.
 * - Every event goes through the catalogue (`validateTelemetryEvent`): unknown names and invalid
 *   values are dropped, unknown properties stripped. Errors go through the scrubber.
 */

export interface TelemetryLogger extends ClientLogger {
  info?(...a: unknown[]): void;
}

export interface SettingsSource {
  get(): Settings;
  update(patch: Record<string, unknown>): Settings;
  onChange(fn: (s: Settings) => void): () => void;
}

export interface TelemetryServiceOptions {
  target: TelemetryTarget | null;
  /** Why this run may never send (env, tests), or null. A null target also makes it unavailable. */
  unavailable: TelemetryUnavailableReason | null;
  dev: boolean;
  appVersion: string;
  /** Session properties sent once per run with `identify` (all enum-like). */
  session: { os: string; osVersion: string; arch: string; electron: string };
  /** `<userData>/telemetry.json`: the install id and the last version that ran. */
  stateFile: string;
  scrubber: Scrubber;
  log?: TelemetryLogger;
  now?: () => number;
  uuid?: () => string;
  /** Overrides for the Umami client (tests). */
  client?: Partial<UmamiClientOptions>;
}

const State = z.object({ installId: z.uuid().optional(), lastVersion: z.string().max(40).optional() });
type State = z.infer<typeof State>;

export type ErrorSource =
  | 'uncaught'
  | 'unhandledrejection'
  | 'renderer-gone'
  | 'child-process-gone'
  | 'window'
  | 'boundary'
  | 'agent'
  | 'extension-host';

export interface ErrorInput {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

const SCREEN_TITLES: Record<TelemetryScreen, string> = {
  wall: 'Agents',
  focus: 'Focus',
  spawn: 'Spawn agent',
  'source-control': 'Source control',
  review: 'Review changes',
  files: 'Files',
  artifacts: 'Artifacts',
  marketplace: 'Marketplace',
  settings: 'Settings',
  extension: 'Extension',
};

export class TelemetryService {
  readonly client: UmamiClient | null;
  private state: State;
  private usage = false;
  private errors = false;
  private settingsKnown = false;
  private early: Array<{ e: ErrorInput; source: ErrorSource; process: string; handled: boolean }> = [];
  private ctx: Omit<UmamiContext, 'websiteId'>;
  private path = '/wall';
  private title = SCREEN_TITLES.wall;
  private shownThisRun = false;
  private dismissedThisRun = false;
  private optInSource: 'prompt' | 'settings' | null = null;
  private identified = false;
  private cliVersion: string | undefined;
  private channel = 'stable';
  private readonly seenErrors = new Map<string, number>();
  private readonly vitalsSent = new Map<string, number>();
  private settings: SettingsSource | null = null;

  constructor(private readonly o: TelemetryServiceOptions) {
    this.state = this.readState();
    this.ctx = {
      hostname: o.dev ? 'oide-dev' : 'oide',
      language: 'en-US',
      screen: '0x0',
      release: o.appVersion,
      environment: o.dev ? 'development' : 'production',
    };
    this.client =
      this.available && o.target
        ? new UmamiClient({
            target: o.target,
            hostname: this.ctx.hostname,
            ...(o.log ? { log: o.log } : {}),
            ...o.client,
          })
        : null;
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  get available(): boolean {
    return this.reason === null;
  }

  get reason(): TelemetryUnavailableReason | null {
    if (this.o.unavailable) return this.o.unavailable;
    if (!this.o.target) return 'compiled-out';
    return null;
  }

  get installId(): string | undefined {
    return this.state.installId;
  }

  get allowed(): { usage: boolean; errors: boolean } {
    return { usage: this.usage, errors: this.errors };
  }

  get currentPath(): string {
    return this.path;
  }

  /** Language and bucketed screen size (known once the app is ready). */
  setContext(c: { language?: string; screen?: string }): void {
    if (c.language && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(c.language))
      this.ctx.language = c.language.slice(0, 35);
    if (c.screen && /^\d{1,5}x\d{1,5}$/.test(c.screen)) this.ctx.screen = c.screen;
  }

  setTransport(t: Transport | null, isOnline?: () => boolean): void {
    if (!this.client) return;
    if (isOnline) this.client.setOnlineCheck(isOnline);
    this.client.setTransport(t);
  }

  /** Follow the settings store: the switches, consent bookkeeping and the update channel. */
  bindSettings(settings: SettingsSource): () => void {
    this.settings = settings;
    this.applySettings(settings.get(), true);
    return settings.onChange((s) => this.applySettings(s, false));
  }

  applySettings(s: Settings, initial = false): void {
    this.channel = s.updates?.channel ?? 'stable';
    const usage = this.available && s.privacy.usageAnalytics;
    const errors = this.available && s.privacy.errorReports;
    const wasUsage = this.usage;
    const wasAny = this.usage || this.errors;
    this.usage = usage;
    this.errors = errors;
    this.client?.setAllowed({ usage, errors });
    if (!usage && !errors) {
      if (this.state.installId) this.writeState({ ...this.state, installId: undefined });
      this.identified = false;
    } else if (!wasAny || !this.state.installId) {
      this.ensureInstallId();
    }
    if (usage && !wasUsage) {
      this.identified = false;
      if (!initial) {
        this.track('telemetry_opt_in', { source: this.optInSource ?? 'settings', errors });
        this.identify();
      }
    }
    this.optInSource = null;
    if (!this.settingsKnown) {
      this.settingsKnown = true;
      const early = this.early;
      this.early = [];
      for (const x of early) this.error(x.e, { source: x.source, process: x.process, handled: x.handled });
    }
  }

  status(): TelemetryStatus {
    const s = this.settings?.get();
    const answered = s?.privacy.consentAnswered ?? false;
    const shown = s?.privacy.consentPromptsShown ?? 0;
    const showPrompt =
      this.available &&
      !!s &&
      !answered &&
      !this.dismissedThisRun &&
      (this.shownThisRun || shown < MAX_CONSENT_PROMPTS);
    return {
      available: this.available,
      ...(this.reason ? { reason: this.reason } : {}),
      usageAnalytics: this.usage,
      errorReports: this.errors,
      showPrompt,
    };
  }

  /** The first-run question. `shown` counts once per run; `later` = closed without a choice. */
  consent(choice: TelemetryConsentInput['choice']): TelemetryStatus {
    const st = this.settings;
    if (!st || !this.available) return this.status();
    const s = st.get();
    if (choice === 'shown') {
      if (!this.shownThisRun && !s.privacy.consentAnswered) {
        this.shownThisRun = true;
        st.update({ privacy: { consentPromptsShown: Math.min(1000, s.privacy.consentPromptsShown + 1) } });
      }
    } else if (choice === 'later') {
      this.dismissedThisRun = true;
    } else if (choice === 'accept') {
      this.optInSource = 'prompt';
      st.update({ privacy: { usageAnalytics: true, errorReports: true, consentAnswered: true } });
    } else {
      st.update({ privacy: { usageAnalytics: false, errorReports: false, consentAnswered: true } });
    }
    return this.status();
  }

  // -------------------------------------------------------------------------------- usage

  /** A catalogue event. Dropped unless usage analytics is on and the event validates. */
  track<K extends TelemetryEventName>(
    name: K,
    props: TelemetryEventProps<K>,
    from: 'main' | 'renderer' = 'main',
  ): boolean {
    if (!this.usage || !this.client || !this.state.installId) return false;
    const v = validateTelemetryEvent(name, props, from);
    if (!v) {
      this.o.log?.debug(
        '[telemetry] dropped event not in the catalogue or invalid',
        String(name).slice(0, 50),
      );
      return false;
    }
    return this.client.enqueueUsage(
      eventBody(this.fullCtx(), this.state.installId, this.path, this.title, v.name, v.props),
    );
  }

  /** A renderer-reported event (`telemetry.track`): only renderer events from the catalogue. */
  trackFromRenderer(name: string, props: Record<string, TelemetryValue>): boolean {
    const v = validateTelemetryEvent(name, props, 'renderer');
    if (!v) return false;
    return this.track(v.name, v.props as never, 'renderer');
  }

  /** A screen view (synthetic URL such as `/settings/privacy`). Repeats of the current screen are skipped. */
  pageview(screen: TelemetryScreen, section?: string): boolean {
    const path = screenPath(screen, section);
    if (path === this.path && this.pageviewSent) return false;
    const referrer = path !== this.path ? this.path : undefined;
    this.path = path;
    this.title = SCREEN_TITLES[screen];
    this.pageviewSent = false;
    if (!this.usage || !this.client || !this.state.installId) return false;
    this.pageviewSent = this.client.enqueueUsage(
      pageviewBody(this.fullCtx(), this.state.installId, path, this.title, referrer),
    );
    return this.pageviewSent;
  }
  private pageviewSent = false;

  /** Web vitals of a screen visit; at most one per screen path per 30 minutes. */
  vitals(screen: TelemetryScreen, section: string | undefined, v: Vitals): boolean {
    if (!this.usage || !this.client || !this.state.installId) return false;
    const path = screenPath(screen, section);
    const last = this.vitalsSent.get(path) ?? -Infinity;
    if (this.now - last < 30 * 60_000) return false;
    const body = performanceBody(this.fullCtx(), this.state.installId, path, SCREEN_TITLES[screen], v);
    if (!body) return false;
    this.vitalsSent.set(path, this.now);
    return this.client.enqueueUsage(body);
  }

  /** The CLI version for session data and `app_started` (bucketed there). */
  setCliVersion(v: string | undefined): void {
    this.cliVersion = v;
  }

  /** Session properties, once per run: versions, channel, OS family and arch. All enum-like. */
  identify(): boolean {
    if (this.identified || !this.usage || !this.client || !this.state.installId) return false;
    this.identified = true;
    const data: Record<string, TelemetryValue> = {
      app_version: this.o.appVersion,
      channel: this.channel,
      os: this.o.session.os,
      os_version: this.o.session.osVersion,
      arch: this.o.session.arch,
      electron: this.o.session.electron,
      dev: this.o.dev,
    };
    const cli = /^(\d{1,3}\.\d{1,3}\.\d{1,6})/.exec(this.cliVersion ?? '')?.[1];
    if (cli) data.cli_version = cli;
    return this.client.enqueueUsage(identifyBody(this.fullCtx(), this.state.installId, data));
  }

  /**
   * Records the version that runs now; returns the previous one when it changed (an update was
   * installed). Local bookkeeping only; the caller decides whether to report it.
   */
  noteVersion(): { previous: string | undefined; changed: boolean } {
    const previous = this.state.lastVersion;
    if (previous !== this.o.appVersion) this.writeState({ ...this.state, lastVersion: this.o.appVersion });
    return { previous, changed: previous !== undefined && previous !== this.o.appVersion };
  }

  // ------------------------------------------------------------------------------- errors

  /**
   * An error report: name, scrubbed message and app-bundle frames only. Dropped unless error
   * reports are on; repeats of the same error within 10 minutes are dropped too.
   */
  error(
    e: ErrorInput | unknown,
    opts: { source: ErrorSource; process: string; handled?: boolean; tags?: Record<string, string> },
  ): boolean {
    const input: ErrorInput =
      e instanceof Error
        ? { name: e.name, message: e.message, stack: e.stack }
        : e && typeof e === 'object'
          ? (e as ErrorInput)
          : { name: 'Error', message: typeof e === 'string' ? e : 'Non-error value thrown' };
    if (!this.settingsKnown) {
      if (this.available && this.early.length < 20)
        this.early.push({
          e: input,
          source: opts.source,
          process: opts.process,
          handled: opts.handled ?? false,
        });
      return false;
    }
    if (!this.errors || !this.client || !this.state.installId) return false;
    const sc = this.o.scrubber;
    const name = sc.name(input.name);
    const message = sc.message(input.message);
    const stack = sc.stack(input.stack, name, message);
    const key = `${name}|${message}|${stack.split('\n')[1] ?? ''}`;
    const seen = this.seenErrors.get(key);
    if (seen !== undefined && this.now - seen < 10 * 60_000) return false;
    this.seenErrors.set(key, this.now);
    if (this.seenErrors.size > 500) this.seenErrors.delete(this.seenErrors.keys().next().value!);
    const tags: Record<string, string> = {
      process: opts.process.replace(/[^\w-]/g, '').slice(0, 40),
      source: opts.source,
    };
    for (const [k, v] of Object.entries(opts.tags ?? {}))
      if (/^[a-z_]{1,30}$/.test(k) && /^[\w./-]{1,60}$/.test(v)) tags[k] = v;
    return this.client.enqueueError(
      errorBody(this.fullCtx(), this.state.installId, {
        eventId: (this.o.uuid ?? randomUUID)(),
        timestamp: this.now,
        name,
        message,
        stack,
        handled: opts.handled ?? false,
        url: this.path,
        tags,
      }),
    );
  }

  flush(): Promise<void> {
    return this.client?.flush() ?? Promise.resolve();
  }

  shutdown(timeoutMs = 2_000): Promise<void> {
    return this.client?.shutdown(timeoutMs) ?? Promise.resolve();
  }

  // -------------------------------------------------------------------------------- state

  private fullCtx(): UmamiContext {
    return { websiteId: this.o.target!.websiteId, ...this.ctx };
  }

  private ensureInstallId(): void {
    if (this.state.installId) return;
    this.writeState({ ...this.state, installId: (this.o.uuid ?? randomUUID)() });
  }

  private readState(): State {
    try {
      const r = State.safeParse(JSON.parse(readFileSync(this.o.stateFile, 'utf8')));
      return r.success ? r.data : {};
    } catch {
      return {};
    }
  }

  private writeState(next: State): void {
    this.state = next;
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      const clean: State = {};
      if (next.installId) clean.installId = next.installId;
      if (next.lastVersion) clean.lastVersion = next.lastVersion;
      const tmp = `${this.o.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
      renameSync(tmp, this.o.stateFile);
    } catch (err) {
      this.o.log?.debug('[telemetry] could not save telemetry.json', (err as Error)?.message);
    }
  }
}

/**
 * Why telemetry may never send in this run, from the environment: `DO_NOT_TRACK=1`,
 * `OIDE_TELEMETRY=0|off|false`, or a test runner (Vitest, NODE_ENV=test). E2E launches set
 * `OIDE_TELEMETRY=0` (apps/desktop/e2e/app.ts) unless a test opts in with a file sink.
 */
export function unavailableReason(env: NodeJS.ProcessEnv): TelemetryUnavailableReason | null {
  const dnt = (env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  if (dnt === '1' || dnt === 'true' || dnt === 'yes') return 'do-not-track';
  const t = (env.OIDE_TELEMETRY ?? '').trim().toLowerCase();
  if (t === '0' || t === 'off' || t === 'false' || t === 'no') return 'env';
  if (env.VITEST || env.NODE_ENV === 'test') return 'test';
  return null;
}
