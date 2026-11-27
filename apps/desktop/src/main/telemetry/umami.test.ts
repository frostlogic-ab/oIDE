import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { telemetryTarget, OFFICIAL_UMAMI_HOST, OFFICIAL_UMAMI_WEBSITE_ID } from '@oide/protocol';
import {
  errorBody,
  eventBody,
  identifyBody,
  pageviewBody,
  performanceBody,
  SESSION_IP,
  stableUserAgent,
  UmamiClient,
  type Transport,
  type UmamiContext,
} from './umami.js';

/**
 * The server's own request schemas, copied from Umami v3.5.0 (the version data.frostlogic.se runs):
 * src/app/api/send/request-schema.ts and src/lib/errors/schema.ts. Strict here, so a field the
 * server does not know also fails.
 */
const FORMULA = /^[=+\-@\t\r]/;
const umamiPayload = z.strictObject({
  website: z.uuid().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  hostname: z
    .string()
    .refine((v) => {
      try {
        new URL(`https://${v}`);
        return true;
      } catch {
        return false;
      }
    })
    .optional(),
  language: z.string().optional(),
  referrer: z.string().optional(),
  screen: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  name: z
    .string()
    .refine((v) => !FORMULA.test(v))
    .optional(),
  tag: z.string().optional(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  id: z.string().optional(),
  lcp: z.number().nonnegative().max(60000).optional(),
  inp: z.number().nonnegative().max(60000).optional(),
  cls: z.number().nonnegative().max(100).optional(),
  fcp: z.number().nonnegative().max(60000).optional(),
  ttfb: z.number().nonnegative().max(60000).optional(),
});
const umamiError = z.strictObject({
  version: z.literal(1),
  website: z.uuid(),
  eventId: z.uuid(),
  timestamp: z.number().int().positive(),
  name: z.string().min(1).max(200),
  message: z.string().max(2000),
  stack: z.string().max(16000),
  handled: z.boolean(),
  url: z.string().max(2000),
  release: z.string().max(100),
  environment: z.string().max(50),
  tags: z.record(z.string().max(50), z.string().max(200)).refine((v) => Object.keys(v).length <= 20),
  id: z.string().max(50).optional(),
  language: z.string().max(35).optional(),
  screen: z.string().max(11).optional(),
});
const umamiBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('error'), payload: umamiError }),
  z.object({ type: z.enum(['event', 'identify', 'performance']), payload: umamiPayload }),
]);

const target = telemetryTarget(OFFICIAL_UMAMI_HOST, OFFICIAL_UMAMI_WEBSITE_ID)!;
const ctx: UmamiContext = {
  websiteId: target.websiteId,
  hostname: 'oide-dev',
  language: 'en-US',
  screen: '1900x1000',
  release: '0.1.0',
  environment: 'development',
  userAgent: stableUserAgent('win32'),
};
const ID = '0b6f3d36-6f41-4c35-9f53-2f3b6f8f0e11';

describe('Umami payloads (shapes of the official tracker, accepted by the v3.5.0 schema)', () => {
  it('pageview: an event without a name', () => {
    const b = pageviewBody(ctx, ID, '/settings/privacy', 'Settings', '/wall');
    expect(b).toEqual({
      type: 'event',
      payload: {
        website: target.websiteId,
        hostname: 'oide-dev',
        language: 'en-US',
        screen: '1900x1000',
        id: ID,
        ip: SESSION_IP,
        userAgent: stableUserAgent('win32'),
        title: 'Settings',
        url: '/settings/privacy',
        referrer: '/wall',
      },
    });
    expect(umamiBody.safeParse(b).success).toBe(true);
  });

  it('pins the session to the install id: the same ip and a version-free user agent everywhere', () => {
    const bodies = [
      pageviewBody(ctx, ID, '/wall', 'Agents'),
      eventBody(ctx, ID, '/wall', 'Agents', 'agent_spawned', {}),
      identifyBody(ctx, ID, { app_version: '0.1.0' }),
      performanceBody(ctx, ID, '/wall', 'Agents', { fcp: 1 })!,
    ];
    for (const b of bodies)
      expect(b.payload).toMatchObject({ id: ID, ip: SESSION_IP, userAgent: ctx.userAgent });
    // Nothing in the fingerprint changes with an oIDE, Electron or OS version.
    for (const p of ['win32', 'darwin', 'linux']) {
      const ua = stableUserAgent(p);
      expect(ua).not.toMatch(/oIDE|Electron/);
      expect(ua).toMatch(/^Mozilla\/5\.0 /);
    }
    expect(stableUserAgent('win32')).toContain('Windows NT 10.0');
    expect(stableUserAgent('darwin')).toContain('Macintosh');
  });

  it('custom event: name and data', () => {
    const b = eventBody(ctx, ID, '/wall', 'Agents', 'agent_spawned', {
      model: 'opus',
      attempts: 2,
      has_attachments: false,
    });
    expect(b.payload).toMatchObject({
      name: 'agent_spawned',
      data: { model: 'opus', attempts: 2, has_attachments: false },
    });
    expect('timestamp' in b.payload).toBe(false);
    expect(umamiBody.safeParse(b).success).toBe(true);
  });

  it('identify: session data', () => {
    const b = identifyBody(ctx, ID, { app_version: '0.1.0', os: 'win32' });
    expect(b.type).toBe('identify');
    expect(umamiBody.safeParse(b).success).toBe(true);
  });

  it('performance: web vitals within the server limits, or nothing', () => {
    const b = performanceBody(ctx, ID, '/wall', 'Agents', {
      fcp: 812.3456789,
      lcp: 90_000,
      cls: 0.05,
      inp: -3,
    })!;
    expect(b.payload).toMatchObject({ fcp: 812.3457, lcp: 60_000, cls: 0.05 });
    expect('inp' in b.payload).toBe(false);
    expect(umamiBody.safeParse(b).success).toBe(true);
    expect(performanceBody(ctx, ID, '/wall', 'Agents', {})).toBeNull();
  });

  it('error: version 1 payload with eventId, ms timestamp, release, environment and tags', () => {
    const b = errorBody(ctx, ID, {
      eventId: '9c1d2b4e-2f8a-4a51-9d07-6a0f5b8c3e21',
      timestamp: 1_764_000_000_000,
      name: 'TypeError',
      message: 'x is not a function',
      stack: 'TypeError: x\n    at f (/out/main/index.js:1:2)',
      handled: false,
      url: '/wall',
      tags: { process: 'main', source: 'uncaught' },
    });
    expect(b.payload).toMatchObject({
      version: 1,
      release: '0.1.0',
      environment: 'development',
      handled: false,
      url: '/wall',
      id: ID,
    });
    expect(umamiBody.safeParse(b).success).toBe(true);
  });
});

interface Call {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakeTransport(
  answers: Array<number | { status: number; json?: unknown; retryAfter?: string } | 'throw'> = [],
) {
  const calls: Call[] = [];
  const t: Transport = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const a = answers.length ? answers.shift()! : 200;
    if (a === 'throw') throw new Error('net::ERR_INTERNET_DISCONNECTED');
    const r = typeof a === 'number' ? { status: a } : a;
    return {
      status: r.status,
      headers: { get: (n: string) => (n === 'retry-after' ? (r.retryAfter ?? null) : null) },
      json: async () => ('json' in r ? r.json : { cache: 'tok-1' }),
    };
  };
  return { t, calls };
}

describe('UmamiClient batching and resilience', () => {
  let now = 1_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
  });
  afterEach(() => vi.useRealTimers());

  const make = (t: Transport, extra: Partial<ConstructorParameters<typeof UmamiClient>[0]> = {}) => {
    const c = new UmamiClient({
      target,
      hostname: 'oide-dev',
      transport: t,
      now: () => now,
      random: () => 0.5,
      flushMs: 1000,
      errorFlushMs: 100,
      backoffMs: 1000,
      ...extra,
    });
    c.setAllowed({ usage: true, errors: true });
    return c;
  };
  const ev = (i: number) => eventBody(ctx, ID, '/wall', 'Agents', 'agent_merged', { result: 'merged', i });

  it('sends nothing until allowed, and drops what is offered while off', async () => {
    const { t, calls } = fakeTransport();
    const c = new UmamiClient({ target, hostname: 'oide-dev', transport: t, now: () => now });
    expect(c.enqueueUsage(ev(1))).toBe(false);
    await c.flush();
    expect(calls).toHaveLength(0);
  });

  it('batches usage to /api/batch in small batches with the tracker headers, then keeps the cache token', async () => {
    const { t, calls } = fakeTransport();
    const c = make(t, { batchSize: 3 });
    for (let i = 0; i < 7; i++) c.enqueueUsage(ev(i));
    await c.flush();
    expect(calls.map((x) => (x.body as unknown[]).length)).toEqual([3, 3, 1]);
    expect(calls[0]!.url).toBe('https://data.frostlogic.se/api/batch');
    expect(calls[0]!.headers).toEqual({
      'content-type': 'application/json',
      'x-umami-website-id': target.websiteId,
      'x-umami-hostname': 'oide-dev',
    });
    expect(calls[1]!.headers['x-umami-cache']).toBe('tok-1');
    for (const b of calls.flatMap((x) => x.body as unknown[]))
      expect(umamiBody.safeParse(b).success).toBe(true);
  });

  it('flushes on a timer, not per call', async () => {
    const { t, calls } = fakeTransport();
    const c = make(t, { batchSize: 20 });
    c.enqueueUsage(ev(1));
    c.enqueueUsage(ev(2));
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(c.pending()).toBe(false);
  });

  it('sends errors one by one to /api/send', async () => {
    const { t, calls } = fakeTransport();
    const c = make(t);
    const e = errorBody(ctx, ID, {
      eventId: '9c1d2b4e-2f8a-4a51-9d07-6a0f5b8c3e21',
      timestamp: now,
      name: 'Error',
      message: 'm',
      stack: '',
      handled: false,
      url: '/wall',
      tags: {},
    });
    c.enqueueError(e);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://data.frostlogic.se/api/send');
    expect(calls[0]!.body).toEqual(e);
  });

  it('backs off exponentially on network errors and 5xx, retries at most 3 times, never in a tight loop', async () => {
    const { t, calls } = fakeTransport(['throw', 503, 'throw', 'throw']);
    const c = make(t);
    c.enqueueUsage(ev(1));
    await c.flush();
    expect(calls).toHaveLength(1);
    // Paused: an immediate flush makes no request.
    await c.flush();
    expect(calls).toHaveLength(1);
    now += 1000;
    await c.flush();
    expect(calls).toHaveLength(2);
    now += 1000;
    await c.flush();
    expect(calls).toHaveLength(2); // second backoff is 2 s
    now += 1000;
    await c.flush();
    expect(calls).toHaveLength(3);
    // Third failure: the batch is dropped.
    expect(c.pending()).toBe(false);
    now += 60_000;
    await c.flush();
    expect(calls).toHaveLength(3);
  });

  it('on 429 drops the queues and waits for Retry-After', async () => {
    const { t, calls } = fakeTransport([{ status: 429, retryAfter: '120' }]);
    const c = make(t);
    for (let i = 0; i < 5; i++) c.enqueueUsage(ev(i));
    await c.flush();
    expect(calls).toHaveLength(1);
    expect(c.pending()).toBe(false);
    c.enqueueUsage(ev(9));
    now += 119_000;
    await c.flush();
    expect(calls).toHaveLength(1);
    now += 2_000;
    await c.flush();
    expect(calls).toHaveLength(2);
  });

  it('drops a refused batch (4xx) without retrying', async () => {
    const { t, calls } = fakeTransport([400]);
    const c = make(t);
    c.enqueueUsage(ev(1));
    await c.flush();
    expect(calls).toHaveLength(1);
    expect(c.pending()).toBe(false);
  });

  it('stops for the run when the server says disabled or flags a bot', async () => {
    for (const json of [{ disabled: true }, { beep: 'boop' }, { ok: false, reason: 'bot' }]) {
      const { t, calls } = fakeTransport([{ status: 200, json }]);
      const c = make(t);
      c.enqueueUsage(ev(1));
      await c.flush();
      expect(c.isStopped).toBe(true);
      expect(c.enqueueUsage(ev(2))).toBe(false);
      await c.flush();
      expect(calls).toHaveLength(1);
    }
  });

  it('makes no request while offline', async () => {
    const { t, calls } = fakeTransport();
    let online = false;
    const c = make(t, { isOnline: () => online, offlineRetryMs: 5000 });
    c.enqueueUsage(ev(1));
    await c.flush();
    expect(calls).toHaveLength(0);
    online = true;
    now += 5000;
    await c.flush();
    expect(calls).toHaveLength(1);
  });

  it('turning a switch off drops its queue at once; both off aborts the request in flight', async () => {
    let release: () => void = () => undefined;
    const calls: string[] = [];
    const t: Transport = (url, init) =>
      new Promise((resolve, reject) => {
        calls.push(url);
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        release = () => resolve({ status: 200, headers: { get: () => null }, json: async () => ({}) });
      });
    const c = make(t);
    c.enqueueUsage(ev(1));
    c.enqueueError(
      errorBody(ctx, ID, {
        eventId: '9c1d2b4e-2f8a-4a51-9d07-6a0f5b8c3e21',
        timestamp: now,
        name: 'E',
        message: '',
        stack: '',
        handled: true,
        url: '/',
        tags: {},
      }),
    );
    c.setAllowed({ usage: false, errors: true });
    expect(c.queued().usage).toHaveLength(0);
    expect(c.queued().errors).toHaveLength(1);
    const f = c.flush();
    expect(calls).toHaveLength(1);
    c.setAllowed({ usage: false, errors: false });
    await f;
    release();
    expect(c.pending()).toBe(false);
    expect(c.enqueueUsage(ev(2))).toBe(false);
    await c.flush();
    expect(calls).toHaveLength(1);
  });

  it('caps the queues and the error rate', () => {
    const { t } = fakeTransport();
    const c = make(t, { maxUsageQueue: 3, errorsPerMinute: 2 });
    for (let i = 0; i < 10; i++) c.enqueueUsage(ev(i));
    expect(c.queued().usage).toHaveLength(3);
    const e = () =>
      errorBody(ctx, ID, {
        eventId: '9c1d2b4e-2f8a-4a51-9d07-6a0f5b8c3e21',
        timestamp: now,
        name: 'E',
        message: '',
        stack: '',
        handled: true,
        url: '/',
        tags: {},
      });
    expect([c.enqueueError(e()), c.enqueueError(e()), c.enqueueError(e())]).toEqual([true, true, false]);
  });

  it('shutdown makes one bounded last flush and then nothing more', async () => {
    const { t, calls } = fakeTransport();
    const c = make(t);
    c.enqueueUsage(ev(1));
    await c.shutdown(500);
    expect(calls).toHaveLength(1);
    expect(c.enqueueUsage(ev(2))).toBe(false);
  });
});
