import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFICIAL_UMAMI_HOST,
  OFFICIAL_UMAMI_WEBSITE_ID,
  Settings,
  telemetryTarget,
  type TelemetryUnavailableReason,
} from '@oide/protocol';
import { createScrubber } from './scrub.js';
import { TelemetryService, unavailableReason, type SettingsSource } from './service.js';
import type { Transport } from './umami.js';

const target = telemetryTarget(OFFICIAL_UMAMI_HOST, OFFICIAL_UMAMI_WEBSITE_ID)!;

/** An in-memory settings store with the same deep-merge-and-notify behaviour as SettingsService. */
function fakeSettings(initial: Partial<Settings['privacy']> = {}): SettingsSource & { current: Settings } {
  const listeners = new Set<(s: Settings) => void>();
  const src = {
    current: Settings.parse({
      claude: {},
      models: {},
      agents: { notifications: {} },
      techniques: [],
      permissions: {},
      ui: {},
      privacy: initial,
    }),
    get: () => structuredClone(src.current),
    update: (patch: Record<string, unknown>) => {
      const p = (patch.privacy ?? {}) as Partial<Settings['privacy']>;
      src.current = Settings.parse({ ...src.current, privacy: { ...src.current.privacy, ...p } });
      for (const l of listeners) l(structuredClone(src.current));
      return structuredClone(src.current);
    },
    onChange: (fn: (s: Settings) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return src;
}

function recorder() {
  const bodies: Array<{ url: string; body: unknown }> = [];
  const t: Transport = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    return { status: 200, headers: { get: () => null }, json: async () => ({ cache: 'c' }) };
  };
  return { t, bodies };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oide-telemetry-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let uuidN = 0;
function service(unavailable: TelemetryUnavailableReason | null = null, tgt = target) {
  const s = new TelemetryService({
    target: tgt,
    unavailable,
    dev: true,
    appVersion: '0.1.0',
    session: { os: 'win32', osVersion: '10.0.26300', arch: 'x64', electron: '45.0.0', country: 'se' },
    stateFile: join(dir, 'telemetry.json'),
    scrubber: createScrubber({ username: 'jdoe' }),
    uuid: () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`,
    client: { flushMs: 10, errorFlushMs: 10 },
  });
  const rec = recorder();
  s.setTransport(rec.t, () => true);
  return { s, ...rec };
}

const sentNames = (bodies: Array<{ body: unknown }>) =>
  bodies
    .flatMap((b) => (Array.isArray(b.body) ? b.body : [b.body]))
    .map((x) => {
      const o = x as { type: string; payload: { name?: string; url?: string } };
      return o.type === 'event' ? (o.payload.name ?? `pageview ${o.payload.url}`) : o.type;
    });

describe('consent gating', () => {
  it('sends nothing before opt-in: no queue, no request, no install id', async () => {
    const { s, bodies } = service();
    s.bindSettings(fakeSettings());
    expect(s.track('agent_merged', { result: 'merged' })).toBe(false);
    expect(s.pageview('wall')).toBe(false);
    expect(s.error(new Error('boom'), { source: 'uncaught', process: 'main' })).toBe(false);
    expect(s.identify()).toBe(false);
    await s.flush();
    expect(bodies).toEqual([]);
    expect(s.installId).toBeUndefined();
    expect(s.client!.requests).toBe(0);
  });

  it('opt-in through the prompt creates an install id, sends telemetry_opt_in and then events', async () => {
    const { s, bodies } = service();
    const st = fakeSettings();
    s.bindSettings(st);
    expect(s.status().showPrompt).toBe(true);
    s.consent('shown');
    s.consent('accept');
    expect(st.current.privacy).toMatchObject({
      usageAnalytics: true,
      errorReports: true,
      consentAnswered: true,
      consentPromptsShown: 1,
    });
    expect(s.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(join(dir, 'telemetry.json'), 'utf8')).installId).toBe(s.installId);
    s.track('agent_merged', { result: 'conflicts' });
    await s.flush();
    expect(sentNames(bodies)).toEqual(['telemetry_opt_in', 'identify', 'agent_merged']);
    const optIn = (bodies[0]!.body as Array<{ payload: { data: unknown; hostname: string; id: string } }>)[0]!
      .payload;
    expect(optIn.data).toEqual({ source: 'prompt', errors: true });
    expect(optIn.hostname).toBe('oide-dev');
    expect(optIn.id).toBe(s.installId);
    expect(s.status().showPrompt).toBe(false);
  });

  it('"No thanks" sends nothing and is never asked again', async () => {
    const { s, bodies } = service();
    const st = fakeSettings();
    s.bindSettings(st);
    s.consent('shown');
    s.consent('decline');
    s.track('agent_merged', { result: 'merged' });
    s.error(new Error('x'), { source: 'uncaught', process: 'main' });
    await s.flush();
    expect(bodies).toEqual([]);
    expect(st.current.privacy).toMatchObject({
      usageAnalytics: false,
      errorReports: false,
      consentAnswered: true,
    });
    expect(s.status().showPrompt).toBe(false);
  });

  it('closing without a choice asks again on a later launch, at most twice in all', () => {
    const st = fakeSettings();
    const a = service().s;
    a.bindSettings(st);
    expect(a.status().showPrompt).toBe(true);
    a.consent('shown');
    a.consent('later');
    expect(a.status().showPrompt).toBe(false);
    const b = service().s; // next launch
    b.bindSettings(st);
    expect(b.status().showPrompt).toBe(true);
    b.consent('shown');
    b.consent('shown'); // a renderer reload in the same launch does not count again
    expect(st.current.privacy.consentPromptsShown).toBe(2);
    b.consent('later');
    const c = service().s;
    c.bindSettings(st);
    expect(c.status().showPrompt).toBe(false);
  });

  it('opt-out drops the queue at once, deletes the install id, and nothing is sent; opt-in again gives a new id', async () => {
    const { s, bodies } = service();
    const st = fakeSettings({ usageAnalytics: true, errorReports: true, consentAnswered: true });
    s.bindSettings(st);
    const first = s.installId;
    expect(first).toBeDefined();
    s.track('agent_merged', { result: 'merged' });
    s.error(new Error('x'), { source: 'uncaught', process: 'main' });
    expect(s.client!.pending()).toBe(true);
    st.update({ privacy: { usageAnalytics: false, errorReports: false } });
    expect(s.client!.pending()).toBe(false);
    expect(s.installId).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'telemetry.json'), 'utf8')).installId).toBeUndefined();
    s.track('agent_merged', { result: 'merged' });
    await s.flush();
    expect(bodies).toEqual([]);
    st.update({ privacy: { usageAnalytics: true } });
    expect(s.installId).toBeDefined();
    expect(s.installId).not.toBe(first);
    await s.flush();
    // Sent only on opt-in, never on opt-out.
    expect(sentNames(bodies)).toEqual(['telemetry_opt_in', 'identify']);
  });

  it('each switch gates its own kind', async () => {
    const { s, bodies } = service();
    s.bindSettings(fakeSettings({ usageAnalytics: false, errorReports: true, consentAnswered: true }));
    expect(s.track('agent_merged', { result: 'merged' })).toBe(false);
    expect(s.error(new Error('kaput'), { source: 'uncaught', process: 'main' })).toBe(true);
    await s.flush();
    expect(sentNames(bodies)).toEqual(['error']);
  });

  it('errors raised before settings are known wait in memory and follow the stored choice', async () => {
    const on = service();
    expect(on.s.error(new Error('early'), { source: 'uncaught', process: 'main' })).toBe(false);
    on.s.bindSettings(fakeSettings({ errorReports: true, consentAnswered: true }));
    await on.s.flush();
    expect(sentNames(on.bodies)).toEqual(['error']);

    const off = service();
    off.s.error(new Error('early'), { source: 'uncaught', process: 'main' });
    off.s.bindSettings(fakeSettings());
    await off.s.flush();
    expect(off.bodies).toEqual([]);
  });

  it.each([['do-not-track'], ['env'], ['test'], ['compiled-out']] as const)(
    'unavailable (%s): switches count as off, no prompt, no client',
    async (reason) => {
      const { s, bodies } = reason === 'compiled-out' ? service(null, null as never) : service(reason);
      s.bindSettings(fakeSettings({ usageAnalytics: true, errorReports: true, consentAnswered: true }));
      expect(s.available).toBe(false);
      expect(s.status()).toMatchObject({
        available: false,
        reason,
        usageAnalytics: false,
        errorReports: false,
        showPrompt: false,
      });
      expect(s.client).toBeNull();
      expect(s.track('agent_merged', { result: 'merged' })).toBe(false);
      expect(s.error(new Error('x'), { source: 'uncaught', process: 'main' })).toBe(false);
      await s.flush();
      expect(bodies).toEqual([]);
    },
  );
});

describe('environment', () => {
  it('DO_NOT_TRACK, OIDE_TELEMETRY=0 and test runners turn telemetry off', () => {
    expect(unavailableReason({ DO_NOT_TRACK: '1' })).toBe('do-not-track');
    expect(unavailableReason({ OIDE_TELEMETRY: '0' })).toBe('env');
    expect(unavailableReason({ OIDE_TELEMETRY: 'off' })).toBe('env');
    expect(unavailableReason({ VITEST: 'true' })).toBe('test');
    expect(unavailableReason({ NODE_ENV: 'test' })).toBe('test');
    expect(unavailableReason({})).toBeNull();
    // This very test run.
    expect(unavailableReason(process.env)).not.toBeNull();
  });
});

describe('what is sent', () => {
  const on = () => {
    const x = service();
    x.s.bindSettings(fakeSettings({ usageAnalytics: true, errorReports: true, consentAnswered: true }));
    return x;
  };

  it('drops events outside the catalogue and strips unknown properties', async () => {
    const { s, bodies } = on();
    expect(s.track('made_up' as never, {} as never)).toBe(false);
    s.track('agent_merged', { result: 'merged', title: 'Fix login for ACME' } as never);
    expect(s.trackFromRenderer('agent_merged', { result: 'merged' })).toBe(false);
    expect(s.trackFromRenderer('command_palette_used', { command: 'my-ext.do' })).toBe(false);
    s.trackFromRenderer('command_palette_used', { command: 'oide.spawn' });
    await s.flush();
    const events = (bodies[0]!.body as Array<{ payload: { name: string; data: unknown } }>).map(
      (b) => b.payload,
    );
    expect(events.map((e) => [e.name, e.data])).toEqual([
      ['agent_merged', { result: 'merged' }],
      ['command_palette_used', { command: 'oide.spawn' }],
    ]);
  });

  it('pageviews are synthetic paths with the previous screen as referrer; events carry the current screen', async () => {
    const { s, bodies } = on();
    s.pageview('wall');
    s.pageview('wall');
    s.pageview('settings', 'privacy');
    s.track('setting_changed', { key: 'ui.accent' });
    await s.flush();
    const p = (bodies[0]!.body as Array<{ payload: Record<string, unknown> }>).map((b) => b.payload);
    expect(p.map((x) => [x.url, x.referrer, x.name])).toEqual([
      ['/wall', undefined, undefined],
      ['/settings/privacy', '/wall', undefined],
      ['/settings/privacy', undefined, 'setting_changed'],
    ]);
  });

  it('error reports are scrubbed, deduplicated and carry release, environment and tags', async () => {
    const { s, bodies } = on();
    const err = new Error('cannot open C:\\Users\\jdoe\\acme\\plan.md for jdoe@acme.com');
    s.error(err, { source: 'uncaught', process: 'main' });
    s.error(err, { source: 'uncaught', process: 'main' });
    await s.flush();
    expect(bodies).toHaveLength(1);
    const p = (bodies[0]!.body as { type: string; payload: Record<string, unknown> }).payload;
    expect(p.message).toBe('cannot open <path> for <email>');
    expect(String(p.stack)).not.toMatch(/acme|jdoe|Users/);
    expect(p).toMatchObject({
      version: 1,
      name: 'Error',
      release: '0.1.0',
      environment: 'development',
      url: '/wall',
      tags: { process: 'main', source: 'uncaught' },
    });
  });

  it('web vitals are sent at most once per screen per 30 minutes', async () => {
    const { s, bodies } = on();
    expect(s.vitals('wall', undefined, { fcp: 300, lcp: 450 })).toBe(true);
    expect(s.vitals('wall', undefined, { inp: 40 })).toBe(false);
    expect(s.vitals('focus', undefined, {})).toBe(false);
    await s.flush();
    expect(sentNames(bodies)).toEqual(['performance']);
  });

  it('identify carries only versions, channel, OS family and arch, once per run', async () => {
    const { s, bodies } = on();
    s.setCliVersion('2.1.325 (Claude Code)');
    expect(s.identify()).toBe(true);
    expect(s.identify()).toBe(false);
    await s.flush();
    const p = (bodies[0]!.body as Array<{ payload: { data: unknown } }>)[0]!.payload;
    expect(p.data).toEqual({
      app_version: '0.1.0',
      channel: 'stable',
      os: 'win32',
      os_version: '10.0.26300',
      arch: 'x64',
      electron: '45.0.0',
      dev: true,
      country: 'SE',
      cli_version: '2.1.325',
    });
  });

  it('notes version changes locally (update_installed)', () => {
    const a = service().s;
    expect(a.noteVersion()).toEqual({ previous: undefined, changed: false });
    expect(a.noteVersion()).toEqual({ previous: '0.1.0', changed: false });
  });
});
