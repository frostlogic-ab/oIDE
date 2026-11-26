// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commands } from '../../lib/commands';
import { useFiles } from '../../screens/Files/filesStore';
import { setupMockApp } from '../../screens/SourceControl/testing';
import { useRouter } from '../../stores/router';
import { useUi } from '../../stores/ui';
import { CommandBar } from './CommandBar';

afterEach(cleanup);
// jsdom has no layout: the bar scrolls the active option into view.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
let unregister: () => void = () => {};
beforeEach(() => {
  useFiles.setState({ checkout: {}, recent: [], pending: undefined, tabs: [], active: undefined });
  unregister = commands.register([
    { id: 't.market', title: 'Go to Marketplace', group: 'Go to', run: () => {} },
    { id: 't.spawn', title: 'Spawn an agent', group: 'Agents', run: () => {} },
  ]);
  return () => unregister();
});

const bar = () => screen.getByRole('dialog', { name: 'Command bar' });
const input = () => within(bar()).getByRole('combobox', { name: 'Search files and commands' });

describe('command bar quick open', () => {
  it('finds files by name across the projects in scope, in a Files section, and opens one in Files', async () => {
    const { invoke } = await setupMockApp({ screen: 'wall', params: {} });
    useUi.getState().openCommandBar('commands');
    render(<CommandBar />);
    fireEvent.change(input(), { target: { value: 'retry' } });
    const option = await within(bar()).findByRole('option', { name: /retry\.ts/ });
    expect(within(bar()).getByText('Files')).toBeTruthy();
    expect(option.textContent).toContain('billing-api');
    expect(invoke).toHaveBeenCalledWith('files.findByName', expect.objectContaining({ query: 'retry', roots: expect.arrayContaining(['/Users/you/code/oide', '/Users/you/code/billing-api']) }));

    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(useRouter.getState().route.screen).toBe('files'));
    expect(useFiles.getState().pending).toMatchObject({ root: '/Users/you/code/billing-api', path: 'src/webhooks/retry.ts' });
    expect(useUi.getState().commandBar.open).toBe(false);
  });

  it('opens "name:line" at that line', async () => {
    await setupMockApp({ screen: 'wall', params: {} });
    useUi.getState().openCommandBar('commands');
    render(<CommandBar />);
    fireEvent.change(input(), { target: { value: 'StatusBar.tsx:6' } });
    const option = await within(bar()).findByRole('option', { name: /StatusBar\.tsx.*line 6/ });
    fireEvent.click(option);
    expect(useFiles.getState().pending).toMatchObject({ path: 'src/shell/StatusBar.tsx', line: 6 });
  });

  it('shows "Searching files…" and keeps a row highlighted when ArrowDown is pressed before results arrive', async () => {
    await setupMockApp({ screen: 'wall', params: {} });
    useUi.getState().openCommandBar('commands');
    render(<CommandBar />);
    // A name that matches no command or session: until file results arrive the list is empty.
    fireEvent.change(input(), { target: { value: 'StatusBar' } });
    expect(within(bar()).getByText('Searching files…')).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const option = await within(bar()).findByRole('option', { name: /StatusBar\.tsx/ });
    expect(within(bar()).queryByText('Searching files…')).toBeNull();
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(option.id);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(useFiles.getState().pending).toMatchObject({ path: 'src/shell/StatusBar.tsx' }));
  });

  it('with ">" lists commands only', async () => {
    await setupMockApp({ screen: 'wall', params: {} });
    useUi.getState().openCommandBar('commands');
    render(<CommandBar />);
    fireEvent.change(input(), { target: { value: '>market' } });
    await waitFor(() => expect(within(bar()).getAllByRole('option')[0]!.textContent).toContain('Go to Marketplace'));
    // give a file search a chance to (wrongly) answer
    await new Promise((r) => setTimeout(r, 80));
    expect(within(bar()).queryByText('Files')).toBeNull();
    expect(within(bar()).getAllByRole('option').every((o) => !/\.(ts|md|json)\b/.test(o.textContent ?? ''))).toBe(true);
  });
});
