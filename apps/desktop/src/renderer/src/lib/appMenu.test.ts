import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_MENU_WINDOW_ITEMS } from '@oide/protocol';

const invoke = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock('./bridge', () => ({
  oide: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} },
  invokeOr: async (_c: string, _i: unknown, fallback: unknown) => fallback,
  ipcErrorMessage: (e: unknown) => String(e),
}));

const { APP_MENU_RUNS, runAppMenuItem } = await import('./appMenu');
const { commands } = await import('./commands');
const { registerCoreCommands } = await import('./coreCommands');
const { Keymap } = await import('./keymap');
const { useRouter } = await import('../stores/router');
const { useUi } = await import('../stores/ui');

describe('macOS menu bar items in the window', () => {
  beforeEach(() => {
    invoke.mockClear();
    useRouter.getState().navigate('wall', {});
    useUi.getState().closeCommandBar();
  });

  it('maps every menu item, and every command it names is a registered core command', () => {
    const off = registerCoreCommands();
    expect(Object.keys(APP_MENU_RUNS).sort()).toEqual([...APP_MENU_WINDOW_ITEMS].sort());
    for (const r of Object.values(APP_MENU_RUNS)) if ('command' in r) expect(commands.get(r.command), r.command).toBeDefined();
    off();
  });

  it('runs a command item through the command registry', () => {
    const off = registerCoreCommands();
    runAppMenuItem('goFiles');
    expect(useRouter.getState().route.screen).toBe('files');
    off();
  });

  it('runs a key item through the keymap scopes, with a fallback when nothing handles it', () => {
    const km = new Keymap();
    const toggle = vi.fn();
    runAppMenuItem('toggleTerminal', km);
    expect(useRouter.getState().route.screen).toBe('files');
    const pop = km.pushScope('files', { 'files.terminal': toggle });
    runAppMenuItem('toggleTerminal', km);
    expect(toggle).toHaveBeenCalledOnce();
    pop();
  });

  it('Check for Updates opens Settings › Updates and asks main to check', () => {
    runAppMenuItem('checkForUpdates');
    expect(useRouter.getState().route).toMatchObject({ screen: 'settings', params: { section: 'updates' } });
    expect(invoke).toHaveBeenCalledWith('updates.check', undefined);
  });

  it('closes an open command bar first, and Command Bar opens it', () => {
    useUi.getState().openCommandBar('commands', 'x');
    runAppMenuItem('keyboardShortcuts');
    expect(useUi.getState().commandBar.open).toBe(false);
    expect(useRouter.getState().route).toMatchObject({ screen: 'settings', params: { section: 'keys' } });
    runAppMenuItem('commandBar');
    expect(useUi.getState().commandBar.open).toBe(true);
  });
});
