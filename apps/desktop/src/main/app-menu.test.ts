import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { APP_MENU_ITEMS, AppMenuItem, AppMenuWindowItem } from '@oide/protocol';
import { acceleratorFor, buildAppMenuTemplate, DOCS_URL, ISSUES_URL, toAccelerator, type AppMenuDeps } from './app-menu.js';
import { isAllowedExternalUrl } from './security/external.js';

type Deps = AppMenuDeps & { [K in 'send' | 'newWindow' | 'openExternal' | 'openLogsFolder' | 'track']: ReturnType<typeof vi.fn> };

function deps(over: Partial<AppMenuDeps> = {}): Deps {
  return { appName: 'oIDE', dev: false, keybindings: {}, send: vi.fn(), newWindow: vi.fn(), openExternal: vi.fn(), openLogsFolder: vi.fn(), track: vi.fn(), ...over } as Deps;
}

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((m) => [m, ...(Array.isArray(m.submenu) ? items(m.submenu) : [])]);
}
const byId = (t: MenuItemConstructorOptions[], id: string) => items(t).find((i) => i.id === id);
const click = (i: MenuItemConstructorOptions | undefined) => (i?.click as unknown as () => void)();

describe('toAccelerator', () => {
  it('turns keymap combos into Electron accelerators', () => {
    expect(toAccelerator('Mod+Shift+N')).toBe('CommandOrControl+Shift+N');
    expect(toAccelerator('Ctrl+`')).toBe('Ctrl+`');
    expect(toAccelerator('Alt+ArrowLeft')).toBe('Alt+Left');
    expect(toAccelerator('Meta+k')).toBe('Command+K');
    expect(toAccelerator('Mod+Enter')).toBe('CommandOrControl+Enter');
    expect(toAccelerator('Ctrl++')).toBe('Ctrl+Plus');
    expect(toAccelerator('Alt+F5')).toBe('Alt+F5');
  });

  it('refuses keys that would fire while typing, and keys it cannot name', () => {
    expect(toAccelerator('J')).toBeUndefined();
    expect(toAccelerator('Shift+Tab')).toBeUndefined();
    expect(toAccelerator('Escape')).toBeUndefined();
    expect(toAccelerator('Mod+Unidentified')).toBeUndefined();
    expect(toAccelerator('Mod')).toBeUndefined();
  });
});

describe('acceleratorFor', () => {
  it('uses the built-in key, the user rebind, or nothing when unbound', () => {
    expect(acceleratorFor('files.search', {})).toBe('CommandOrControl+Shift+F');
    expect(acceleratorFor('files.search', { 'files.search': ['Mod+Alt+F'] })).toBe('CommandOrControl+Alt+F');
    expect(acceleratorFor('files.search', { 'files.search': [] })).toBeUndefined();
    expect(acceleratorFor('files.search', { 'files.search': ['F', 'Mod+P'] })).toBe('CommandOrControl+P');
    expect(acceleratorFor('agent.next', {})).toBeUndefined();
  });
});

describe('buildAppMenuTemplate', () => {
  it('has the macOS menus in order', () => {
    const t = buildAppMenuTemplate(deps());
    expect(t.map((m) => m.label ?? m.role)).toEqual(['oIDE', 'File', 'Edit', 'View', 'Agent', 'windowMenu', 'help']);
  });

  it('uses only known item ids, each once, and offers every item', () => {
    const ids = items(buildAppMenuTemplate(deps())).flatMap((i) => (i.id ? [i.id] : []));
    for (const id of ids) expect(AppMenuItem.safeParse(id).success, id).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...APP_MENU_ITEMS].sort());
  });

  it('sends window items to the window and tracks them', () => {
    const d = deps();
    click(byId(buildAppMenuTemplate(d), 'goFiles'));
    expect(d.send).toHaveBeenCalledWith('goFiles');
    expect(d.track).toHaveBeenCalledWith('goFiles');
  });

  it('runs main items in main, never through the window', () => {
    const d = deps();
    const t = buildAppMenuTemplate(d);
    for (const id of ['newWindow', 'documentation', 'reportIssue', 'logsFolder']) {
      click(byId(t, id));
      expect(AppMenuWindowItem.safeParse(id).success).toBe(false);
    }
    expect(d.newWindow).toHaveBeenCalledOnce();
    expect(d.openExternal).toHaveBeenCalledWith(DOCS_URL);
    expect(d.openExternal).toHaveBeenCalledWith(ISSUES_URL);
    expect(d.openLogsFolder).toHaveBeenCalledOnce();
    expect(d.send).not.toHaveBeenCalled();
    expect(d.track.mock.calls.map((c) => c[0])).toEqual(['newWindow', 'documentation', 'reportIssue', 'logsFolder']);
  });

  it('opens only allow-listed help links', () => {
    expect(isAllowedExternalUrl(DOCS_URL)).toBe(true);
    expect(isAllowedExternalUrl(ISSUES_URL)).toBe(true);
  });

  it('shows the user rebinds and never a bare-letter shortcut', () => {
    const t = buildAppMenuTemplate(deps({ keybindings: { 'commandBar.open': ['Mod+P'], 'app.newWindow': [] } }));
    expect(byId(t, 'commandBar')?.accelerator).toBe('CommandOrControl+P');
    expect(byId(t, 'newWindow')?.accelerator).toBeUndefined();
    expect(byId(t, 'findInFiles')?.accelerator).toBe('CommandOrControl+Shift+F');
    expect(byId(t, 'settings')?.accelerator).toBe('Command+,');
    expect(byId(t, 'nextAgent')?.accelerator).toBeUndefined();
    for (const i of items(t)) if (typeof i.accelerator === 'string') expect(i.accelerator, String(i.id)).toMatch(/^(Command|Ctrl|Alt|CommandOrControl)\+/);
  });

  it('adds Reload and Developer Tools only in dev', () => {
    const roles = (dev: boolean) => items(buildAppMenuTemplate(deps({ dev }))).map((i) => i.role);
    expect(roles(false)).not.toContain('toggleDevTools');
    expect(roles(true)).toContain('toggleDevTools');
  });
});
