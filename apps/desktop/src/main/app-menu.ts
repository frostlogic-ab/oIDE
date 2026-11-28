import type { MenuItemConstructorOptions } from 'electron';
import { DEFAULT_KEYBINDINGS, type AppMenuItem, type AppMenuWindowItem } from '@oide/protocol';

/**
 * The native macOS menu bar (docs/wiki/pages/app-menu.md): oIDE, File, Edit, View, Agent, Window,
 * Help, in the system bar at the top of the screen. Windows and Linux get no menu bar (the command
 * bar has every item); see index.ts.
 *
 * Items that act in the window are sent as `menu.run` to the window the user used last, and the
 * renderer runs the matching command or keymap action (renderer lib/appMenu.ts). A few items run in
 * main (New Window, Help links, the logs folder).
 *
 * Shortcuts: items whose key belongs to the window keymap show the user's binding from
 * `settings.keybindings` (Settings › Keys), so a rebind shows up here. Electron registers menu
 * accelerators on macOS; Chromium gives the page the key first and only hands it to the menu when
 * the page did not handle it, so a key never runs twice. Keys without Cmd, Ctrl or Alt (`J`,
 * `Shift+Tab`) are never put on a menu item: they would fire while typing in a text field.
 */
export interface AppMenuDeps {
  appName: string;
  /** Unpackaged run: adds Reload and Developer Tools to View. */
  dev: boolean;
  /** The user's rebinds (`settings.keybindings`); actions not in here use the built-in keys. */
  keybindings: Readonly<Record<string, readonly string[]>>;
  /** Run an item in the window the user used last. */
  send(item: AppMenuWindowItem): void;
  newWindow(): void;
  openExternal(url: string): void;
  openLogsFolder(): void;
  /** Called for every item oIDE handles (not the native roles), for the `app_menu_used` event. */
  track(item: AppMenuItem): void;
}

export const DOCS_URL = 'https://getoide.com/guide/getting-started';
export const ISSUES_URL = 'https://github.com/frostlogic-ab/oIDE/issues';

const KEY_NAMES: Record<string, string> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  '+': 'Plus',
};

/**
 * A keymap combo ("Mod+Shift+N", "Ctrl+`", "Alt+ArrowLeft") as an Electron accelerator
 * ("CommandOrControl+Shift+N"). Undefined when it has no Cmd/Ctrl/Alt or a key Electron can't name.
 */
export function toAccelerator(combo: string): string | undefined {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (combo.endsWith('++')) parts.push('+');
  const mods: string[] = [];
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'mod') mods.push('CommandOrControl');
    else if (l === 'ctrl' || l === 'control') mods.push('Ctrl');
    else if (l === 'alt' || l === 'option' || l === 'opt') mods.push('Alt');
    else if (l === 'shift') mods.push('Shift');
    else if (l === 'meta' || l === 'cmd' || l === 'command' || l === 'super') mods.push('Command');
    else if (key) return undefined;
    else key = p;
  }
  if (!key || !mods.some((m) => m !== 'Shift')) return undefined;
  const named = KEY_NAMES[key.toLowerCase()];
  let name: string | undefined;
  if (named) name = named;
  else if (/^f([1-9]|1\d|2[0-4])$/i.test(key)) name = key.toUpperCase();
  else if (key.length === 1) name = key.toUpperCase();
  if (!name) return undefined;
  return [...new Set(mods), name].join('+');
}

/** The accelerator for a keymap action: the user's first binding, else the built-in one. */
export function acceleratorFor(action: string, keybindings: AppMenuDeps['keybindings']): string | undefined {
  const combos = Object.prototype.hasOwnProperty.call(keybindings, action) ? keybindings[action] : DEFAULT_KEYBINDINGS[action];
  for (const c of combos ?? []) {
    const acc = toAccelerator(c);
    if (acc) return acc;
  }
  return undefined;
}

export function buildAppMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  const run = (item: AppMenuWindowItem, label: string, accelerator?: string): MenuItemConstructorOptions => ({
    id: item,
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => {
      deps.track(item);
      deps.send(item);
    },
  });
  /** An item whose key is a window keymap action (rebindable in Settings › Keys). */
  const keyed = (item: AppMenuWindowItem, label: string, action: string) => run(item, label, acceleratorFor(action, deps.keybindings));
  const main = (item: AppMenuItem, label: string, fn: () => void, accelerator?: string): MenuItemConstructorOptions => ({
    id: item,
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => {
      deps.track(item);
      fn();
    },
  });

  return [
    {
      label: deps.appName,
      submenu: [
        { role: 'about', label: `About ${deps.appName}` },
        run('checkForUpdates', 'Check for Updates…'),
        sep,
        run('settings', 'Settings…', 'Command+,'),
        sep,
        { role: 'services' },
        sep,
        { role: 'hide', label: `Hide ${deps.appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep,
        { role: 'quit', label: `Quit ${deps.appName}` },
      ],
    },
    {
      label: 'File',
      submenu: [
        run('newAgent', 'New Agent…', 'Command+N'),
        main('newWindow', 'New Window', deps.newWindow, acceleratorFor('app.newWindow', deps.keybindings)),
        sep,
        run('openProject', 'Open Project Folder…', 'Command+O'),
        run('cloneProject', 'Clone Repository…'),
        run('newRepository', 'New Repository…'),
        sep,
        { role: 'close', label: 'Close Window' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        sep,
        keyed('findInFiles', 'Find in Files…', 'files.search'),
      ],
    },
    {
      label: 'View',
      submenu: [
        keyed('commandBar', 'Command Bar…', 'commandBar.open'),
        sep,
        // Same order as the left rail.
        run('goAgents', 'Agents', 'Command+1'),
        run('goArtifacts', 'Artifacts', 'Command+2'),
        run('goFiles', 'Files', 'Command+3'),
        run('goSourceControl', 'Source Control', 'Command+4'),
        run('goMarketplace', 'Marketplace', 'Command+5'),
        run('goUsage', 'Usage', 'Command+6'),
        sep,
        keyed('back', 'Back', 'nav.back'),
        keyed('forward', 'Forward', 'nav.forward'),
        sep,
        keyed('toggleTerminal', 'Toggle Terminal', 'files.terminal'),
        sep,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        sep,
        { role: 'togglefullscreen' },
        ...(deps.dev ? [sep, { role: 'reload' } as const, { role: 'forceReload' } as const, { role: 'toggleDevTools' } as const] : []),
      ],
    },
    {
      label: 'Agent',
      submenu: [
        run('jumpToSession', 'Jump to Session…'),
        sep,
        // J, K and N stay with the window keymap: a bare letter on a menu item would fire while typing.
        run('nextAgent', 'Next Agent'),
        run('prevAgent', 'Previous Agent'),
        run('nextNeedsYou', 'Next That Needs You'),
        sep,
        run('showArchived', 'Show Archived Agents'),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        main('documentation', `${deps.appName} Documentation`, () => deps.openExternal(DOCS_URL)),
        run('keyboardShortcuts', 'Keyboard Shortcuts'),
        sep,
        main('reportIssue', 'Report an Issue…', () => deps.openExternal(ISSUES_URL)),
        main('logsFolder', 'Show Logs Folder', deps.openLogsFolder),
      ],
    },
  ];
}
