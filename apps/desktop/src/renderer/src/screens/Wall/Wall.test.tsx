// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { keymap } from '../../lib/keymap';
import { agents, projects, settings } from '../../lib/mock/fixtures';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { useNewProject } from '../../stores/newProject';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSettings } from '../../stores/settings';
import WallScreen from './index';
import { useWall } from './wallState';
import { useGit } from '../SourceControl/gitStore';

const invoke = vi.fn(async (command: string, _input?: unknown): Promise<unknown> => {
  if (command === 'agents.answerPermission' || command === 'agents.send' || command === 'agents.compact') return { ok: true };
  throw new Error(`[not_implemented] ${command}`);
});
installFallbackBridge({ invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' });

let detach: () => void;

function seed() {
  const byId = Object.fromEntries(agents.map((a) => [a.id, structuredClone(a)]));
  useAgents.setState({ byId, order: agents.map((a) => a.id), events: {}, loaded: true });
  useProjects.setState({ list: projects, loaded: true });
  useSettings.setState({ settings });
  useScope.setState({ scope: 'all' });
  useWall.setState({ filter: 'all', focusedId: null, highlighted: {}, compactFor: null });
  useRouter.setState({ route: { screen: 'wall', params: {} }, back: [], forward: [] });
}

function tile(id: string): HTMLElement {
  return document.querySelector(`[data-agent-id="${id}"]`) as HTMLElement;
}

function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
}

beforeEach(() => {
  invoke.mockClear();
  seed();
  detach = keymap.attach(window);
});
afterEach(() => {
  cleanup();
  detach();
});

describe('Wall tiles', () => {
  it('renders one tile per agent with its status', () => {
    render(<WallScreen />);
    expect(document.querySelectorAll('article[data-agent-id]')).toHaveLength(6);
    expect(within(tile('a-bridge')).getByText('Needs permission')).toBeTruthy();
    expect(within(tile('a-invoice')).getByText('Has a question')).toBeTruthy();
    expect(within(tile('a-webhook')).getByText('Ready for review')).toBeTruthy();
    expect(tile('a-shell').getAttribute('data-status')).toBe('running');
    expect(tile('a-shell').textContent).toMatch(/Running · 1\dm/);
    // Inline permission prompt, reply box and review actions
    expect(within(tile('a-bridge')).getByText('npm install node-pty')).toBeTruthy();
    expect(within(tile('a-bridge')).getByRole('button', { name: 'Always in oide' })).toBeTruthy();
    expect(within(tile('a-invoice')).getByLabelText(/Reply to Fix the flaky invoice test/)).toBeTruthy();
    expect(within(tile('a-webhook')).getByRole('link', { name: 'Review diff' })).toBeTruthy();
    // Subagent chips summary, from the canvas
    expect(within(tile('a-shell')).getByRole('group', { name: 'Subagents: 2 of 3 running' })).toBeTruthy();
    // Status changes are announced
    expect(tile('a-bridge').querySelector('[aria-live="polite"]')?.textContent).toBe('Wire the Claude Code CLI bridge: Needs permission');
  });

  it('shows rate-limited and error states', () => {
    const a = structuredClone(agents[0]!);
    useAgents.getState().applySummary({ ...a, id: 'a-rl', status: 'rate-limited', rateLimitResetAt: Date.now() + 3_600_000, createdAt: a.createdAt + 1 });
    useAgents.getState().applySummary({ ...a, id: 'a-err', status: 'error', exitCode: 3, error: 'boom', createdAt: a.createdAt + 2 });
    render(<WallScreen />);
    expect(within(tile('a-rl')).getByText('Paused by plan limit')).toBeTruthy();
    expect(within(tile('a-rl')).getByText(/does not retry on its own/)).toBeTruthy();
    expect(within(tile('a-err')).getByText('The claude process exited with code 3.')).toBeTruthy();
    expect(within(tile('a-err')).getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('updates only from the agents store', () => {
    render(<WallScreen />);
    act(() => useAgents.getState().applySummary({ ...useAgents.getState().byId['a-shell']!, status: 'ready-for-review' }));
    expect(within(tile('a-shell')).getByText('Ready for review')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review · 2' })).toBeTruthy();
  });

  it('shows a queued tile undimmed, with its label in ink-3 (readable), and the long mode name on the badge', () => {
    const a = structuredClone(agents[0]!);
    useAgents.getState().applySummary({ ...a, id: 'a-q', status: 'queued', mode: 'acceptEdits', pendingPermission: undefined, createdAt: a.createdAt + 1 });
    render(<WallScreen />);
    expect(tile('a-q').className).not.toMatch(/opacity-/);
    expect(within(tile('a-q')).getByText('Waiting for a free slot.')).toBeTruthy();
    expect(within(tile('a-q')).getByText('Edit automatically')).toBeTruthy();
  });

  it('with no project open, offers the New project options and no Spawn agent (Spawn needs a project)', () => {
    useAgents.setState({ byId: {}, order: [] });
    useProjects.setState({ list: [], loaded: true });
    useNewProject.setState({ open: false, tab: 'open' });
    render(<WallScreen />);
    expect(screen.getByText('Start a project')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy(); // sidebar +
    expect(screen.queryByRole('button', { name: 'Spawn agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clone repository' }));
    expect(useNewProject.getState()).toMatchObject({ open: true, tab: 'clone' });
    fireEvent.click(screen.getByRole('button', { name: 'New repository' }));
    expect(useNewProject.getState().tab).toBe('create');
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(useNewProject.getState().tab).toBe('open');
  });

  it('filters with the chips', () => {
    render(<WallScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Needs you · 2' }));
    expect([...document.querySelectorAll('article[data-agent-id]')].map((e) => e.getAttribute('data-agent-id')).sort()).toEqual(['a-bridge', 'a-invoice']);
  });
});

describe('permission answers', () => {
  it.each([
    ['Allow once', { requestId: 'perm-1', behavior: 'allow', always: false }],
    ['Always in oide', { requestId: 'perm-1', behavior: 'allow', always: true }],
    ['Deny', { requestId: 'perm-1', behavior: 'deny', message: 'Denied by user' }],
  ])('%s quotes the exact request id', async (label, answer) => {
    render(<WallScreen />);
    await act(async () => {
      fireEvent.click(within(tile('a-bridge')).getByRole('button', { name: label }));
    });
    expect(invoke).toHaveBeenCalledWith('agents.answerPermission', { agentId: 'a-bridge', answer });
  });

  it('Y and D answer the focused tile only', async () => {
    render(<WallScreen />);
    act(() => tile('a-shell').focus());
    press('y');
    expect(invoke).not.toHaveBeenCalledWith('agents.answerPermission', expect.anything());
    act(() => tile('a-bridge').focus());
    await act(async () => press('y'));
    expect(invoke).toHaveBeenCalledWith('agents.answerPermission', { agentId: 'a-bridge', answer: { requestId: 'perm-1', behavior: 'allow', always: false } });
    invoke.mockClear();
    await act(async () => press('d'));
    expect(invoke).toHaveBeenCalledWith('agents.answerPermission', { agentId: 'a-bridge', answer: { requestId: 'perm-1', behavior: 'deny', message: 'Denied by user' } });
  });

  it('sends the inline reply', async () => {
    render(<WallScreen />);
    const input = within(tile('a-invoice')).getByLabelText(/Reply to/);
    fireEvent.change(input, { target: { value: 'Always UTC' } });
    await act(async () => {
      fireEvent.click(within(tile('a-invoice')).getByRole('button', { name: 'Send' }));
    });
    expect(invoke).toHaveBeenCalledWith('agents.send', { agentId: 'a-invoice', message: { kind: 'text', text: 'Always UTC' } });
  });

  it('asks before sending /compact', async () => {
    render(<WallScreen />);
    fireEvent.click(within(tile('a-invoice')).getByRole('button', { name: /Context 92% full/ }));
    expect(invoke).not.toHaveBeenCalledWith('agents.compact', expect.anything());
    const dialog = screen.getByRole('dialog', { name: 'Compact this session?' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Compact' }));
    });
    expect(invoke).toHaveBeenCalledWith('agents.compact', { agentId: 'a-invoice' });
  });
});

describe('Wall keys', () => {
  const order = () => useAgents.getState().order;

  it('J / K move focus between tiles, wrapping', () => {
    render(<WallScreen />);
    press('j');
    expect(useWall.getState().focusedId).toBe(order()[0]);
    expect(document.activeElement).toBe(tile(order()[0]!));
    press('j');
    expect(useWall.getState().focusedId).toBe(order()[1]);
    press('k');
    press('k');
    expect(useWall.getState().focusedId).toBe(order()[order().length - 1]);
  });

  it('N jumps to the next agent that needs you, cycling', () => {
    render(<WallScreen />);
    press('n');
    const first = useWall.getState().focusedId;
    expect(['a-bridge', 'a-invoice']).toContain(first);
    press('n');
    const second = useWall.getState().focusedId;
    expect(['a-bridge', 'a-invoice']).toContain(second);
    expect(second).not.toBe(first);
  });

  it('Enter opens Focus, Esc clears the selection', () => {
    render(<WallScreen />);
    press('j');
    press('Escape');
    expect(useWall.getState().focusedId).toBeNull();
    act(() => tile('a-bridge').focus());
    fireEvent.keyDown(tile('a-bridge'), { key: 'Enter' });
    expect(useRouter.getState().route).toEqual({ screen: 'focus', params: { agentId: 'a-bridge' } });
  });
});

describe('Wall review tile: Push to an open PR', () => {
  const pr = { state: 'open' as const, number: 21, url: 'https://github.com/you/billing-api/pull/21' };
  const base = invoke.getMockImplementation()!;
  afterEach(() => {
    invoke.mockImplementation(base);
  });
  function withPushState(push: { unpushed?: number; uncommitted?: number }) {
    useGit.setState({ byProject: {} });
    const a = useAgents.getState().byId['a-webhook']!;
    useAgents.setState({ byId: { ...useAgents.getState().byId, 'a-webhook': { ...a, pr: { ...pr, updatedAt: 0 } as never } } });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'git.worktrees') return [{ agentId: 'a-webhook', projectId: 'billing-api', path: '/w', branch: 'billing-api/webhook-retry', baseRef: 'main', ahead: 2, behind: 0, changedFiles: [], orphaned: false, ...push }];
      throw new Error(`[not_implemented] ${command}`);
    });
  }

  it('shows Push when the worktree has commits the PR lacks', async () => {
    withPushState({ unpushed: 1, uncommitted: 0 });
    render(<WallScreen />);
    expect(await within(tile('a-webhook')).findByRole('button', { name: 'Push new changes to pull request #21' })).toBeTruthy();
  });

  it('hides Push when the PR already has everything', async () => {
    withPushState({ unpushed: 0, uncommitted: 0 });
    render(<WallScreen />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git.worktrees', { projectId: 'billing-api' }));
    await act(async () => {});
    expect(within(tile('a-webhook')).queryByRole('button', { name: /Push new changes/ })).toBeNull();
  });
});
