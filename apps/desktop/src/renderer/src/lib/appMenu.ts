import type { AppMenuWindowItem } from '@oide/protocol';
import { navigate } from '../stores/router';
import { toast, useUi } from '../stores/ui';
import { ipcErrorMessage, oide } from './bridge';
import { commands } from './commands';
import { keymap, type ActionId, type Keymap } from './keymap';

/**
 * The macOS menu bar (main/app-menu.ts) sends `menu.run` with an item; this runs it in the window.
 * Items reuse the command bar's commands, or a keymap action through the active scopes, so a menu
 * item does exactly what its shortcut or command does.
 */
type Run = { command: string } | { action: ActionId; otherwise?: () => void } | { run: () => void };

export const APP_MENU_RUNS: Record<AppMenuWindowItem, Run> = {
  settings: { command: 'oide.go.settings' },
  checkForUpdates: {
    run: () => {
      navigate('settings', { section: 'updates' });
      oide.invoke('updates.check', undefined).catch((err: unknown) => toast(`Could not check for updates: ${ipcErrorMessage(err)}`, 'error'));
    },
  },
  newAgent: { command: 'oide.spawn' },
  openProject: { command: 'oide.openProject' },
  cloneProject: { command: 'oide.cloneProject' },
  newRepository: { command: 'oide.newRepository' },
  findInFiles: { command: 'oide.files.search' },
  commandBar: { run: () => useUi.getState().openCommandBar() },
  goAgents: { command: 'oide.go.wall' },
  goArtifacts: { command: 'oide.go.artifacts' },
  goFiles: { command: 'oide.go.files' },
  goSourceControl: { command: 'oide.go.sourceControl' },
  goMarketplace: { command: 'oide.go.marketplace' },
  goUsage: { command: 'oide.go.usage' },
  back: { action: 'nav.back' },
  forward: { action: 'nav.forward' },
  // The terminal panel lives in Files: elsewhere the item opens Files.
  toggleTerminal: { action: 'files.terminal', otherwise: () => navigate('files', {}) },
  jumpToSession: { command: 'oide.jumpToSession' },
  nextAgent: { action: 'agent.next' },
  prevAgent: { action: 'agent.prev' },
  nextNeedsYou: { command: 'oide.nextNeedsYou' },
  showArchived: { command: 'oide.showArchived' },
  keyboardShortcuts: { run: () => navigate('settings', { section: 'keys' }) },
};

export function runAppMenuItem(item: AppMenuWindowItem, km: Keymap = keymap): void {
  const r = APP_MENU_RUNS[item];
  // The command bar may be open over the page: a menu item replaces what it was doing.
  if (useUi.getState().commandBar.open) useUi.getState().closeCommandBar();
  if ('command' in r) {
    if (commands.get(r.command)) void Promise.resolve(commands.run(r.command)).catch((err: unknown) => toast(ipcErrorMessage(err), 'error'));
  } else if ('action' in r) {
    if (!km.trigger(r.action)) r.otherwise?.();
  } else {
    r.run();
  }
}

/** Listen for the menu bar. Called once from boot; returns the unsubscribe. */
export function connectAppMenu(): () => void {
  return oide.on('menu.run', ({ item }) => runAppMenuItem(item));
}
