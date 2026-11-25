// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Settings, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../lib/bridge';
import { PANELS } from '../lib/panels';
import { useSettings } from '../stores/settings';
import { RESIZING_CLASS, ResizableAside } from './ResizableAside';

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !base || typeof base !== 'object') return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = deepMerge(out[k], v);
  }
  return out;
}

let current: Settings;
let failUpdates = false;
const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  if (command !== 'settings.update') throw new Error(`[not_implemented] ${command}`);
  if (failUpdates) throw new Error('[internal] disk full');
  current = Settings.parse(deepMerge(current, (input as { patch: unknown }).patch));
  return current;
});
const bridge: OideBridge = { invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' };
const updates = () => invoke.mock.calls.filter(([c]) => c === 'settings.update').map(([, i]) => (i as { patch: unknown }).patch);

const left = PANELS.wallProjects;
const right = PANELS.focusInspector;

function renderPanels() {
  return render(
    <div style={{ display: 'flex' }}>
      <ResizableAside panel={left} aria-label="Projects">
        projects
      </ResizableAside>
      <main>main</main>
      <ResizableAside panel={right} aria-label="Inspector">
        inspector
      </ResizableAside>
    </div>,
  );
}

const aside = (name: string) => screen.getByRole('complementary', { name });
const handle = (label: string) => screen.getByRole('separator', { name: `Resize the ${label}` });

async function drag(el: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: from });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to });
  await act(async () => {
    fireEvent.pointerUp(el, { pointerId: 1, clientX: to });
  });
}

beforeEach(() => {
  installFallbackBridge(bridge);
  invoke.mockClear();
  failUpdates = false;
  current = Settings.parse({ claude: {}, models: {}, agents: { notifications: {} }, techniques: [], permissions: {}, ui: {} });
  useSettings.setState({ settings: current });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
});

afterEach(() => cleanup());

describe('ResizableAside', () => {
  it('renders at the default width with an accessible separator on the inner edge', () => {
    renderPanels();
    expect(aside('Projects').style.width).toBe('248px');
    expect(aside('Projects').style.minWidth).toBe(`${left.min}px`);
    const h = handle('projects sidebar');
    expect(h.getAttribute('aria-orientation')).toBe('vertical');
    expect(h.getAttribute('aria-valuenow')).toBe('248');
    expect(h.getAttribute('aria-controls')).toBe(aside('Projects').id);
    // Left sidebar: handle comes after it. Right sidebar: handle comes before it.
    expect(aside('Projects').nextElementSibling).toBe(h);
    expect(aside('Inspector').previousElementSibling).toBe(handle('inspector'));
  });

  it('uses the saved width from settings', () => {
    useSettings.setState({ settings: { ...current, ui: { ...current.ui, panelWidths: { 'wall.projects': 320 } } } });
    renderPanels();
    expect(aside('Projects').style.width).toBe('320px');
  });

  it('clamps a saved width that is out of the panel range', () => {
    useSettings.setState({ settings: { ...current, ui: { ...current.ui, panelWidths: { 'wall.projects': 150, 'focus.inspector': 1500 } } } });
    renderPanels();
    expect(aside('Projects').style.width).toBe(`${left.min}px`);
    expect(aside('Inspector').style.width).toBe(`${right.max}px`);
  });

  it('drags a left sidebar wider and saves the width once, on release', async () => {
    renderPanels();
    const h = handle('projects sidebar');
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 248 });
    expect(document.documentElement.classList.contains(RESIZING_CLASS)).toBe(true);
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 348 });
    expect(aside('Projects').style.width).toBe('348px');
    expect(updates()).toEqual([]);
    await act(async () => {
      fireEvent.pointerUp(h, { pointerId: 1, clientX: 348 });
    });
    expect(document.documentElement.classList.contains(RESIZING_CLASS)).toBe(false);
    expect(updates()).toEqual([{ ui: { panelWidths: { 'wall.projects': 348 } } }]);
    expect(current.ui.panelWidths).toEqual({ 'wall.projects': 348 });
    expect(aside('Projects').style.width).toBe('348px');
  });

  it('drags a right sidebar wider by moving its edge left', async () => {
    renderPanels();
    await drag(handle('inspector'), 1000, 900);
    expect(aside('Inspector').style.width).toBe('440px');
    expect(current.ui.panelWidths).toEqual({ 'focus.inspector': 440 });
  });

  it('stops at the minimum where the content still fits, and at half the window', async () => {
    renderPanels();
    await drag(handle('projects sidebar'), 248, 0);
    expect(aside('Projects').style.width).toBe(`${left.min}px`);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    await drag(handle('projects sidebar'), 200, 2000);
    expect(aside('Projects').style.width).toBe('400px');
  });

  it('does not save a click without movement', async () => {
    renderPanels();
    await drag(handle('projects sidebar'), 248, 248);
    expect(updates()).toEqual([]);
  });

  it('Escape during a drag puts the width back and saves nothing', async () => {
    renderPanels();
    const h = handle('projects sidebar');
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 248 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 400 });
    expect(aside('Projects').style.width).toBe('400px');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(aside('Projects').style.width).toBe('248px');
    await act(async () => {
      fireEvent.pointerUp(h, { pointerId: 1, clientX: 400 });
    });
    expect(updates()).toEqual([]);
  });

  it('resizes from the keyboard and saves after the keys stop', async () => {
    vi.useFakeTimers();
    try {
      renderPanels();
      const h = handle('projects sidebar');
      fireEvent.keyDown(h, { key: 'ArrowRight' });
      fireEvent.keyDown(h, { key: 'ArrowRight', shiftKey: true });
      expect(aside('Projects').style.width).toBe(`${248 + 16 + 64}px`);
      expect(updates()).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(updates()).toEqual([{ ui: { panelWidths: { 'wall.projects': 328 } } }]);
      fireEvent.keyDown(h, { key: 'Home' });
      expect(aside('Projects').style.width).toBe(`${left.min}px`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('double-click resets the panel to its default and removes the saved width', async () => {
    current = { ...current, ui: { ...current.ui, panelWidths: { 'wall.projects': 400, 'focus.inspector': 500 } } };
    useSettings.setState({ settings: current });
    renderPanels();
    expect(aside('Projects').style.width).toBe('400px');
    await act(async () => {
      fireEvent.doubleClick(handle('projects sidebar'));
    });
    expect(aside('Projects').style.width).toBe('248px');
    expect(updates()).toEqual([{ ui: { panelWidths: { 'wall.projects': null } } }]);
    expect(current.ui.panelWidths).toEqual({ 'focus.inspector': 500 });
  });

  it('keeps the dragged width for the session when saving fails', async () => {
    failUpdates = true;
    renderPanels();
    await drag(handle('projects sidebar'), 248, 300);
    expect(aside('Projects').style.width).toBe('300px');
  });

  it('works before settings are loaded', async () => {
    useSettings.setState({ settings: null });
    renderPanels();
    expect(aside('Projects').style.width).toBe('248px');
    await drag(handle('projects sidebar'), 248, 300);
    expect(aside('Projects').style.width).toBe('300px');
  });
});
