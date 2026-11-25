// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ArtifactMeta, ArtifactUse, Project, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useUi } from '../../stores/ui';
import ArtifactsScreen from './index';

const now = Date.now();
const meta = (id: string, title: string, kind: ArtifactMeta['kind'], projectId: string, extra: Partial<ArtifactMeta> = {}) =>
  ArtifactMeta.parse({ id, slug: id, title, kind, projectId, location: 'repo', version: 1, entry: 'x', createdAt: now, updatedAt: now, ...extra });

const list = [
  meta('a-design', 'Main window v2', 'design', 'oide', { importedFrom: 'https://claude.ai/public/artifacts/abc', version: 2 }),
  meta('a-doc', 'Webhook retry design', 'doc', 'billing-api'),
  meta('a-board', 'Session lifecycle', 'whiteboard', 'oide'),
];

const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  switch (command) {
    case 'artifacts.list':
      return list;
    case 'artifacts.uses':
      return { 'a-design': [ArtifactUse.parse({ artifactId: 'a-design', agentId: 'ag1', op: 'read', ts: now }), ArtifactUse.parse({ artifactId: 'a-design', agentId: 'ag2', op: 'read', ts: now })] };
    case 'artifacts.get': {
      const m = list.find((a) => a.id === (input as { id: string }).id)!;
      return { meta: m, content: m.kind === 'doc' ? '# Retry\n\n<script>alert(1)</script>Backoff' : m.kind === 'whiteboard' ? '{"elements":[]}' : '<p>hi</p>', uses: [], versions: [{ version: 1, ts: now, author: 'user' }] };
    }
    case 'scope.set':
      return (input as { scope: string }).scope;
    case 'shell.openExternal':
      return { ok: true };
    default:
      throw new Error(`[not_implemented] ${command}`);
  }
});

const bridge: OideBridge = { invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' };

beforeEach(() => {
  installFallbackBridge(bridge);
  invoke.mockClear();
  useProjects.setState({
    list: ['oide', 'billing-api'].map((id) => Project.parse({ id, name: id, path: `/code/${id}`, trusted: true, createdAt: now })),
    loaded: true,
  });
  useScope.setState({ scope: 'all' });
  useRouter.setState({ route: { screen: 'artifacts', params: {} }, back: [], forward: [] });
  // The header's actions slot (the search field renders there).
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  useUi.getState().setHeaderSlot('actions', slot);
});

afterEach(() => {
  cleanup();
  useUi.getState().setHeaderSlot('actions', null);
  document.body.innerHTML = '';
});

const grid = () => screen.getByRole('tabpanel', { name: 'Artifacts' });
const cardTitles = () => within(grid()).getAllByRole('button').map((b) => b.querySelector('span')?.textContent);

describe('Artifacts screen', () => {
  it('filters the grid by kind, project scope and search', async () => {
    render(<ArtifactsScreen />);
    await waitFor(() => expect(cardTitles()).toEqual(['Main window v2', 'Webhook retry design', 'Session lifecycle']));
    expect(screen.getByText('Read by 2 agents')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Docs' }));
    expect(cardTitles()).toEqual(['Webhook retry design']);

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'oide' } });
    await waitFor(() => expect(cardTitles()).toEqual(['Main window v2', 'Session lifecycle']));
    expect(invoke).toHaveBeenCalledWith('scope.set', { scope: 'oide' });

    // The shared scope set elsewhere (Wall, Files) filters here too.
    act(() => useScope.setState({ scope: 'billing-api' }));
    expect(cardTitles()).toEqual(['Webhook retry design']);

    act(() => useScope.setState({ scope: 'all' }));
    fireEvent.change(screen.getByLabelText('Search artifacts'), { target: { value: 'lifecycle' } });
    expect(cardTitles()).toEqual(['Session lifecycle']);
  });

  it('Give to an agent opens Spawn with the artifact as a context chip', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'Main window v2', level: 2 });
    fireEvent.click(screen.getByRole('link', { name: 'Give to an agent' }));
    expect(useRouter.getState().route).toEqual({
      screen: 'spawn',
      params: { projectId: 'oide', context: [{ kind: 'artifact', id: 'a-design', title: 'Main window v2' }] },
    });
  });

  it('shows Open in claude.ai only for claude.ai imports and sanitises rendered docs', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'Main window v2', level: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Open in claude.ai' }));
    expect(invoke).toHaveBeenCalledWith('shell.openExternal', { url: 'https://claude.ai/public/artifacts/abc' });

    fireEvent.click(screen.getByRole('button', { name: /Webhook retry design/ }));
    await screen.findByRole('heading', { name: 'Webhook retry design', level: 2 });
    expect(screen.queryByRole('button', { name: 'Open in claude.ai' })).toBeNull();
    await waitFor(() => expect(document.querySelector('.oide-md h1')?.textContent).toBe('Retry'));
    expect(document.querySelector('.oide-md script')).toBeNull();
  });
});

describe('New artifact dialog', () => {
  const projects = ['oide', 'billing-api'].map((id) => Project.parse({ id, name: id, path: `/code/${id}`, trusted: true, createdAt: now }));
  const repo = () => screen.getByRole('radio', { name: /In the project's repo/ }) as HTMLInputElement;
  const personal = () => screen.getByRole('radio', { name: /Personal/ }) as HTMLInputElement;

  it('starts each use from the scope: a previous "Personal" choice does not carry over', async () => {
    const { NewArtifactDialog } = await import('./Dialogs');
    const props = { onClose: () => {}, projects, defaultProjectId: 'oide', onCreated: () => {} };
    const { rerender } = render(<NewArtifactDialog open {...props} />);
    expect(repo().checked).toBe(true);
    fireEvent.click(personal());
    expect(personal().checked).toBe(true);
    rerender(<NewArtifactDialog open={false} {...props} />);
    rerender(<NewArtifactDialog open {...props} />);
    await waitFor(() => expect(repo().checked).toBe(true));
  });

  it('defaults to the repo when a project is picked after "No project"', async () => {
    const { NewArtifactDialog } = await import('./Dialogs');
    render(<NewArtifactDialog open onClose={() => {}} projects={projects} onCreated={() => {}} />);
    expect(personal().checked).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'billing-api' } });
    expect(repo().checked).toBe(true);
  });
});

describe('Import from claude.ai dialog', () => {
  const projects = ['oide'].map((id) => Project.parse({ id, name: id, path: `/code/${id}`, trusted: true, createdAt: now }));
  const url = 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T#open';
  const imported = meta('a-new', 'Checkout', 'design', 'oide');
  const base = invoke.getMockImplementation()!;
  afterEach(() => {
    invoke.mockImplementation(base);
  });

  async function open() {
    const { ImportDialog } = await import('./Dialogs');
    const onImported = vi.fn();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'artifacts.import') return imported;
      if (command === 'shell.openExternal') return { ok: true };
      throw new Error(`[not_implemented] ${command}`);
    });
    render(<ImportDialog open onClose={() => {}} projects={projects} defaultProjectId="oide" onImported={onImported} />);
    return { onImported };
  }
  const kind = () => (screen.getByRole('combobox', { name: 'Kind' }) as HTMLSelectElement).value;
  const content = () => screen.getByRole('textbox', { name: 'Artifact content' });

  it('sends the pasted content with the link, the kind following the content', async () => {
    const { onImported } = await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'claude.ai link' }), { target: { value: url } });
    expect(screen.getByRole('button', { name: 'Import link only' })).toBeTruthy();
    const page = '<!doctype html><html><body><h1>Checkout</h1></body></html>';
    fireEvent.change(content(), { target: { value: page } });
    expect(kind()).toBe('design');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(imported));
    expect(invoke).toHaveBeenCalledWith('artifacts.import', { url, content: page, title: undefined, kind: 'design', projectId: 'oide', location: 'app-data' });
  });

  it('opens the link in the browser, and an empty paste imports the link only', async () => {
    const { onImported } = await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'claude.ai link' }), { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(invoke).toHaveBeenCalledWith('shell.openExternal', { url });
    fireEvent.click(screen.getByRole('button', { name: 'Import link only' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('artifacts.import', { url, title: undefined, kind: 'doc', projectId: 'oide', location: 'app-data' });
  });

  it('refuses React source as a design before sending, and keeps a kind the user picked', async () => {
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'claude.ai link' }), { target: { value: url } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'design' } });
    fireEvent.change(content(), { target: { value: "import React from 'react';\nexport default () => <div/>;" } });
    expect(kind()).toBe('design');
    expect(screen.getByText(/isn't an HTML page/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith('artifacts.import', expect.anything());
  });

  it('refuses links that are not https claude.ai', async () => {
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'claude.ai link' }), { target: { value: 'https://example.com/a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import link only' }));
    expect(await screen.findByText('Only https links on claude.ai can be imported.')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('artifacts.import', expect.anything());
  });
});
