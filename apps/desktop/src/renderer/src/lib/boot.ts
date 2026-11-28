import { connectAccounts, useAccounts } from '../stores/accounts';
import { connectAgents, useAgents } from '../stores/agents';
import { connectArchive } from '../stores/archive';
import { connectCli, useCli } from '../stores/cli';
import { connectExtensionHosts } from '../stores/extensionHosts';
import { connectProjects, useProjects } from '../stores/projects';
import { connectScope, useScope } from '../stores/scope';
import { connectSettings, useSettings } from '../stores/settings';
import { connectNotifications, promptOnScreen, retireStaleToasts } from '../stores/ui';
import { useRouter } from '../stores/router';
import { isNotImplemented, oide } from './bridge';
import { connectAppMenu } from './appMenu';
import { connectCommands, registerCoreCommands } from './coreCommands';
import { connectExtensions } from '../extensions/store';
import { connectKeybindings } from './keybindings';
import { connectTelemetry } from './telemetry';

/**
 * Dev only (Vite HMR). A hot update that re-runs a store module (an edit to it or to anything it
 * imports, such as `packages/protocol`) gives every component a new, empty store, while
 * `startStores()` ran once and keeps loading and feeding the old one. The Wall then said "No agents
 * yet" with agents still running in main (2026-11-25). This module imports every store it wires,
 * so it is the HMR boundary for all of them: reload the page, and `startStores()` rehydrates from
 * main (`agents.list`, `agents.events`), like the reload after a renderer crash.
 */
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}

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
  const offs = [oide.on('agents.summary', schedule), oide.on('agents.removed', schedule), oide.on('agents.archived', schedule), oide.on('projects.changed', schedule)];
  return () => {
    if (timer) clearTimeout(timer);
    if (midnight) clearTimeout(midnight);
    offs.forEach((off) => off());
  };
}

/**
 * Subscribes every store to main's events, then loads initial state. Called once from App, and
 * again after a reload (also the automatic one after a renderer crash): main keeps every agent
 * running, so `agents.list` and the events from the database rebuild the same picture.
 * Commands that main does not implement yet resolve to empty state (no console errors).
 */
export function startStores(): () => void {
  const quiet = (p: Promise<unknown>) =>
    p.catch((err: unknown) => {
      if (!isNotImplemented(err)) console.warn('[oide] initial load failed', err);
    });

  const offs = [
    connectAgents(),
    connectArchive(),
    connectProjects(),
    connectScope(),
    connectSettings(),
    connectCli(),
    connectAccounts(),
    connectExtensionHosts(),
    connectNotifications((agentId) =>
      promptOnScreen(agentId, {
        route: useRouter.getState().route as { screen: string; params?: { agentId?: string } },
        scope: useScope.getState().scope,
        projectId: useAgents.getState().byId[agentId]?.projectId,
      }),
    ),
    connectKeybindings(),
    connectUsage(() => Promise.all([quiet(useCli.getState().refreshUsage()), quiet(useAccounts.getState().refresh())])),
    // A needs-permission toast goes as soon as its prompt is answered (here, on the tile, or in Focus).
    useAgents.subscribe((s, prev) => {
      if (s.byId !== prev.byId || s.loaded !== prev.loaded) retireStaleToasts(s.byId, s.loaded);
    }),
    registerCoreCommands(),
    connectCommands(),
    connectAppMenu(),
    connectExtensions(),
    connectTelemetry(),
  ];

  void quiet(useSettings.getState().load());
  void quiet(useScope.getState().load());
  void quiet(useProjects.getState().load());
  // Retries with backoff by itself and keeps `loadError` for the Wall while it fails.
  void quiet(useAgents.getState().load());
  void quiet(useCli.getState().detect());
  void quiet(useCli.getState().refreshUsage());
  void quiet(useAccounts.getState().refresh());

  return () => offs.forEach((off) => off());
}
