// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MergePrediction } from '@oide/protocol';
import { useAgents } from '../../stores/agents';
import { fileList, freshnessText, useMergePredictions } from '../../stores/mergePrediction';
import { setupMockApp } from '../SourceControl/testing';
import ReviewScreen from './index';

/**
 * "Merge into main?" states: predicted clean, predicted conflicts (Ask agent to resolve primary,
 * Merge anyway secondary), a merge that stopped anyway, prediction unavailable (old git), and an
 * agent that cannot be asked (worktree gone). Against the dev mock bridge.
 */

afterEach(cleanup);
beforeEach(() => useMergePredictions.setState({ byAgent: {} }));

const prediction = (p: Partial<MergePrediction>): MergePrediction => ({
  agentId: 'a-webhook',
  status: 'clean',
  target: { branch: 'main', sha: 'c0ffee1234567890' },
  branchSha: 'beef',
  files: [],
  binary: [],
  submodules: [],
  behind: 0,
  ahead: 1,
  canAsk: true,
  computedAt: 1,
  ...p,
});

async function openDialog(agentId: string) {
  const { invoke } = await setupMockApp({ screen: 'review', params: { agentId } });
  render(<ReviewScreen />);
  fireEvent.click(await screen.findByRole('button', { name: /Merge worktree into .* locally/ }));
  return { invoke, dialog: await screen.findByRole('dialog') };
}

describe('merge dialog', () => {
  it('predicted clean: says so with the target commit; Merge is the action', async () => {
    const { dialog } = await openDialog('a-webhook');
    await waitFor(() => expect(dialog.textContent).toMatch(/merges cleanly into main @ c0ffee1/));
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /to resolve/ })).toBeNull();
    // The panel shows how the branch stands.
    expect(screen.getByRole('status', { name: /Merge status: Up to date with main/ })).toBeTruthy();
  });

  it('predicted conflicts: files up front, "Ask agent to resolve" first, "Merge anyway" second; asking sends and closes', async () => {
    const { dialog, invoke } = await openDialog('a-bridge');
    await waitFor(() => expect(dialog.textContent).toMatch(/Merging will conflict in 1 file: package\.json\./));
    const buttons = within(dialog).getAllByRole('button').map((b) => b.textContent);
    expect(buttons.slice(-3)).toEqual(['Cancel', 'Merge anyway', 'Ask agent to resolve']);
    // The agent's title stays out of the button (long titles pushed it out of the dialog); the note names it.
    expect(within(dialog).getByRole('button', { name: 'Ask agent to resolve' }).title).toBe('Send the conflicts to Wire the Claude Code CLI br…');
    expect(dialog.textContent).toMatch(/oIDE sends Wire the Claude Code CLI br… the conflicts as a message/);
    expect(within(dialog).getByRole('list', { name: 'Conflicted files' }).textContent).toContain('package.json');
    expect(dialog.textContent).toMatch(/to resolve in its own worktree\. Merge again once it submits for review/);
    fireEvent.click(within(dialog).getByRole('button', { name: /Ask .* to resolve/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git.askToResolve', { agentId: 'a-bridge', source: 'prediction' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith('git.mergeLocal', expect.anything());
  });

  it('while the agent resolves, Review says so instead of the prediction', async () => {
    await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    const a = useAgents.getState().byId['a-webhook']!;
    useAgents.getState().applySummary({ ...a, mergeConflict: { target: 'main', targetSha: 'c0ffee1', files: ['a.ts', 'b.ts'], sentAt: Date.now() - 120_000 } });
    render(<ReviewScreen />);
    expect(await screen.findByText('Resolving merge conflicts')).toBeTruthy();
    expect(screen.getByText(/Sent 2 conflicted files with main 2m ago/)).toBeTruthy();
  });

  it('Merge anyway stops on conflicts and offers the same action in the result', async () => {
    const { dialog, invoke } = await openDialog('a-bridge');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Merge anyway' })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge anyway' }));
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toMatch(/The merge stopped on conflicts/));
    const result = screen.getByRole('dialog');
    expect(result.textContent).toMatch(/Nothing changed in main: oIDE aborted the merge/);
    fireEvent.click(within(result).getByRole('button', { name: /Ask .* to resolve/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git.askToResolve', { agentId: 'a-bridge', source: 'merge' }));
  });

  it('when git cannot predict, it says why and Merge stays the action; uncommitted main files are listed', async () => {
    const { invoke, real } = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    invoke.mockImplementation(((command: string, input: unknown) =>
      command === 'git.predictMerge'
        ? Promise.resolve(prediction({ status: 'unknown', reason: 'oIDE could not predict conflicts: unknown option (git 2.38 or newer is needed).', mainDirty: ['README.md'] }))
        : real(command as never, input as never)) as never);
    render(<ReviewScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /Merge worktree into .* locally/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toMatch(/git 2\.38 or newer is needed/));
    expect(dialog.textContent).toMatch(/It stops on conflicts and leaves main as it was/);
    expect(within(dialog).getByRole('note', { name: 'Uncommitted changes in the main checkout' }).textContent).toMatch(/1 file \(README\.md\).*set aside \(stashed\) for the merge and put back/);
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeTruthy();
  });

  it('an agent whose worktree is gone cannot be asked: the reason is shown and Merge anyway is the primary', async () => {
    const { invoke, real } = await setupMockApp({ screen: 'review', params: { agentId: 'a-webhook' } });
    const blocked = "Its worktree was deleted, so the agent can't resolve conflicts there. Resolve them by hand, or hand them to a new agent.";
    invoke.mockImplementation(((command: string, input: unknown) =>
      command === 'git.predictMerge'
        ? Promise.resolve(prediction({ status: 'conflicts', files: ['a.ts', 'logo.png'], binary: ['logo.png'], behind: 3, canAsk: false, askBlocked: blocked }))
        : real(command as never, input as never)) as never);
    render(<ReviewScreen />);
    expect(await screen.findByRole('status', { name: 'Merge status: Behind main by 3 commits, would conflict in 2 files' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Merge worktree into .* locally/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain(blocked));
    expect(within(dialog).queryByRole('button', { name: /to resolve/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Merge anyway' }).className).toMatch(/primary|accent/);
    expect(within(dialog).getByText('binary')).toBeTruthy();
  });
});

describe('merge freshness text', () => {
  it('reads as the brief asks', () => {
    expect(freshnessText(prediction({}))).toBe('Up to date with main');
    expect(freshnessText(prediction({ behind: 2 }))).toBe('Behind main by 2 commits, merges cleanly');
    expect(freshnessText(prediction({ behind: 1, status: 'conflicts', files: ['a'] }))).toBe('Behind main by 1 commit, would conflict in 1 file');
    expect(freshnessText(prediction({ behind: 2, status: 'conflicts', files: ['a'] }), { short: true })).toBe('Behind main by 2 · would conflict');
    expect(freshnessText(prediction({ status: 'conflicts', files: ['a', 'b'] }))).toBe('Would conflict with main in 2 files');
    expect(freshnessText(prediction({ behind: 4, status: 'unknown' }))).toBe('Behind main by 4 commits');
    expect(freshnessText(prediction({ target: { sha: 'abcdef123456' } }))).toBe('Up to date with abcdef1');
    expect(freshnessText(prediction({ status: 'unavailable' }))).toBeUndefined();
    expect(fileList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });
});
