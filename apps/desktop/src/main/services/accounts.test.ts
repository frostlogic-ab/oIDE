import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '@oide/store';
import type { AgentEvent, AccountUsage } from '@oide/protocol';
import { ACCOUNTS_DIR, AccountsService } from './accounts';

function setup(opts: { agentsOn?: (id: string) => number } = {}) {
  const store = openStore(':memory:');
  const userDataDir = mkdtempSync(join(tmpdir(), 'oide-accounts-'));
  const emitted: AccountUsage[][] = [];
  let now = new Date(2026, 10, 27, 15).getTime();
  const make = () =>
    new AccountsService({
      settings: store.settings,
      kv: store.ui.kv,
      usage: store.usage,
      emit: ((name: string, payload: AccountUsage[]) => {
        if (name === 'accounts.usage') emitted.push(payload);
        return true;
      }) as never,
      userDataDir,
      ...(opts.agentsOn ? { agentsOn: opts.agentsOn } : {}),
      now: () => now,
    });
  return { store, userDataDir, emitted, make, svc: make(), tick: (ms: number) => (now += ms), now: () => now };
}

const ev = (e: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent => ({ agentId: 'a1', seq: 0, ts: 0, ...e }) as AgentEvent;

describe('AccountsService', () => {
  it('adds an account with a generated id and its own config folder under userData', () => {
    const { svc, store, userDataDir } = setup();
    const a = svc.add('  Work  ');
    expect(a.id).toMatch(/^acc-[a-f0-9]{12}$/);
    expect(a.label).toBe('Work');
    expect(store.settings.get().accounts.list).toEqual([a]);
    const dir = svc.configDir(a.id);
    expect(dir).toBe(join(userDataDir, ACCOUNTS_DIR, a.id));
    expect(existsSync(dir!)).toBe(true);
    expect(svc.signInEnv(a.id)).toEqual({ CLAUDE_CONFIG_DIR: dir });
    expect(svc.signInEnv('default')).toEqual({});
  });

  it('gives no folder for unknown or malformed ids', () => {
    const { svc } = setup();
    expect(svc.configDir('acc-unknown1')).toBeUndefined();
    expect(svc.configDir('../../etc')).toBeUndefined();
    expect(() => svc.signInEnv('acc-unknown1')).toThrow(/not configured/);
  });

  it('renames accounts, the default one included, and keeps the folder when one is removed', () => {
    const { svc, store } = setup();
    const a = svc.add('Work');
    const dir = svc.configDir(a.id)!;
    svc.rename(a.id, 'Client');
    svc.rename('default', 'Personal');
    store.settings.update({ accounts: { spawnDefault: a.id } });
    expect(store.settings.get().accounts).toMatchObject({ defaultLabel: 'Personal', list: [{ id: a.id, label: 'Client' }] });
    svc.remove(a.id);
    expect(store.settings.get().accounts.list).toEqual([]);
    expect(store.settings.get().accounts.spawnDefault).toBeUndefined();
    // oIDE never deletes what the CLI wrote there (its sign-in).
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses to remove an account agents still use', () => {
    const { svc } = setup({ agentsOn: () => 2 });
    const a = svc.add('Work');
    expect(() => svc.remove(a.id)).toThrow(/2 agents still use/);
  });

  it('tracks plan windows, rate limits and sign-in per account, and persists them', () => {
    const { svc, make, emitted, tick, now } = setup();
    const a = svc.add('Work');
    svc.observe('default', ev({ type: 'init', sessionId: 's', model: 'opus', tools: [], cwd: '/' } as never));
    svc.observe(a.id, ev({ type: 'plan-usage', status: 'allowed', window: 'five_hour', utilization: 0.42, resetsAt: now() + 3_600_000 }));
    svc.observe(a.id, ev({ type: 'plan-usage', status: 'allowed', window: 'seven_day', utilization: 0.1, resetsAt: now() + 86_400_000 }));
    svc.observe(a.id, ev({ type: 'plan-usage', status: 'allowed_warning', window: 'five_hour', utilization: 0.81, resetsAt: now() + 3_600_000 }));
    svc.observe(a.id, ev({ type: 'error', code: 'auth', message: 'Not logged in' } as never));
    const snap = svc.snapshot();
    expect(snap.map((s) => s.accountId)).toEqual(['default', a.id]);
    expect(snap[0]).toMatchObject({ label: 'Default', signedIn: 'yes', windows: [] });
    expect(snap[1]!.signedIn).toBe('no');
    expect(snap[1]!.windows.map((w) => [w.window, w.utilization])).toEqual([
      ['seven_day', 0.1],
      ['five_hour', 0.81],
    ]);
    expect(emitted.length).toBeGreaterThan(0);

    svc.observe(a.id, ev({ type: 'rate-limit', resetAt: now() + 600_000, message: 'Plan limit reached' }));
    expect(svc.snapshot()[1]!.rateLimitedUntil).toBe(now() + 600_000);
    // A restart keeps what was seen.
    expect(make().snapshot()[1]).toMatchObject({ signedIn: 'no', rateLimitedUntil: now() + 600_000 });
    // Once the reset time passes the account is no longer shown as limited.
    tick(700_000);
    expect(svc.snapshot()[1]!.rateLimitedUntil).toBeUndefined();
  });

  it('counts tokens today per account', () => {
    const { svc, store, now } = setup();
    const a = svc.add('Work');
    const p = store.projects.open('/code/a', { name: 'alpha' });
    const spec = { projectId: p.id, title: 't', goal: 'g', strategy: { kind: 'single' as const, lead: { model: 'opus' } } };
    store.agents.insert({ id: 'a1', projectId: p.id, spec, status: 'running' });
    store.agents.insert({ id: 'a2', projectId: p.id, spec: { ...spec, accountId: a.id }, status: 'running' });
    store.usage.add({ agentId: 'a1', ts: now() - 1000, usage: { input: 10 } });
    store.usage.add({ agentId: 'a2', ts: now() - 1000, usage: { input: 5, output: 2 } });
    expect(svc.snapshot().map((s) => s.tokensToday)).toEqual([10, 7]);
  });
});
