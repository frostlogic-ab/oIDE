import type { TelemetryTarget, TelemetryValue } from '@oide/protocol';

/**
 * Umami collection client for main (ADR 0011). Payloads have the shapes Umami's own tracker sends
 * (server v3.5.0, `src/tracker/index.ts` and `src/tracker/errors.ts`; checked against
 * `src/app/api/send/request-schema.ts` and `src/lib/errors/schema.ts`):
 *
 * - pageview:     `{ type: 'event', payload: { website, hostname, language, screen, title, url, referrer, id } }`
 * - custom event: the same plus `name` and `data`
 * - identify:     `{ type: 'identify', payload: { website, hostname, language, screen, id, data } }` (session data)
 * - performance:  `{ type: 'performance', payload: { website, hostname, language, screen, title, url, id, fcp, lcp, cls, inp, ttfb } }`
 * - error:        `{ type: 'error', payload: { version: 1, website, eventId, timestamp (ms), name, message, stack, handled, url, id, screen, language, release, environment, tags } }`
 *
 * Usage payloads go in batches to `/api/batch` (an array of the bodies above; Umami forwards each to
 * `/api/send`), errors one by one to `/api/send`, as the tracker does. No `timestamp` on usage
 * payloads: Umami would treat them as historical imports. Headers as the tracker's:
 * `content-type`, `x-umami-website-id`, `x-umami-hostname`, and the `x-umami-cache` token the server
 * returned last (memory only).
 *
 * Resilience: in-memory queues (capped, dropped on quit: nothing is written to disk), small batches,
 * exponential backoff with jitter on network errors and 5xx (3 attempts, then the batch is dropped),
 * `Retry-After` on 429 (queues dropped, paused up to 5 min), a server answer of `disabled` or bot
 * stops sending for this run, and no request at all while offline, paused or not allowed.
 */

export interface UmamiContext {
  websiteId: string;
  /** `oide` (release builds) or `oide-dev` (unpackaged runs). */
  hostname: string;
  /** `en-US` */
  language: string;
  /** Bucketed: `1900x1000`. */
  screen: string;
  /** App version, e.g. `0.1.0`. */
  release: string;
  environment: 'production' | 'development';
}

export interface Vitals {
  fcp?: number;
  lcp?: number;
  cls?: number;
  inp?: number;
  ttfb?: number;
}

type Base = { website: string; hostname: string; language: string; screen: string; id: string };
export type UsageBody =
  | {
      type: 'event';
      payload: Base & {
        title: string;
        url: string;
        referrer?: string;
        name?: string;
        data?: Record<string, TelemetryValue>;
      };
    }
  | { type: 'identify'; payload: Base & { data: Record<string, TelemetryValue> } }
  | { type: 'performance'; payload: Base & { title: string; url: string } & Vitals };

export interface ErrorPayload {
  version: 1;
  website: string;
  eventId: string;
  timestamp: number;
  name: string;
  message: string;
  stack: string;
  handled: boolean;
  url: string;
  id: string;
  screen: string;
  language: string;
  release: string;
  environment: string;
  tags: Record<string, string>;
}
export type ErrorBody = { type: 'error'; payload: ErrorPayload };

const base = (c: UmamiContext, id: string): Base => ({
  website: c.websiteId,
  hostname: c.hostname,
  language: c.language,
  screen: c.screen,
  id,
});

export function pageviewBody(
  c: UmamiContext,
  id: string,
  url: string,
  title: string,
  referrer?: string,
): UsageBody {
  return { type: 'event', payload: { ...base(c, id), title, url, ...(referrer ? { referrer } : {}) } };
}

export function eventBody(
  c: UmamiContext,
  id: string,
  url: string,
  title: string,
  name: string,
  data: Record<string, TelemetryValue>,
): UsageBody {
  return {
    type: 'event',
    payload: { ...base(c, id), title, url, name, ...(Object.keys(data).length ? { data } : {}) },
  };
}

export function identifyBody(c: UmamiContext, id: string, data: Record<string, TelemetryValue>): UsageBody {
  return { type: 'identify', payload: { ...base(c, id), data } };
}

const clampVital = (v: number | undefined, max: number) =>
  v === undefined || !Number.isFinite(v) || v < 0 ? undefined : Math.min(max, Math.round(v * 10000) / 10000);

export function performanceBody(
  c: UmamiContext,
  id: string,
  url: string,
  title: string,
  v: Vitals,
): UsageBody | null {
  const vitals: Vitals = {};
  const set = (k: keyof Vitals, max: number) => {
    const x = clampVital(v[k], max);
    if (x !== undefined) vitals[k] = x;
  };
  set('fcp', 60_000);
  set('lcp', 60_000);
  set('inp', 60_000);
  set('ttfb', 60_000);
  set('cls', 100);
  if (!Object.keys(vitals).length) return null;
  return { type: 'performance', payload: { ...base(c, id), title, url, ...vitals } };
}

export function errorBody(
  c: UmamiContext,
  id: string,
  e: {
    eventId: string;
    timestamp: number;
    name: string;
    message: string;
    stack: string;
    handled: boolean;
    url: string;
    tags: Record<string, string>;
  },
): ErrorBody {
  return {
    type: 'error',
    payload: {
      version: 1,
      website: c.websiteId,
      eventId: e.eventId,
      timestamp: e.timestamp,
      name: e.name.slice(0, 200) || 'Error',
      message: e.message.slice(0, 2000),
      stack: e.stack.slice(0, 16_000),
      handled: e.handled,
      url: e.url.slice(0, 2000),
      id,
      screen: c.screen.slice(0, 11),
      language: c.language.slice(0, 35),
      release: c.release.slice(0, 100),
      environment: c.environment,
      tags: Object.fromEntries(
        Object.entries(e.tags)
          .slice(0, 20)
          .map(([k, v]) => [k.slice(0, 50), v.slice(0, 200)]),
      ),
    },
  };
}

// ---------------------------------------------------------------------------------- transport

export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
/** One POST. The Electron transport uses a dedicated session that can only reach the Umami host. */
export type Transport = (
  url: string,
  init: { body: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<TransportResponse>;

export interface ClientLogger {
  debug(...a: unknown[]): void;
  warn(...a: unknown[]): void;
}

export interface UmamiClientOptions {
  target: TelemetryTarget;
  hostname: string;
  transport?: Transport | null;
  isOnline?: () => boolean;
  now?: () => number;
  random?: () => number;
  log?: ClientLogger;
  /** Usage payloads per `/api/batch` request (default 20). */
  batchSize?: number;
  /** Queue caps; new items are dropped when full (defaults 200 usage, 20 errors). */
  maxUsageQueue?: number;
  maxErrorQueue?: number;
  /** Delay before a usage flush (default 30 s) and before an error flush (default 2 s). */
  flushMs?: number;
  errorFlushMs?: number;
  /** Attempts per batch before it is dropped (default 3). */
  maxAttempts?: number;
  /** First backoff after a failure (default 5 s, doubling, capped at `maxBackoffMs`, default 5 min). */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** How long to wait before looking again while offline (default 60 s). */
  offlineRetryMs?: number;
  /** Errors accepted per minute and per run (defaults 10 and 100). */
  errorsPerMinute?: number;
  errorsPerRun?: number;
  /** Requests per flush before yielding to the next timer (default 5). */
  maxRequestsPerFlush?: number;
  requestTimeoutMs?: number;
}

interface Item<B> {
  body: B;
  attempts: number;
}

export type SendOutcome = 'ok' | 'retry' | 'drop' | 'throttled' | 'stop';

export class UmamiClient {
  private usage: Array<Item<UsageBody>> = [];
  private errors: Array<Item<ErrorBody>> = [];
  private allowUsage = false;
  private allowErrors = false;
  private transport: Transport | null;
  private cache: string | undefined;
  private stopped = false;
  private pausedUntil = 0;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  private inflight: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private errorWindow = { start: 0, n: 0 };
  private errorsThisRun = 0;
  /** Requests made (for tests and the debug log). */
  requests = 0;

  constructor(private readonly o: UmamiClientOptions) {
    this.transport = o.transport ?? null;
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  setOnlineCheck(fn: () => boolean): void {
    this.o.isOnline = fn;
  }

  setTransport(t: Transport | null): void {
    this.transport = t;
    if (t && this.pending()) this.schedule(this.o.errorFlushMs ?? 2_000);
  }

  /** One switch per kind. Off drops that queue at once; both off also cancels an in-flight request. */
  setAllowed(a: { usage: boolean; errors: boolean }): void {
    this.allowUsage = a.usage;
    this.allowErrors = a.errors;
    if (!a.usage) this.usage = [];
    if (!a.errors) this.errors = [];
    if (!a.usage && !a.errors) {
      this.abort?.abort();
      this.cache = undefined;
      this.clearTimer();
    }
  }

  get allowed(): { usage: boolean; errors: boolean } {
    return { usage: this.allowUsage, errors: this.allowErrors };
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  queued(): { usage: UsageBody[]; errors: ErrorBody[] } {
    return { usage: this.usage.map((i) => i.body), errors: this.errors.map((i) => i.body) };
  }

  pending(): boolean {
    return this.usage.length + this.errors.length > 0;
  }

  enqueueUsage(body: UsageBody): boolean {
    if (!this.allowUsage || this.stopped) return false;
    if (this.usage.length >= (this.o.maxUsageQueue ?? 200)) return false;
    this.usage.push({ body, attempts: 0 });
    const size = this.o.batchSize ?? 20;
    this.schedule(this.usage.length >= size ? 0 : (this.o.flushMs ?? 30_000));
    return true;
  }

  enqueueError(body: ErrorBody): boolean {
    if (!this.allowErrors || this.stopped) return false;
    const now = this.now;
    if (now - this.errorWindow.start >= 60_000) this.errorWindow = { start: now, n: 0 };
    if (
      this.errorWindow.n >= (this.o.errorsPerMinute ?? 10) ||
      this.errorsThisRun >= (this.o.errorsPerRun ?? 100)
    )
      return false;
    if (this.errors.length >= (this.o.maxErrorQueue ?? 20)) return false;
    this.errorWindow.n++;
    this.errorsThisRun++;
    this.errors.push({ body, attempts: 0 });
    this.schedule(this.o.errorFlushMs ?? 2_000);
    return true;
  }

  /** Send what is queued now (bounded). Resolves when this flush is done; never throws. */
  flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.clearTimer();
    this.inflight = this.run()
      .catch((err) => this.o.log?.debug('[telemetry] flush failed', (err as Error)?.message))
      .finally(() => {
        this.inflight = null;
        if (this.pending() && !this.stopped && (this.allowUsage || this.allowErrors)) {
          const wait = Math.max(this.pausedUntil - this.now, 0);
          this.schedule(Math.max(wait, this.o.flushMs ?? 30_000));
        }
      });
    return this.inflight;
  }

  /** On quit: one last bounded flush, then nothing more. Unsent items are dropped (never persisted). */
  async shutdown(timeoutMs = 2_000): Promise<void> {
    this.clearTimer();
    if (this.pending() && this.transport && (this.allowUsage || this.allowErrors)) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.flush(), new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
      if (t) clearTimeout(t);
    }
    this.abort?.abort();
    this.stopped = true;
    this.usage = [];
    this.errors = [];
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = 0;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.transport) return;
    const at = this.now + Math.max(0, delayMs);
    if (this.timer && this.timerAt <= at) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerAt = 0;
        void this.flush();
      },
      Math.max(0, delayMs),
    );
    (this.timer as { unref?: () => void }).unref?.();
  }

  private backoff(): number {
    const base = this.o.backoffMs ?? 5_000;
    const max = this.o.maxBackoffMs ?? 300_000;
    const exp = Math.min(max, base * 2 ** Math.max(0, this.failures - 1));
    const jitter = 0.8 + (this.o.random ?? Math.random)() * 0.4;
    return Math.round(Math.min(max, exp * jitter));
  }

  private async run(): Promise<void> {
    const maxReq = this.o.maxRequestsPerFlush ?? 5;
    for (let i = 0; i < maxReq; i++) {
      if (this.stopped || !this.transport || (!this.allowUsage && !this.allowErrors)) return;
      if (this.now < this.pausedUntil) return;
      if (this.o.isOnline && !this.o.isOnline()) {
        this.pausedUntil = this.now + (this.o.offlineRetryMs ?? 60_000);
        return;
      }
      let outcome: SendOutcome;
      let items: Array<Item<UsageBody>> | Array<Item<ErrorBody>>;
      let kind: 'usage' | 'error';
      if (this.allowErrors && this.errors.length) {
        kind = 'error';
        items = this.errors.splice(0, 1);
        outcome = await this.post(this.o.target.sendUrl, JSON.stringify(items[0]!.body), false);
      } else if (this.allowUsage && this.usage.length) {
        kind = 'usage';
        items = this.usage.splice(0, this.o.batchSize ?? 20);
        outcome = await this.post(this.o.target.batchUrl, JSON.stringify(items.map((x) => x.body)), true);
      } else return;

      if (outcome === 'ok') {
        this.failures = 0;
        continue;
      }
      if (outcome === 'retry') {
        this.failures++;
        const again = items.filter((x) => ++x.attempts < (this.o.maxAttempts ?? 3));
        // Put them back in front, unless that kind was switched off meanwhile.
        if (kind === 'error' && this.allowErrors) this.errors.unshift(...(again as Array<Item<ErrorBody>>));
        if (kind === 'usage' && this.allowUsage) this.usage.unshift(...(again as Array<Item<UsageBody>>));
        this.pausedUntil = this.now + this.backoff();
        return;
      }
      if (outcome === 'throttled') return;
      if (outcome === 'stop') {
        this.stopped = true;
        this.usage = [];
        this.errors = [];
        return;
      }
      // drop: the server refused this batch (4xx); keep going with the rest.
    }
  }

  private async post(url: string, body: string, usage: boolean): Promise<SendOutcome> {
    if (!this.transport) return 'retry';
    if (!usage && new TextEncoder().encode(body).byteLength > 48_000) return 'drop';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (usage) {
      headers['x-umami-website-id'] = this.o.target.websiteId;
      headers['x-umami-hostname'] = this.o.hostname;
    }
    if (this.cache) headers['x-umami-cache'] = this.cache;
    const ac = new AbortController();
    this.abort = ac;
    const timeout = setTimeout(() => ac.abort(), this.o.requestTimeoutMs ?? 15_000);
    (timeout as { unref?: () => void }).unref?.();
    this.requests++;
    try {
      const res = await this.transport(url, { body, headers, signal: ac.signal });
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after')) || 60;
        this.pausedUntil = this.now + 1000 * Math.max(1, Math.min(retry, 300));
        this.usage = [];
        this.errors = [];
        this.o.log?.debug('[telemetry] rate limited; paused', retry, 's');
        return 'throttled';
      }
      if (res.status >= 500) return 'retry';
      if (res.status < 200 || res.status >= 300) {
        this.o.log?.debug('[telemetry] refused', res.status);
        return 'drop';
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* an empty answer is fine */
      }
      const j = (json && typeof json === 'object' ? json : {}) as {
        cache?: unknown;
        disabled?: unknown;
        beep?: unknown;
        reason?: unknown;
        errors?: unknown;
      };
      if (j.disabled === true || j.beep !== undefined || j.reason === 'bot') {
        this.o.log?.warn('[telemetry] the server declined collection; nothing more is sent this run');
        return 'stop';
      }
      if (typeof j.cache === 'string' && j.cache.length < 4096) this.cache = j.cache;
      if (typeof j.errors === 'number' && j.errors > 0)
        this.o.log?.debug('[telemetry] batch items refused', j.errors);
      return 'ok';
    } catch (err) {
      if (ac.signal.aborted && !this.allowUsage && !this.allowErrors) return 'drop';
      this.o.log?.debug('[telemetry] send failed', (err as Error)?.message);
      return 'retry';
    } finally {
      clearTimeout(timeout);
      if (this.abort === ac) this.abort = null;
    }
  }
}
