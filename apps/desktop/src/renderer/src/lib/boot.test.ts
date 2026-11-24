import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OideBridge } from '@oide/protocol';
import { installFallbackBridge } from './bridge';
import { connectUsage, USAGE_REFRESH_DEBOUNCE_MS } from './boot';

const handlers = new Map<string, Set<(p: unknown) => void>>();
const bridge: OideBridge = {
  invoke: (() => Promise.reject(new Error('[not_implemented]'))) as unknown as OideBridge['invoke'],
  on: ((event: string, fn: (p: unknown) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(fn);
    handlers.set(event, set);
    return () => set.delete(fn);
  }) as OideBridge['on'],
  platform: 'win32',
};
const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.forEach((fn) => fn(payload));

beforeEach(() => {
  handlers.clear();
  installFallbackBridge(bridge);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 24, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

describe('connectUsage (status bar usage, M3)', () => {
  it('refreshes once per burst of agent and project events, never on a fixed 15 s poll', () => {
    const refresh = vi.fn(async () => undefined);
    const off = connectUsage(refresh);
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();

    emit('agents.summary');
    emit('agents.summary');
    emit('projects.changed', []);
    vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    emit('agents.removed', { agentId: 'a1' });
    vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    off();
    emit('agents.summary');
    vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes just after local midnight, when "tokens today" rolls over without an event', () => {
    const refresh = vi.fn(async () => undefined);
    const off = connectUsage(refresh);
    vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 4_000);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    off();
  });
});
