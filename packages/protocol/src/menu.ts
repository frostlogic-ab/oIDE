import { z } from 'zod';

/**
 * Built-in keyboard shortcuts: action id → combos (`Mod` = Cmd on macOS, Ctrl elsewhere). The
 * renderer keymap starts from these (users rebind them in Settings › Keys, saved as
 * `settings.keybindings`); main reads them too, so the macOS menu bar shows the same keys.
 */
export const DEFAULT_KEYBINDINGS: Readonly<Record<string, readonly string[]>> = {
  'agent.next': ['J'],
  'agent.prev': ['K'],
  'agent.nextNeedsYou': ['N'],
  'permission.allow': ['Y'],
  'permission.deny': ['D'],
  'view.back': ['Escape'],
  'commandBar.open': ['Mod+K'],
  'composer.send': ['Mod+Enter'],
  'agent.cycleMode': ['Shift+Tab'],
  'nav.back': ['Alt+ArrowLeft'],
  'nav.forward': ['Alt+ArrowRight'],
  'app.newWindow': ['Mod+Shift+N'],
  'files.search': ['Mod+Shift+F'],
  // As in VS Code: Ctrl+` on every platform (Cmd+` cycles windows on macOS).
  'files.terminal': ['Ctrl+`'],
  'files.togglePreview': ['Mod+Shift+V'],
};

/**
 * Items of the native macOS menu bar that run something in the window (docs/wiki/pages/app-menu.md).
 * Main sends `menu.run` with one of these to the window the user used last; the renderer maps it
 * to a command or a keymap action (renderer `lib/appMenu.ts`). Also the `item` of the
 * `app_menu_used` telemetry event, together with the items main handles itself.
 */
export const APP_MENU_WINDOW_ITEMS = [
  'settings',
  'checkForUpdates',
  'newAgent',
  'openProject',
  'cloneProject',
  'newRepository',
  'findInFiles',
  'commandBar',
  'goAgents',
  'goArtifacts',
  'goFiles',
  'goSourceControl',
  'goMarketplace',
  'goUsage',
  'back',
  'forward',
  'toggleTerminal',
  'jumpToSession',
  'nextAgent',
  'prevAgent',
  'nextNeedsYou',
  'showArchived',
  'keyboardShortcuts',
] as const;
export const AppMenuWindowItem = z.enum(APP_MENU_WINDOW_ITEMS);
export type AppMenuWindowItem = z.infer<typeof AppMenuWindowItem>;

/** Items main runs itself (no window involved). */
export const APP_MENU_MAIN_ITEMS = ['newWindow', 'documentation', 'reportIssue', 'logsFolder'] as const;

export const APP_MENU_ITEMS = [...APP_MENU_WINDOW_ITEMS, ...APP_MENU_MAIN_ITEMS] as const;
export const AppMenuItem = z.enum(APP_MENU_ITEMS);
export type AppMenuItem = z.infer<typeof AppMenuItem>;
