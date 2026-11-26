// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Settings, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { connectKeybindings, LEGACY_STORAGE_KEY } from '../../lib/keybindings';
import { Keymap } from '../../lib/keymap';
import { useSettings } from '../../stores/settings';
import { KeysSection } from './KeysSection';

const base = () => Settings.parse({ claude: {}, models: {}, agents: { notifications: {} }, techniques: [], permissions: {}, ui: {} });

let current: Settings;
const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  if (command !== 'settings.update') throw new Error(`[not_implemented] ${command}`);
  const patch = (input as { patch: { keybindings?: Record<string, string[] | null> | null } }).patch;
  const next = { ...current.keybindings };
  if (patch.keybindings === null) for (const k of Object.keys(next)) delete next[k];
  else
    for (const [k, v] of Object.entries(patch.keybindings ?? {})) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
  current = { ...current, keybindings: next };
  return current;
});
const bridge: OideBridge = { invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' };

const patches = () => invoke.mock.calls.map(([, i]) => (i as { patch: unknown }).patch);

let km: Keymap;
let off: () => void;
beforeEach(() => {
  installFallbackBridge(bridge);
  invoke.mockClear();
  localStorage.clear();
  current = base();
  useSettings.setState({ settings: current });
  km = new Keymap();
  off = connectKeybindings(km);
});
afterEach(() => {
  off();
  cleanup();
});

describe('Settings › Keyboard shortcuts', () => {
  it('records a new key, saves it to Settings and resets it', async () => {
    render(<KeysSection km={km} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change shortcut for Next agent' }));
    const rec = screen.getByRole('button', { name: 'New shortcut for Next agent' });
    fireEvent.keyDown(rec, { key: 'Shift' });
    expect(rec.textContent).toBe('Press keys…');
    fireEvent.keyDown(rec, { key: 'l' });
    expect(rec.textContent).toBe('L');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(patches()).toEqual([{ keybindings: { 'agent.next': ['L'] } }]);
    expect(km.getBindings()['agent.next']).toEqual(['L']);
    expect(screen.getByText(/Changed · default J/)).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reset shortcut for Next agent' })));
    expect(patches().at(-1)).toEqual({ keybindings: { 'agent.next': null } });
    expect(km.getBindings()['agent.next']).toEqual(['J']);
  });

  it('warns about a combo another action uses, and saving takes it from there', async () => {
    render(<KeysSection km={km} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change shortcut for Next agent' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'New shortcut for Next agent' }), { key: 'k', ctrlKey: true });
    expect(screen.getByRole('alert').textContent).toMatch(/Ctrl K is already used for Open the command bar\. Saving takes it from there\./);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(patches()).toEqual([{ keybindings: { 'commandBar.open': [], 'agent.next': ['Mod+K'] } }]);
    expect(km.getBindings()['commandBar.open']).toEqual([]);
  });

  it('Escape cancels recording without saving', () => {
    render(<KeysSection km={km} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change shortcut for Deny' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'New shortcut for Deny' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'New shortcut for Deny' })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('lets Tab through to Save instead of recording it, and shows the hint', async () => {
    render(<KeysSection km={km} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change shortcut for Next agent' }));
    const rec = screen.getByRole('button', { name: 'New shortcut for Next agent' });
    expect(screen.getByText('Press the new keys · Tab to move on · Esc to cancel')).toBeTruthy();
    fireEvent.keyDown(rec, { key: 'l' });
    // Not default-prevented, so the browser moves focus; the combo stays as it was.
    expect(fireEvent.keyDown(rec, { key: 'Tab' })).toBe(true);
    expect(rec.textContent).toBe('L');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.focus();
    expect(document.activeElement).toBe(save);
    await act(async () => fireEvent.click(save));
    expect(patches()).toEqual([{ keybindings: { 'agent.next': ['L'] } }]);
  });

  it('still cancels on Escape after Tab moved focus on to Save or Cancel', () => {
    render(<KeysSection km={km} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change shortcut for Next agent' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'New shortcut for Next agent' }), { key: 'l' });
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    expect(fireEvent.keyDown(save, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('button', { name: 'New shortcut for Next agent' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change shortcut for Next agent' }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps Shift+Tab recordable because it is the Switch permission mode shortcut', () => {
    render(<KeysSection km={km} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change shortcut for Next agent' }));
    const rec = screen.getByRole('button', { name: 'New shortcut for Next agent' });
    expect(fireEvent.keyDown(rec, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(rec.textContent).toBe('Shift Tab');
  });

  it('puts focus back on the Change button after Save, Cancel and Escape', async () => {
    render(<KeysSection km={km} />);
    const change = () => screen.getByRole('button', { name: 'Change shortcut for Next agent' });

    fireEvent.click(change());
    fireEvent.keyDown(screen.getByRole('button', { name: 'New shortcut for Next agent' }), { key: 'l' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(document.activeElement).toBe(change());

    fireEvent.click(change());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect(document.activeElement).toBe(change());

    fireEvent.click(change());
    fireEvent.keyDown(screen.getByRole('button', { name: 'New shortcut for Next agent' }), { key: 'Escape' });
    expect(document.activeElement).toBe(change());
  });

  it('follows settings.changed and moves old browser-storage rebinds into Settings once', () => {
    act(() => useSettings.getState().apply({ ...current, keybindings: { 'agent.prev': ['I'] } }));
    expect(km.getBindings()['agent.prev']).toEqual(['I']);
    expect(invoke).not.toHaveBeenCalled();

    off();
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ 'agent.next': ['ArrowDown'] }));
    useSettings.setState({ settings: base() });
    const fresh = new Keymap();
    off = connectKeybindings(fresh);
    expect(fresh.getBindings()['agent.next']).toEqual(['ArrowDown']);
    expect(patches()).toEqual([{ keybindings: { 'agent.next': ['ArrowDown'] } }]);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});
