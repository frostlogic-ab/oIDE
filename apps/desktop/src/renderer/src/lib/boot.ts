import { connectAgents, useAgents } from '../stores/agents';
import { connectCli, useCli } from '../stores/cli';
import { connectProjects, useProjects } from '../stores/projects';
import { connectScope, useScope } from '../stores/scope';
import { connectSettings, useSettings } from '../stores/settings';
import { connectNotifications, retireStaleToasts } from '../stores/ui';
import { isNotImplemented, oide } from './bridge';
import { connectCommands, registerCoreCommands } from './coreCommands';
import { connectExtensions } from '../extensions/store';
import { connectKeybindings } from './keybindings';

/** Agent summaries stream while agents work; one `usage.summary` per this window is plenty. */
export const USAGE_REFRESH_DEBOUNCE_MS = 2_000;

/**
 * The status bar's counts (sessions, worktrees, subagents, projects) are derived live from the
 * agents and projects stores. `usage.summary` adds what the renderer cannot count (tokens today,
 * the last rate-limit reset); it is refreshed when agents or projects change (debounced), and once
 * just after local midnight, when "today" rolls over without any event. No fixed-interval polling.
 */
export function connectUsage(refresh: () => Promise<unknown>, debounceMs = USAGE_REFRESH_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
  };
  let midnight: ReturnType<typeof setTimeout> | undefined;
  const armMidnight = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    midnight = setTimeout(() => {
      void refresh();
      armMidnight();
    }, next.getTime() - now.getTime());
  };
  armMidnight();
  const offs = [oide.on('agents.summary', schedule), oide.on('agents.removed', schedule), oide.on('projects.changed', schedule)];
  return () => {
    if (timer) clearTimeout(timer);
    if (midnight) clearTimeout(midnight);
    offs.forEach((off) => off());
  };
}

/**
 * Subscribes every store to main's events, then loads initial state. Called once from App.
 * Commands that main does not implement yet resolve to empty state (no console errors).
 */
export function startStores(): () => void {
  const quiet = (p: Promise<unknown>) =>
    p.catch((err: unknown) => {
      if (!isNotImplemented(err)) console.warn('[oide] initial load failed', err);
    });

  const offs = [
    connectAgents(),
    connectProjects(),
    connectScope(),
    connectSettings(),
    connectCli(),
    connectNotifications(),
    connectKeybindings(),
    connectUsage(() => quiet(useCli.getState().refreshUsage())),
    // A needs-permission toast goes as soon as its prompt is answered (here, on the tile, or in Focus).
    useAgents.subscribe((s, prev) => {
      if (s.byId !== prev.byId || s.loaded !== prev.loaded) retireStaleToasts(s.byId, s.loaded);
    }),
    registerCoreCommands(),
    connectCommands(),
    connectExtensions(),
  ];

  void quiet(useSettings.getState().load());
  void quiet(useScope.getState().load());
  void quiet(useProjects.getState().load());
  void quiet(useAgents.getState().load());
  void quiet(useCli.getState().detect());
  void quiet(useCli.getState().refreshUsage());

  return () => offs.forEach((off) => off());
}
