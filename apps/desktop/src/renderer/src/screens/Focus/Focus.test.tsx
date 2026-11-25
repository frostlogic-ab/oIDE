// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSummary, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { keymap } from '../../lib/keymap';
import { artifacts, projects, settings } from '../../lib/mock/fixtures';
import { focusEvents } from '../../lib/mock/focus';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSettings } from '../../stores/settings';
import { Composer } from './components/Composer';
import { PermissionPrompt } from './components/PermissionPrompt';
import FocusScreen from './index';

const invoke = vi.fn(async (command: string, input?: unknown): Promise<unknown> => {
  switch (command) {
    case 'agents.events': {
      const { agentId, beforeSeq } = input as { agentId: string; beforeSeq?: number };
      const all = focusEvents[agentId] ?? [];
      return (beforeSeq === undefined ? all : all.filter((e) => e.seq < beforeSeq)).slice(-500);
    }
    case 'artifacts.list':
      return artifacts;
    case 'artifacts.uses':
      return {};
    case 'extensions.installed':
    case 'git.diff':
      return [];
    case 'dialog.pickFiles':
      return { attachments: [{ kind: 'file', path: '/tmp/spec.pdf', name: 'spec.pdf', size: 2048 }], rejected: [] };
    default:
      return { ok: true };
  }
});
installFallbackBridge({ invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' });

const request = {
  requestId: 'perm-42',
  agentId: 'a-bridge',
  subagentId: 'sa-deps',
  toolUseId: 'sd-3',
  toolName: 'Bash',
  input: { command: 'npm install node-pty' },
  summary: 'Run npm install node-pty',
  suggestedRule: 'Bash(npm install:*)',
  createdAt: 0,
};

const bridge = AgentSummary.parse({
  id: 'a-bridge',
  projectId: 'oide',
  title: 'Wire the Claude Code CLI bridge',
  status: 'needs-permission',
  mode: 'auto',
  model: 'opus',
  branch: 'oide/cli-bridge',
  worktreePath: '/w/cli-bridge',
  contextUsed: 162_000,
  contextWindow: 200_000,
  pendingPermission: request,
  subagents: [
    { id: 'sa-deps', agentId: 'a-bridge', name: 'Dependency setup', task: 'Add node-pty', tier: 'standard', model: 'sonnet', effort: 'medium', status: 'needs-permission', startedAt: 0 },
    { id: 'sa-parser', agentId: 'a-bridge', name: 'Parser tests', task: 'Write tests for the parser', tier: 'standard', model: 'sonnet', effort: 'medium', status: 'running', startedAt: 0 },
  ],
  createdAt: Date.now() - 19 * 60_000,
  updatedAt: Date.now(),
});

let detach: () => void;
const calls = (command: string) => invoke.mock.calls.filter((c) => c[0] === command).map((c) => c[1]);

beforeEach(() => {
  invoke.mockClear();
  useAgents.setState({ byId: { [bridge.id]: bridge }, order: [bridge.id], events: {}, loaded: true });
  useProjects.setState({ list: projects, loaded: true });
  useSettings.setState({ settings });
  useScope.setState({ scope: 'all' });
  useRouter.setState({ route: { screen: 'focus', params: { agentId: 'a-bridge' } }, back: [], forward: [] });
  detach = keymap.attach(window);
});
afterEach(() => {
  cleanup();
  detach();
});

describe('PermissionPrompt', () => {
  it('answers the exact request id: Allow once, Always, Deny', async () => {
    const { rerender } = render(<PermissionPrompt agentId="a-bridge" request={request} projectName="oide" subagentName="Dependency setup" />);
    expect(screen.getByText('npm install node-pty')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Allow once/ }));
    await waitFor(() => expect(calls('agents.answerPermission')).toHaveLength(1));
    expect(calls('agents.answerPermission')[0]).toEqual({ agentId: 'a-bridge', answer: { requestId: 'perm-42', behavior: 'allow', always: false } });

    rerender(<PermissionPrompt agentId="a-bridge" request={{ ...request, requestId: 'perm-43' }} projectName="oide" />);
    fireEvent.click(screen.getByRole('button', { name: 'Always in oide' }));
    await waitFor(() => expect(calls('agents.answerPermission')).toHaveLength(2));
    expect(calls('agents.answerPermission')[1]).toEqual({ agentId: 'a-bridge', answer: { requestId: 'perm-43', behavior: 'allow', always: true } });

    rerender(<PermissionPrompt agentId="a-bridge" request={{ ...request, requestId: 'perm-44' }} projectName="oide" />);
    fireEvent.click(screen.getByRole('button', { name: /Deny/ }));
    await waitFor(() => expect(calls('agents.answerPermission')).toHaveLength(3));
    expect(calls('agents.answerPermission')[2]).toEqual({ agentId: 'a-bridge', answer: { requestId: 'perm-44', behavior: 'deny', message: 'Denied by user' } });
  });

  it('answers with Y / D once per request, even when pressed twice', async () => {
    render(<PermissionPrompt agentId="a-bridge" request={request} projectName="oide" />);
    fireEvent.keyDown(window, { key: 'y' });
    fireEvent.keyDown(window, { key: 'y' });
    fireEvent.keyDown(window, { key: 'd' });
    await waitFor(() => expect(calls('agents.answerPermission')).toHaveLength(1));
    expect(calls('agents.answerPermission')[0]).toMatchObject({ answer: { requestId: 'perm-42', behavior: 'allow' } });
  });
});

describe('Composer', () => {
  const setup = (extra: Partial<Parameters<typeof Composer>[0]> = {}) => {
    const onCompact = vi.fn();
    const onCycleMode = vi.fn();
    render(<Composer agentId="a-bridge" projectId="oide" placeholder="Steer this agent, or type / for commands" commands={['compact', 'context', 'init']} onCompact={onCompact} onCycleMode={onCycleMode} {...extra} />);
    return { input: screen.getByRole('combobox', { name: 'Message this agent' }) as HTMLTextAreaElement, onCompact, onCycleMode };
  };

  it('sends text with Enter and with Ctrl+Enter', async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'Use UTC' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls('agents.send')).toEqual([{ agentId: 'a-bridge', message: { kind: 'text', text: 'Use UTC' } }]));
    await waitFor(() => expect(input.value).toBe(''));
    fireEvent.change(input, { target: { value: 'and log it' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(calls('agents.send')).toHaveLength(2));
    expect(calls('agents.send')[1]).toEqual({ agentId: 'a-bridge', message: { kind: 'text', text: 'and log it' } });
  });

  it('offers the CLI slash commands and sends them as command messages', async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/con' } });
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('/context')]);
    fireEvent.keyDown(input, { key: 'Enter' }); // picks /context: inserted, not sent
    expect(input.value).toBe('/context ');
    expect(calls('agents.send')).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter' }); // sends it
    await waitFor(() => expect(calls('agents.send')).toEqual([{ agentId: 'a-bridge', message: { kind: 'command', command: '/context' } }]));
  });

  it('routes /compact to the confirm dialog instead of sending it', () => {
    const { input, onCompact } = setup();
    fireEvent.change(input, { target: { value: '/compact' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(calls('agents.send')).toHaveLength(0);
    // Picked from the menu, too.
    fireEvent.change(input, { target: { value: '/comp' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /compact/ }));
    expect(onCompact).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('');
  });

  it('sends a pasted screenshot as an image attachment with the text', async () => {
    const { input } = setup();
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])], 'image.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [png], types: ['Files'] } });
    const chip = await screen.findByRole('list', { name: 'Attachments' });
    expect(chip.textContent).toMatch(/Pasted image [0-9]+[.]png/);
    expect(chip.textContent).toContain('12 B');
    fireEvent.change(input, { target: { value: 'What is wrong here?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls('agents.send')).toHaveLength(1));
    const sent = calls('agents.send')[0] as { message: { kind: string; text: string; attachments: Array<{ kind: string; mediaType: string; dataBase64: string }> } };
    expect(sent.message).toMatchObject({ kind: 'text', text: 'What is wrong here?' });
    expect(sent.message.attachments).toEqual([expect.objectContaining({ kind: 'image', mediaType: 'image/png', dataBase64: 'iVBORw0KGgoAAAAN' })]);
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull());
  });

  it('refuses images over 5 MB with a clear message', async () => {
    const { input } = setup();
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [big], types: ['Files'] } });
    expect((await screen.findByRole('alert')).textContent).toContain('huge.png: images can be at most 5.0 MB');
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull();
  });

  it('Attach file adds picked files as chips (dialog.pickFiles)', async () => {
    const { input } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    expect((await screen.findByRole('list', { name: 'Attachments' })).textContent).toContain('spec.pdf');
    fireEvent.change(input, { target: { value: 'Read this' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls('agents.send')).toEqual([{ agentId: 'a-bridge', message: { kind: 'text', text: 'Read this', attachments: [{ kind: 'file', path: '/tmp/spec.pdf', name: 'spec.pdf', size: 2048 }] } }]));
  });

  it('attaches an artifact and sends an artifact message with the note', async () => {
    const { input } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Attach artifact' }));
    fireEvent.click(await screen.findByRole('button', { name: /Main window v2/ }));
    expect(screen.getByRole('button', { name: 'Remove Main window v2' })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Follow this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls('agents.send')).toEqual([{ agentId: 'a-bridge', message: { kind: 'artifact', artifactId: 'art-main-v2', note: 'Follow this' } }]));
  });

  it('is disabled while the agent is queued', () => {
    const { input } = setup({ disabledReason: 'Queued' });
    expect(input.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches mode with Shift+Tab, as in the CLI', () => {
    const { input, onCycleMode } = setup();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });
});

describe('FocusScreen', () => {
  it('renders the lead transcript from agents.events, with subagent cards and the pinned prompt', async () => {
    render(<FocusScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'Wire the Claude Code CLI bridge' })).toBeTruthy();
    await waitFor(() => expect(calls('agents.events')).toHaveLength(1));
    expect(screen.getByRole('group', { name: 'Permission request' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Always in oide' })).toBeTruthy();
    expect(screen.getByText(/Subagents have used/)).toBeTruthy();
  });

  it('cycles the permission mode with Shift+Tab through agents.setMode', async () => {
    render(<FocusScreen />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(calls('agents.setMode')).toEqual([{ agentId: 'a-bridge', mode: 'default' }]));
    act(() => useAgents.getState().applySummary({ ...bridge, mode: 'plan' }));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(calls('agents.setMode')).toHaveLength(2));
    expect(calls('agents.setMode')[1]).toEqual({ agentId: 'a-bridge', mode: 'auto' });
  });

  it('opens a subagent with its own header, task and Stop subagent', async () => {
    render(<FocusScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Open subagent Parser tests' }));
    expect(useRouter.getState().route).toEqual({ screen: 'focus', params: { agentId: 'a-bridge', subagentId: 'sa-parser' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Parser tests' })).toBeTruthy();
    // Its own transcript (rows are virtualized, so jsdom draws none; the browser check covers them).
    expect(screen.getByRole('region', { name: 'Transcript of subagent Parser tests' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Message the lead agent about Parser tests' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop subagent' }));
    await waitFor(() => expect(calls('agents.stopSubagent')).toEqual([{ agentId: 'a-bridge', subagentId: 'sa-parser' }]));
  });

  it('falls back to the lead view when the subagent id is unknown', async () => {
    act(() => useRouter.setState({ route: { screen: 'focus', params: { agentId: 'a-bridge', subagentId: 'no-such-subagent' } }, back: [], forward: [] }));
    render(<FocusScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'Wire the Claude Code CLI bridge' })).toBeTruthy();
    expect(screen.queryByText('No task text was reported.')).toBeNull();
    await waitFor(() => expect(useRouter.getState().route).toEqual({ screen: 'focus', params: { agentId: 'a-bridge' } }));
  });

  it('asks before compacting and then calls agents.compact', async () => {
    render(<FocusScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Context 81% full/ }));
    const dialog = screen.getByRole('dialog', { name: 'Compact this session?' });
    expect(dialog.textContent).toContain('context 81% full');
    expect(calls('agents.compact')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    await waitFor(() => expect(calls('agents.compact')).toEqual([{ agentId: 'a-bridge' }]));
  });

  it('moves between agents with J and goes back to the wall with Esc', () => {
    const other = AgentSummary.parse({ ...bridge, id: 'a-other', title: 'Other', status: 'running', pendingPermission: undefined, subagents: [], createdAt: bridge.createdAt + 1 });
    useAgents.setState({ byId: { [bridge.id]: bridge, [other.id]: other }, order: [bridge.id, other.id] });
    render(<FocusScreen />);
    fireEvent.keyDown(window, { key: 'j' });
    expect(useRouter.getState().route).toEqual({ screen: 'focus', params: { agentId: 'a-other' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRouter.getState().route.screen).toBe('wall');
  });
});
