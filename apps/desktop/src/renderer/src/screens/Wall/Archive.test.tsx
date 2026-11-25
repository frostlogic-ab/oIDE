// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary, OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { agents, projects, settings } from '../../lib/mock/fixtures';
import { useAgents } from '../../stores/agents';
import { useArchive } from '../../stores/archive';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSettings } from '../../stores/settings';
import WallScreen from './index';
import { useWall } from './wallState';

/** Wall › Archived, the Interrupted tile, Archive actions, View PR, and the load-error banner. */

const archived: AgentSummary[] = Array.from({ length: 3 }, (_, i) => ({
  ...structuredClone(agents[5]!),
  id: `arc-${i}`,
  title: i === 1 ? 'Webhook retries spike' : `Finished task ${i}`,
  projectId: i === 1 ? 'billing-api' : 'oide',
  status: 'ready-for-review',
  diff: { files: 2, additions: 10 + i, deletions: 3 },
  costUsd: 0.5 + i,
  archived: { at: 1_795_000_000_000 - i * 1000, reason: i === 0 ? 'merged' : i === 1 ? 'discarded' : 'archived-by-user', worktreeRemoved: i !== 2, ...(i === 0 ? { mergeCommit: 'abcdef1234567' } : {}) },
}));

const invoke = vi.fn(async (command: string, input?: unknown): Promise<unknown> => {
  const i = (input ?? {}) as { projectId?: string; query?: string; agentId?: string; limit?: number };
  if (command === 'agents.listArchived') {
    const items = archived.filter((a) => (!i.projectId || a.projectId === i.projectId) && (!i.query || a.title.toLowerCase().includes(i.query.toLowerCase())));
    return { items: items.slice(0, i.limit ?? 50), total: items.length };
  }
  if (command === 'agents.unarchive') {
    const a = archived.find((x) => x.id === i.agentId)!;
    const { archived: _drop, ...rest } = a;
    return { ...rest, status: 'stopped' };
  }
  if (command === 'agents.archive') {
    const a = useAgents.getState().byId[i.agentId!]!;
    return { ...a, archived: { at: Date.now(), reason: 'archived-by-user', worktreeRemoved: false } };
  }
  if (command === 'agents.deletePermanently') return { deleted: true };
  if (command === 'shell.openExternal') return { ok: true };
  if (command === 'agents.list') throw new Error('[invalid_output] Handler for agents.list returned invalid output');
  throw new Error(`[not_implemented] ${command}`);
});
installFallbackBridge({ invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' });

// jsdom has no layout: give the archived list's scroll box a height so the virtualizer renders rows.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset.testid === 'archived-scroll' ? 720 : 0;
  },
});

function seed(extra: AgentSummary[] = []) {
  const all = [...agents.map((a) => structuredClone(a)), ...extra];
  useAgents.setState({ byId: Object.fromEntries(all.map((a) => [a.id, a])), order: all.map((a) => a.id), events: {}, loaded: true, loadError: null, loading: false });
  useArchive.setState({ items: [], total: 0, byId: {}, count: 0, countScope: null, scope: 'all', query: '', loaded: false, loading: false, error: null });
  useProjects.setState({ list: projects, loaded: true });
  useSettings.setState({ settings });
  useScope.setState({ scope: 'all' });
  useWall.setState({ view: 'active', archiveQuery: '', filter: 'all', focusedId: null, highlighted: {}, compactFor: null });
  useRouter.setState({ route: { screen: 'wall', params: {} }, back: [], forward: [] });
}

const tile = (id: string) => document.querySelector(`article[data-agent-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  invoke.mockClear();
  seed();
});
afterEach(cleanup);

describe('Wall › Archived', () => {
  it('shows "Archived (N)" next to the title and lists archived agents newest first with outcome, branch, lines and cost', async () => {
    render(<WallScreen />);
    const toggle = screen.getByRole('radiogroup', { name: 'Show agents' });
    await waitFor(() => expect(within(toggle).getByRole('radio', { name: 'Archived (3)' })).toBeTruthy());
    fireEvent.click(within(toggle).getByRole('radio', { name: 'Archived (3)' }));
    const list = await screen.findByRole('list', { name: /Archived agents/ });
    const rows = within(list).getAllByRole('article');
    expect(rows.map((r) => r.getAttribute('data-agent-id'))).toEqual(['arc-0', 'arc-1', 'arc-2']);
    expect(within(rows[0]!).getByText('Merged')).toBeTruthy();
    expect(within(rows[0]!).getByText('abcdef1')).toBeTruthy();
    expect(within(rows[0]!).getByText('$0.50')).toBeTruthy();
    expect(rows[0]!.textContent).toMatch(/\+10/);
    expect(within(rows[1]!).getByText('Discarded')).toBeTruthy();
    expect(rows[1]!.textContent).toMatch(/worktree deleted/);
    // No tile grid, no filter chips in this view; archived agents never count on the Wall.
    expect(document.querySelectorAll('article[data-status]')).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Filter', hidden: true }).className).toMatch(/hidden/);
  });

  it('searches by title and scopes by project like the Wall', async () => {
    useWall.setState({ view: 'archived' });
    render(<WallScreen />);
    await screen.findByRole('list', { name: /Archived agents/ });
    fireEvent.change(screen.getByLabelText('Search archived agents'), { target: { value: 'webhook' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents.listArchived', expect.objectContaining({ query: 'webhook' })));
    await waitFor(() => expect(screen.getAllByRole('article').map((r) => r.getAttribute('data-agent-id'))).toEqual(['arc-1']));
    fireEvent.change(screen.getByLabelText('Search archived agents'), { target: { value: 'nothing here' } });
    expect(await screen.findByText(/No archived agents match/)).toBeTruthy();

    cleanup();
    useWall.setState({ archiveQuery: '' });
    useScope.setState({ scope: 'oide' });
    render(<WallScreen />);
    await waitFor(() => expect(screen.getAllByRole('article').map((r) => r.getAttribute('data-agent-id'))).toEqual(['arc-0', 'arc-2']));
  });

  it('Unarchive puts it back; Delete permanently asks main (which confirms natively)', async () => {
    useWall.setState({ view: 'archived' });
    render(<WallScreen />);
    const row = await screen.findByRole('article', { name: /Finished task 0/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Unarchive Finished task 0' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents.unarchive', { agentId: 'arc-0' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: /Finished task 0/ })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Webhook retries spike permanently' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents.deletePermanently', { agentId: 'arc-1' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: /Webhook retries spike/ })).toBeNull());
  });

  it('an archived list longer than a screen is virtualized', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...archived[2]!, id: `m-${i}`, title: `Task ${i}`, archived: { ...archived[2]!.archived!, at: 2_000_000 - i } }));
    const saved = archived.splice(0, archived.length, ...many);
    try {
      useWall.setState({ view: 'archived' });
      render(<WallScreen />);
      await screen.findByRole('list', { name: /Archived agents/ });
      await waitFor(() => expect(screen.getAllByRole('article').length).toBeGreaterThan(5));
      // 50 loaded (one page), far fewer drawn.
      expect(useArchive.getState().items).toHaveLength(50);
      expect(screen.getAllByRole('article').length).toBeLessThan(30);
    } finally {
      archived.splice(0, archived.length, ...saved);
    }
  });
});

describe('Interrupted, Archive and PR on the Wall', () => {
  it('an agent stopped by a restart shows "Interrupted" with Resume and Archive', () => {
    seed([{ ...structuredClone(agents[0]!), id: 'int-1', title: 'Was working', status: 'stopped', interrupted: { at: 1, reason: 'crash' }, activity: ['Edit src/a.ts +3 −1'] }]);
    render(<WallScreen />);
    const t = tile('int-1');
    expect(within(t).getByText('Interrupted')).toBeTruthy();
    expect(within(t).getByText(/oIDE stopped unexpectedly while this agent was working/)).toBeTruthy();
    expect(within(t).getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(within(t).getByRole('button', { name: 'Archive Was working' })).toBeTruthy();
  });

  it('a worktree-less unarchived agent says it cannot resume instead of offering Resume', () => {
    seed([{ ...structuredClone(agents[0]!), id: 'blk', title: 'Blocked', status: 'stopped', resumeBlocked: 'Its worktree was deleted, so this session cannot be resumed.' }]);
    render(<WallScreen />);
    expect(within(tile('blk')).queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(within(tile('blk')).getByText("Can't resume")).toBeTruthy();
  });

  it('Archive on a finished tile moves it off the Wall', async () => {
    render(<WallScreen />);
    const review = agents.find((a) => a.status === 'ready-for-review')!;
    fireEvent.click(within(tile(review.id)).getByRole('button', { name: `Archive ${review.title}` }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents.archive', { agentId: review.id }));
    expect(useArchive.getState().byId[review.id]?.archived?.reason).toBe('archived-by-user');
    // A running agent offers no Archive.
    const running = agents.find((a) => a.status === 'running')!;
    expect(within(tile(running.id)).queryByRole('button', { name: `Archive ${running.title}` })).toBeNull();
  });

  it('a review tile with a PR shows "View PR #12" and its state instead of "Open PR"', () => {
    const review = agents.find((a) => a.status === 'ready-for-review')!;
    seed();
    act(() => useAgents.getState().applySummary({ ...useAgents.getState().byId[review.id]!, pr: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'draft' } }));
    render(<WallScreen />);
    const t = tile(review.id);
    expect(within(t).queryByRole('button', { name: 'Open PR' })).toBeNull();
    fireEvent.click(within(t).getByRole('button', { name: 'View pull request #12 (draft)' }));
    expect(invoke).toHaveBeenCalledWith('shell.openExternal', { url: 'https://github.com/o/r/pull/12' });
    expect(within(t).getByText('Draft')).toBeTruthy();
  });

  it('a failed agents.list shows an error with Retry, never an empty "No agents yet"', async () => {
    useAgents.setState({ byId: {}, order: [], loaded: false, loadError: 'Handler for agents.list returned invalid output', loading: false });
    render(<WallScreen />);
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn't load your agents/);
    expect(screen.queryByText('No agents yet')).toBeNull();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents.list', undefined));
  });
});
