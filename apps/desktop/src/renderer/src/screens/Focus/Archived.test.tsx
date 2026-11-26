// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentEvent, AgentSummary, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { projects, settings } from '../../lib/mock/fixtures';
import { useAgents } from '../../stores/agents';
import { useArchive } from '../../stores/archive';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSettings } from '../../stores/settings';
import FocusScreen from './index';
import { resetDrafts } from './composerDrafts';

/** Focus opens an archived agent read-only: transcript from the database, Unarchive / Delete, no composer. */

const archived = AgentSummary.parse({
  id: 'arc-1',
  projectId: 'oide',
  title: 'Status bar usage meters',
  status: 'ready-for-review',
  mode: 'auto',
  model: 'opus',
  branch: 'oide/status-bar',
  createdAt: 1,
  updatedAt: 2,
  resumeBlocked: 'Its worktree was deleted, so this session cannot be resumed.',
  pr: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'merged' },
  archived: { at: Date.now(), reason: 'merged', mergeCommit: '4f9c2a1e7b3d', worktreeRemoved: true },
});
const events = [
  AgentEvent.parse({ type: 'user-text', agentId: 'arc-1', seq: 0, ts: 1, text: 'Add usage meters to the status bar' }),
  AgentEvent.parse({ type: 'assistant-text', agentId: 'arc-1', seq: 1, ts: 2, text: 'Added the meters and their tests.' }),
];

const invoke = vi.fn(async (command: string): Promise<unknown> => {
  switch (command) {
    case 'agents.getArchived':
      return archived;
    case 'agents.events':
      return events;
    case 'agents.unarchive': {
      const { archived: _a, ...rest } = archived;
      return { ...rest, status: 'stopped' };
    }
    case 'git.diff':
    case 'extensions.installed':
    case 'artifacts.list':
      return [];
    case 'artifacts.uses':
      return {};
    default:
      return { ok: true };
  }
});
installFallbackBridge({ invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' });

beforeEach(() => {
  resetDrafts();
  invoke.mockClear();
  useAgents.setState({ byId: {}, order: [], events: {}, loaded: true });
  useArchive.setState({ byId: {}, items: [], total: 0, count: 0 });
  useProjects.setState({ list: projects, loaded: true });
  useSettings.setState({ settings });
  useScope.setState({ scope: 'all' });
  useRouter.setState({ route: { screen: 'focus', params: { agentId: 'arc-1' } }, back: [], forward: [] });
});
afterEach(cleanup);

describe('Focus on an archived agent', () => {
  it('is read-only, shows why and when it was archived, its PR, and the stored transcript', async () => {
    render(<FocusScreen />);
    expect(await screen.findByRole('heading', { name: 'Status bar usage meters' })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('agents.getArchived', { agentId: 'arc-1' });
    expect(screen.getAllByText('Merged').length).toBe(2); // archive reason and PR state
    expect(screen.getByText('4f9c2a1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View pull request #42 (merged)' })).toBeTruthy();
    expect(screen.getByText(/This agent is archived; its transcript is read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByPlaceholderText(/Steer this agent/)).toBeNull();
    // The transcript comes from the database (jsdom has no layout, so the virtualized rows are not drawn here).
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents.events', expect.objectContaining({ agentId: 'arc-1' })));
    expect(screen.getByRole('region', { name: 'Transcript' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents.unarchive', { agentId: 'arc-1' }));
  });

  it('says the agent is gone when it is neither live nor archived', async () => {
    invoke.mockImplementationOnce(async () => {
      throw new Error('[not_found] No archived agent');
    });
    useRouter.setState({ route: { screen: 'focus', params: { agentId: 'nope' } }, back: [], forward: [] });
    render(<FocusScreen />);
    expect(await screen.findByText('This agent is gone')).toBeTruthy();
  });
});
