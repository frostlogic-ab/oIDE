import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CrashLoopGuard, crashLoopPage, watchRenderer, type WatchedContents } from './renderer-watchdog.js';

class FakeContents extends EventEmitter {
  destroyed = false;
  loaded: string[] = [];
  isDestroyed() {
    return this.destroyed;
  }
  reload() {}
  async loadURL(url: string) {
    this.loaded.push(url);
  }
}

const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

function setup(over: Partial<Parameters<typeof watchRenderer>[1]> = {}) {
  const wc = new FakeContents();
  const reloads: number[] = [];
  const crashes: unknown[] = [];
  let quitting = false;
  const timers: Array<() => void> = [];
  watchRenderer(wc as unknown as WatchedContents, {
    log: quietLog,
    reloadApp: () => reloads.push(Date.now()),
    onCrash: (d) => crashes.push(d),
    quitting: () => quitting,
    setTimeout: (fn) => timers.push(fn),
    ...over,
  });
  const runTimers = () => timers.splice(0).forEach((f) => f());
  return { wc, reloads, crashes, runTimers, quit: () => (quitting = true) };
}

describe('CrashLoopGuard', () => {
  it('backs off and gives up after maxCrashes within the window', () => {
    let t = 0;
    const g = new CrashLoopGuard({ maxCrashes: 3, windowMs: 1000, baseDelayMs: 100, now: () => t });
    expect([g.onCrash(), g.onCrash(), g.onCrash(), g.onCrash()]).toEqual([100, 200, 400, null]);
    t = 5000; // window passed
    expect(g.onCrash()).toBe(100);
  });
});

describe('watchRenderer', () => {
  it('reloads the page after a renderer crash and records it', () => {
    const { wc, reloads, crashes, runTimers } = setup();
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 3 });
    expect(reloads).toHaveLength(0);
    runTimers();
    expect(reloads).toHaveLength(1);
    expect(crashes).toEqual([{ reason: 'crashed', exitCode: 3 }]);
  });

  it('ignores clean exits and never reloads while quitting', () => {
    const { wc, reloads, runTimers, quit } = setup();
    wc.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    quit();
    wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
    runTimers();
    expect(reloads).toHaveLength(0);
  });

  it('shows the static error page and asks before reloading when crash-looping', async () => {
    const ask = vi.fn(async () => true);
    const guard = new CrashLoopGuard({ maxCrashes: 1 });
    const { wc, reloads, runTimers } = setup({ guard, askCrashLoop: ask });
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    runTimers();
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    runTimers();
    expect(wc.loaded).toEqual([crashLoopPage()]);
    await vi.waitFor(() => expect(reloads).toHaveLength(2));
    expect(guard.recent).toBe(0); // reset after the user chose Reload
  });

  it('asks once while unresponsive and reloads on request', async () => {
    let resolve!: (v: 'reload' | 'wait') => void;
    const ask = vi.fn(() => new Promise<'reload' | 'wait'>((r) => (resolve = r)));
    const { wc, reloads } = setup({ askUnresponsive: ask });
    wc.emit('unresponsive');
    wc.emit('unresponsive');
    expect(ask).toHaveBeenCalledTimes(1);
    resolve('reload');
    await vi.waitFor(() => expect(reloads).toHaveLength(1));
  });

  it('the crash-loop page has no scripts', () => {
    expect(decodeURIComponent(crashLoopPage())).not.toMatch(/<script/i);
  });
});
