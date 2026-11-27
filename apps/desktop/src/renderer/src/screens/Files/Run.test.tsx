// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminals } from '../../stores/terminals';
import { useUi } from '../../stores/ui';
import { setupMockApp } from '../SourceControl/testing';
import { useFiles } from './filesStore';
import FilesScreen from './index';
import { useScripts } from './scriptsStore';
import type { EditorPaneProps } from './EditorPane';

vi.mock('./EditorPane', () => ({
  default: ({ active }: EditorPaneProps) => <div>Editing {active.path}</div>,
}));
// xterm does not run in jsdom: a stand-in that says which session it shows.
vi.mock('../../components/terminal/TerminalView', () => ({
  default: ({ label }: { label: string }) => <div role="log" aria-label={label} />,
}));

afterEach(() => {
  cleanup();
  useUi.getState().setHeaderSlot('actions', null);
});
beforeEach(() => {
  // The header's actions slot (Search, Terminal) renders into the app frame; give it a host.
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  useUi.getState().setHeaderSlot('actions', slot);
  useFiles.setState({ openProjects: {}, checkout: {}, expanded: {}, nodes: {}, loading: {}, errors: {}, tabs: [], active: undefined, dirty: {}, revealed: {}, pending: undefined, revealTarget: undefined });
  useTerminals.setState({ sessions: {}, groups: {} });
  useScripts.setState({ byRoot: {}, loadedAt: {} });
});

const OIDE = '/Users/you/code/oide';

describe('Files › Run', () => {
  it('lists the detected scripts in the tree toolbar and runs one in a new terminal', async () => {
    const { invoke } = await setupMockApp({ screen: 'files', params: {} });
    render(<FilesScreen />);
    const toolbar = await screen.findByRole('toolbar', { name: 'File tree actions' });
    const run = await within(toolbar).findByRole('button', { name: 'Run a script' });
    expect(invoke).toHaveBeenCalledWith('scripts.list', { root: OIDE });

    fireEvent.click(run);
    const menu = await screen.findByRole('menu', { name: 'Run a script' });
    // Like the other toolbar buttons it acts on the open trees: only oide is open.
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['buildpnpm', 'devpnpm', 'dev:watchpnpm', 'testpnpm', 'lintpnpm', 'typecheckpnpm']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^dev:watch/ }));

    const tabs = await screen.findByRole('tablist', { name: 'Terminals: open terminals' });
    const tab = within(tabs).getByRole('tab', { name: /dev:watch/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(useTerminals.getState().groups.files?.open).toBe(true);
    const session = Object.values(useTerminals.getState().sessions)[0]!;
    expect(session).toMatchObject({ kind: 'script', cwd: OIDE, context: 'oide', script: { id: 'pnpm:package.json:dev:watch', command: 'pnpm run dev:watch' } });
    expect(await screen.findByRole('log', { name: `dev:watch terminal, in ${OIDE}` })).toBeTruthy();

    // With a second tree open, each script is prefixed with its project.
    fireEvent.click(screen.getByRole('button', { name: /^billing-api/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('scripts.list', { root: '/Users/you/code/billing-api' }));
    fireEvent.click(await within(toolbar).findByRole('button', { name: 'Run a script' }));
    const both = await screen.findByRole('menu', { name: 'Run a script' });
    await waitFor(() => expect(within(both).getAllByRole('menuitem', { name: /^billing-api ›\s?build/ })).toHaveLength(1));
  });

  it('opens, switches and closes several terminals, and hides the panel', async () => {
    await setupMockApp({ screen: 'files', params: {} });
    render(<FilesScreen />);
    const toggle = await screen.findByRole('button', { name: /^Terminal/ });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle);
    const tabs = await screen.findByRole('tablist', { name: 'Terminals: open terminals' });
    expect(within(tabs).getByRole('tab', { name: /Terminal 1/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    const second = within(tabs).getByRole('tab', { name: /Terminal 2/ });
    expect(second.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(tabs).getByRole('tab', { name: /Terminal 1/ }));
    expect(within(tabs).getByRole('tab', { name: /Terminal 1/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Close oide › Terminal 1' }));
    expect(within(tabs).queryByRole('tab', { name: /Terminal 1/ })).toBeNull();
    expect(within(tabs).getByRole('tab', { name: /Terminal 2/ }).getAttribute('aria-selected')).toBe('true');

    // Hiding keeps the terminal; showing again brings it back.
    fireEvent.click(screen.getByRole('button', { name: 'Hide the terminal panel' }));
    expect(screen.queryByRole('tablist', { name: 'Terminals: open terminals' })).toBeNull();
    fireEvent.click(toggle);
    expect(within(await screen.findByRole('tablist', { name: 'Terminals: open terminals' })).getByRole('tab', { name: /Terminal 2/ })).toBeTruthy();

    // Closing the last one hides the panel.
    fireEvent.click(screen.getByRole('button', { name: 'Close oide › Terminal 2' }));
    await waitFor(() => expect(screen.queryByRole('tablist', { name: 'Terminals: open terminals' })).toBeNull());
  });
});
