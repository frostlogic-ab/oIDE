// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../lib/bridge';
import {
  deliverToPanel,
  frameLoaded,
  onWindowMessage,
  registerFrame,
  resetPanelBridge,
  type FrameEntry,
} from './panelBridge';

const invoke = vi.fn(async () => ({ ok: true }));

function fakeWindow() {
  return { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
}

function frame(win: Window, over: Partial<FrameEntry> = {}): FrameEntry {
  return {
    win: () => win,
    extension: '@oide/ext-browser-preview',
    id: 'browserPreview.panel',
    kind: 'panel',
    ...over,
  };
}

const msg = (source: unknown, data: unknown) => onWindowMessage({ source, data } as MessageEvent);

beforeEach(() => {
  installFallbackBridge({
    invoke: invoke as unknown as OideBridge['invoke'],
    on: () => () => {},
    platform: 'win32',
  });
  invoke.mockClear();
});
afterEach(() => resetPanelBridge());

describe('panel bridge', () => {
  it('forwards messages only from registered frames, as that frame’s own extension and panel', () => {
    const w = fakeWindow();
    registerFrame(frame(w));
    msg(w, { type: 'navigated', url: 'http://localhost:3000' });
    expect(invoke).toHaveBeenCalledWith('extensions.panelMessage', {
      extension: '@oide/ext-browser-preview',
      panelId: 'browserPreview.panel',
      data: { type: 'navigated', url: 'http://localhost:3000' },
    });
    invoke.mockClear();
    msg(fakeWindow(), { type: 'navigated' }); // a frame we never registered
    msg(window, { type: 'x' }); // the app itself
    msg(null, { type: 'x' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps oide:* app messages away from host code, and artifact viewers never reach it', () => {
    const w = fakeWindow();
    const onAppMessage = vi.fn();
    registerFrame(frame(w, { onAppMessage }));
    msg(w, { type: 'oide:ready' });
    expect(onAppMessage).toHaveBeenCalledWith({ type: 'oide:ready' });
    const v = fakeWindow();
    registerFrame(frame(v, { kind: 'artifactType', id: 'diagram' }));
    msg(v, { type: 'save', content: 'x' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('drops oversized messages and rate-limits a chatty frame', () => {
    const w = fakeWindow();
    registerFrame(frame(w));
    msg(w, 'x'.repeat(300 * 1024));
    expect(invoke).not.toHaveBeenCalled();
    for (let i = 0; i < 80; i++) msg(w, { i });
    expect(invoke.mock.calls.length).toBe(50);
  });

  it('queues host messages until the panel loads, then sends context first', () => {
    const w = fakeWindow();
    const f = frame(w, { context: { agentId: 'a1' } });
    registerFrame(f);
    expect(deliverToPanel(f.extension, f.id, { type: 'navigate', url: 'http://localhost:1' })).toBe(0);
    expect(w.postMessage).not.toHaveBeenCalled();
    frameLoaded(f);
    expect(w.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'oide:context', agentId: 'a1' },
      { type: 'navigate', url: 'http://localhost:1' },
    ]);
    expect(deliverToPanel(f.extension, f.id, { type: 'init' })).toBe(1);
    expect(deliverToPanel(f.extension, 'other', { type: 'init' })).toBe(0);
    expect(w.postMessage).toHaveBeenCalledTimes(3);
  });
});
