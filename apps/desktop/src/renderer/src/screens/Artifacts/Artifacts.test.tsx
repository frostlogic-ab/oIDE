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
