// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSummary, type AgentEvent, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { projects, settings } from '../../lib/mock/fixtures';
import { INTERRUPTED_PERMISSION_NOTE, useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSettings } from '../../stores/settings';
import { TileBody } from '../Wall/components/TileBody';
import FocusScreen from './index';
import { resetDrafts } from './composerDrafts';

/** An agent resumed after oIDE quit while its permission prompt was open; its CLI reported its own slash commands. */
const agent = AgentSummary.parse({
  id: 'a-resumed',
  projectId: 'oide',
  title: 'Install the pty',
  status: 'has-question',
  mode: 'auto',
  model: 'sonnet',
  interruptedPermission: { toolName: 'Bash', summary: 'Run npm install node-pty', at: 1 },
  createdAt: 0,
  updatedAt: 1,
});

const events: AgentEvent[] = [
  { agentId: agent.id, seq: 0, ts: 1, type: 'init', sessionId: 's', model: 'sonnet', cwd: '/w', tools: [], mcpServers: [], slashCommands: ['compact', 'review', 'security-review'] },
];

const invoke = vi.fn(async (command: string): Promise<unknown> => {
  if (command === 'agents.events') return events;
  if (command === 'artifacts.uses') return {};
  if (command === 'artifacts.list' || command === 'extensions.installed' || command === 'git.diff') return [];
  return { ok: true };
});

beforeEach(() => {
  resetDrafts();
  installFallbackBridge({ invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' });
  useAgents.setState({ byId: { [agent.id]: agent }, order: [agent.id], events: { [agent.id]: events }, loaded: true });
  useProjects.setState({ list: projects, loaded: true });
  useSettings.setState({ settings });
  useScope.setState({ scope: 'all' });
  useRouter.setState({ route: { screen: 'focus', params: { agentId: agent.id } }, back: [], forward: [] });
});
afterEach(cleanup);

describe('an agent resumed after a prompt was cut off by quitting', () => {
  it('the tile says oIDE closed while waiting and names the tool', () => {
    render(<TileBody agent={agent} />);
    const note = screen.getByRole('note', { name: 'Unanswered permission prompt' });
    expect(note.textContent).toContain(INTERRUPTED_PERMISSION_NOTE);
    expect(note.textContent).toContain('Run npm install node-pty');
  });

  it('Focus shows the note above the composer, and the / menu lists the CLI-reported commands', async () => {
    render(<FocusScreen />);
    const note = await screen.findByRole('note', { name: 'Unanswered permission prompt' });
    expect(note.textContent).toContain('oIDE closed while waiting for your answer; send a message to continue.');
    expect(note.textContent).toContain('Bash');

    const input = screen.getByRole('combobox', { name: 'Message this agent' });
    fireEvent.change(input, { target: { value: '/' } });
    const menu = await screen.findByRole('listbox', { name: 'Commands' });
    expect(within(menu).getAllByRole('option').map((o) => o.querySelector('span')?.textContent)).toEqual(['/compact', '/review', '/security-review']);
  });
});
