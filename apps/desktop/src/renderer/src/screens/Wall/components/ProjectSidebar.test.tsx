// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMockApp } from '../../SourceControl/testing';
import { ProjectSidebar } from './ProjectSidebar';

afterEach(cleanup);

describe('Projects sidebar Pull button', () => {
  it('offers Pull on a project behind its upstream (after the background fetch) and pulls from the sidebar', async () => {
    const { invoke } = await setupMockApp();
    render(<ProjectSidebar />);

    // Mock data: oide's main is 2 behind origin/main; billing-api is up to date.
    const oide = await screen.findByRole('group', { name: 'oide' });
    const pull = await within(oide).findByRole('button', { name: 'Pull 2 new commits into oide' });
    expect(pull.title).toMatch(/main is 2 behind origin\/main/);
    expect(within(screen.getByRole('group', { name: 'billing-api' })).queryByRole('button', { name: /^Pull/ })).toBeNull();

    await act(async () => {
      fireEvent.click(pull);
    });
    expect(invoke).toHaveBeenCalledWith('git.pull', { projectId: 'oide', from: 'sidebar' });
    await waitFor(() => expect(within(oide).queryByRole('button', { name: /^Pull/ })).toBeNull());
  });

  it('shows Pull once a background fetch reports new commits (git.changed)', async () => {
    const { bridge, real } = await setupMockApp();
    render(<ProjectSidebar />);
    const billing = await screen.findByRole('group', { name: 'billing-api' });
    await waitFor(() => expect(within(billing).queryByRole('button', { name: /^Pull/ })).toBeNull());

    vi.mocked(bridge.invoke).mockImplementation(((cmd: string, input: unknown) =>
      cmd === 'git.sync' && (input as { projectId: string }).projectId === 'billing-api'
        ? Promise.resolve({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 1, dirtyFiles: [] })
        : real(cmd as never, input as never)) as never);
    await act(async () => {
      bridge.emit('git.changed', { projectId: 'billing-api' });
    });
    expect(await within(billing).findByRole('button', { name: 'Pull 1 new commit into billing-api' })).toBeTruthy();
  });
});
