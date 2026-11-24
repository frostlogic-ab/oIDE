import { connectAgents, useAgents } from '../stores/agents';
import { connectCli, useCli } from '../stores/cli';
import { connectProjects, useProjects } from '../stores/projects';
import { connectScope, useScope } from '../stores/scope';
import { connectSettings, useSettings } from '../stores/settings';
import { connectNotifications } from '../stores/ui';
import { isNotImplemented } from './bridge';
import { connectCommands, registerCoreCommands } from './coreCommands';
import { connectExtensions } from '../extensions/store';

/**
 * Subscribes every store to main's events, then loads initial state. Called once from App.
 * Commands that main does not implement yet resolve to empty state (no console errors).
 */
export function startStores(): () => void {
  const offs = [
    connectAgents(),
    connectProjects(),
    connectScope(),
    connectSettings(),
    connectCli(),
    connectNotifications(),
    registerCoreCommands(),
    connectCommands(),
    connectExtensions(),
  ];

  const quiet = (p: Promise<unknown>) =>
    p.catch((err: unknown) => {
      if (!isNotImplemented(err)) console.warn('[oide] initial load failed', err);
    });
  void quiet(useSettings.getState().load());
  void quiet(useScope.getState().load());
  void quiet(useProjects.getState().load());
  void quiet(useAgents.getState().load());
  void quiet(useCli.getState().detect());
  void quiet(useCli.getState().refreshUsage());

  const usageTimer = setInterval(() => void quiet(useCli.getState().refreshUsage()), 15_000);

  return () => {
    clearInterval(usageTimer);
    offs.forEach((off) => off());
  };
}
