import type { InstalledExtension } from '@oide/protocol';
import { navigate, useRouter } from '../stores/router';
import { useAgents, agentsInScope, nextNeedsYou } from '../stores/agents';
import { useScope } from '../stores/scope';
import { useUi, toast } from '../stores/ui';
import { invokeOr, ipcErrorMessage, oide } from './bridge';
import { commands, type Command } from './commands';
import { keymap } from './keymap';
import { extensionUiCommands } from '../extensions/commands';
import { isOnSomewhere } from '../extensions/model';

/** Core commands. Registered once at boot; returns an unregister. */
export function registerCoreCommands(): () => void {
  const core: Command[] = [
    {
      id: 'oide.spawn',
      title: 'Spawn an agent',
      group: 'Agents',
      keywords: ['new', 'start', 'create', 'agent'],
      run: () => navigate('spawn', {}),
    },
    {
      id: 'oide.jumpToSession',
      title: 'Jump to session…',
      group: 'Agents',
      keywords: ['agent', 'focus', 'open', 'switch'],
      run: () => {
        useUi.getState().openCommandBar('sessions');
        return { keepOpen: true };
      },
    },
    {
      id: 'oide.nextNeedsYou',
      title: 'Next agent that needs you',
      group: 'Agents',
      hint: 'N',
      run: () => {
        const { byId, order } = useAgents.getState();
        const list = agentsInScope(byId, order, useScope.getState().scope);
        const route = useRouter.getState().route;
        const current = route.screen === 'focus' ? route.params.agentId : undefined;
        const next = nextNeedsYou(list, current);
        if (next) navigate('focus', { agentId: next.id });
        else toast('No agent needs you right now');
      },
    },
    { id: 'oide.go.wall', title: 'Go to Agents', group: 'Go to', keywords: ['wall', 'mission control', 'home'], run: () => navigate('wall') },
    { id: 'oide.go.artifacts', title: 'Go to Artifacts', group: 'Go to', keywords: ['designs', 'docs', 'whiteboards'], run: () => navigate('artifacts', {}) },
    { id: 'oide.go.files', title: 'Go to Files', group: 'Go to', keywords: ['editor', 'tree'], run: () => navigate('files', {}) },
    { id: 'oide.go.sourceControl', title: 'Go to Source control', group: 'Go to', keywords: ['git', 'worktrees', 'commit'], run: () => navigate('source-control') },
    { id: 'oide.go.marketplace', title: 'Go to Marketplace', group: 'Go to', keywords: ['extensions', 'tools', 'mcp'], run: () => navigate('marketplace', {}) },
    { id: 'oide.go.settings', title: 'Go to Settings', group: 'Go to', keywords: ['preferences', 'options', 'models'], run: () => navigate('settings', {}) },
    {
      id: 'oide.scope.all',
      title: 'Show all projects',
      group: 'Project scope',
      keywords: ['scope', 'filter'],
      run: () => void useScope.getState().setScope('all'),
    },
    {
      id: 'oide.openProject',
      title: 'Open project…',
      group: 'Projects',
      keywords: ['folder', 'repo', 'add'],
      run: async () => {
        try {
          await oide.invoke('projects.open', {});
        } catch (err) {
          toast(ipcErrorMessage(err), 'error');
        }
      },
    },
  ];
  for (const c of core) c.source = 'core';
  return commands.register(core);
}

/**
 * Commands contributed by installed extensions run in the extension host. In Focus they get the
 * agent as their argument (`{ agentId }`), so "Open browser preview" opens in that agent's inspector.
 * Panels and themes add their own entries (extensions/commands.ts).
 */
export function registerExtensionCommands(installed: InstalledExtension[]): void {
  commands.clearSource('extension');
  const list: Command[] = [];
  for (const ext of installed) {
    if (!isOnSomewhere(ext)) continue;
    for (const c of ext.manifest.oide.contributes.commands) {
      if (c.keybinding) keymap.define(`ext:${c.id}`, [c.keybinding]);
      list.push({
        id: c.id,
        title: c.title,
        group: ext.displayName,
        source: 'extension',
        run: async () => {
          const route = useRouter.getState().route;
          const args = route.screen === 'focus' ? [{ agentId: route.params.agentId }] : [];
          try {
            await oide.invoke('extensions.runCommand', { commandId: c.id, args });
          } catch (err) {
            toast(ipcErrorMessage(err), 'error');
          }
        },
      });
    }
  }
  list.push(...extensionUiCommands(installed));
  for (const c of list) c.source = 'extension';
  if (list.length) commands.register(list);
}

export function connectCommands(): () => void {
  void invokeOr('extensions.installed', undefined, []).then(registerExtensionCommands, () => {});
  const offs = [
    oide.on('extensions.changed', registerExtensionCommands),
    oide.on('command.invoke', ({ commandId }) => {
      if (commands.get(commandId)) void commands.run(commandId);
    }),
  ];
  return () => offs.forEach((o) => o());
}
