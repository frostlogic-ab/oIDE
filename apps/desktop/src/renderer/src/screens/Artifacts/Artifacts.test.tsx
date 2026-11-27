// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { AgentSummary, ArtifactMeta, ArtifactUse, Project, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useUi } from '../../stores/ui';
import { draftIdsKey, useArtifactDrafts } from './draftStore';
import ArtifactsScreen from './index';

const now = Date.now();
const meta = (id: string, title: string, kind: ArtifactMeta['kind'], projectId: string | undefined, extra: Partial<ArtifactMeta> = {}) =>
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

let listeners: Map<string, Set<(p: unknown) => void>>;
const bridge: OideBridge = {
  invoke: invoke as unknown as OideBridge['invoke'],
  on: ((event: string, fn: (p: unknown) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(fn);
    return () => listeners.get(event)?.delete(fn);
  }) as OideBridge['on'],
  platform: 'win32',
};
const emit = (event: string, payload: unknown) =>
  act(() => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  });

const agent = (id: string, status: AgentSummary['status'], extra: Partial<AgentSummary> = {}) =>
  AgentSummary.parse({ id, projectId: 'oide', title: 'Retrieve Pricing calculator from claude.ai', status, mode: 'default', model: 'sonnet', createdAt: now, updatedAt: now, ...extra });

beforeEach(() => {
  listeners = new Map();
  installFallbackBridge(bridge);
  invoke.mockClear();
  useProjects.setState({
    list: ['oide', 'billing-api'].map((id) => Project.parse({ id, name: id, path: `/code/${id}`, trusted: true, createdAt: now })),
    loaded: true,
  });
  useScope.setState({ scope: 'all' });
  useRouter.setState({ route: { screen: 'artifacts', params: {} }, back: [], forward: [] });
  useAgents.setState({ byId: {}, order: [], loaded: true });
  useUi.setState({ toasts: [] });
  useArtifactDrafts.getState().reset();
  // The header's actions slot (the search field renders there).
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  useUi.getState().setHeaderSlot('actions', slot);
});

afterEach(() => {
  cleanup();
  useUi.getState().setHeaderSlot('actions', null);
  document.body.innerHTML = '';
  delete (window as { oide?: unknown }).oide;
});

const grid = () => screen.getByRole('tabpanel', { name: 'Artifacts' });
const cardTitles = () => within(grid()).getAllByRole('button').map((b) => b.querySelector('span')?.textContent);
const cardOf = async (title: RegExp) => (await screen.findAllByRole('button', { name: title })).find((b) => grid().contains(b))!;
const dropOn = (target: Element, files: File[]) => fireEvent.drop(target, { dataTransfer: { types: ['Files'], files } });

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

  it('has one way to create an artifact in the toolbar', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'Main window v2', level: 2 });
    expect(screen.queryByRole('button', { name: 'Import from claude.ai' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ New artifact' }));
    expect(await screen.findByRole('dialog', { name: 'New artifact' })).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: 'Update from claude.ai' })).toBeNull();
    await waitFor(() => expect(document.querySelector('.oide-md h1')?.textContent).toBe('Retry'));
    expect(document.querySelector('.oide-md script')).toBeNull();
  });
});

describe('New artifact dialog', () => {
  const projects = ['oide', 'billing-api'].map((id) => Project.parse({ id, name: id, path: `/code/${id}`, trusted: true, createdAt: now }));
  const url = 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T';
  const linked = meta('a-link', 'claude.ai artifact', 'design', 'oide', { version: 0, importedFrom: url, location: 'app-data', retrieval: { status: 'retrieving', trigger: 'import', startedAt: now } });
  const fromFiles = meta('a-files', 'site', 'design', 'oide', { fileCount: 3 });
  const blank = meta('a-blank', 'Checkout flow', 'whiteboard', 'oide');
  const picked = ['C:\\Downloads\\site\\index.html', 'C:\\Downloads\\site\\pricing.html', 'C:\\Downloads\\site\\site.css'];
  const base = invoke.getMockImplementation()!;
  afterEach(() => invoke.mockImplementation(base));

  const repo = () => screen.getByRole('radio', { name: /In the project's repo/ }) as HTMLInputElement;
  const personal = () => screen.getByRole('radio', { name: /Personal/ }) as HTMLInputElement;
  const startFrom = (name: 'A link' | 'Files' | 'Blank') => fireEvent.click(screen.getByRole('radio', { name }));
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
  const linkField = () => screen.getByRole('textbox', { name: 'Link' }) as HTMLInputElement;
  /** The primary button is disabled with its reason as its description. */
  const expectReason = (name: string, reason: string) => {
    expect(button(name).disabled).toBe(true);
    expect(button(name).getAttribute('aria-describedby')).toBe(screen.getByText(reason).id);
  };

  async function open(props: { defaultProjectId?: string; projects?: Project[] } = { defaultProjectId: 'oide' }) {
    const { NewArtifactDialog } = await import('./Dialogs');
    const onCreated = vi.fn();
    invoke.mockImplementation(async (command: string, input: unknown) => {
      switch (command) {
        case 'artifacts.importLink':
          return linked;
        case 'artifacts.importFiles':
          return fromFiles;
        case 'artifacts.writeFiles':
          return { ...fromFiles, version: 2, fileCount: 4 };
        case 'artifacts.create':
          return blank;
        case 'dialog.pickArtifactFiles':
          return (input as { folder: boolean }).folder ? ['C:\\Downloads\\site'] : picked;
        default:
          throw new Error(`[not_implemented] ${command}`);
      }
    });
    const utils = render(<NewArtifactDialog open onClose={() => {}} projects={props.projects ?? projects} defaultProjectId={props.defaultProjectId} onCreated={onCreated} />);
    return { onCreated, ...utils };
  }

  it('offers one "Start from" choice as a radio group with arrow keys', async () => {
    await open();
    const group = screen.getByRole('radiogroup', { name: 'Start from' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['A link', 'Files', 'Blank']);
    expect(within(group).getByRole('radio', { name: 'A link' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(within(group).getByRole('radio', { name: 'Files' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Files' }));
    expect(button('Choose files…')).toBeTruthy();
  });

  it('A link: checks the link live and starts an agent in the project, with no paste box or steps', async () => {
    const { onCreated } = await open();
    await waitFor(() => expect(document.activeElement).toBe(linkField()));
    expectReason('Retrieve', 'Paste a claude.ai link first.');
    expect(screen.getByText(/An agent opens the link with your Claude Code CLI and copies its files here/)).toBeTruthy();
    expect(screen.getByText('The agent runs in this project.')).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    expect(screen.queryByRole('textbox', { name: /content|code/i })).toBeNull();

    fireEvent.change(linkField(), { target: { value: 'https://claude.ai/chat/0b6c3f2a-1111-4222-8333-444455556666' } });
    expect(screen.getByRole('alert').textContent).toMatch(/chat link, not an artifact link/);
    expect(linkField().getAttribute('aria-invalid')).toBe('true');
    expectReason('Retrieve', 'Fix the link first.');

    fireEvent.change(linkField(), { target: { value: `  ${url}  ` } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('Retrieve').disabled).toBe(false);
    fireEvent.click(button('Retrieve'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(linked));
    expect(invoke).toHaveBeenCalledWith('artifacts.importLink', { url, projectId: 'oide', location: 'app-data' });
    expect(useUi.getState().toasts.map((t) => t.message)).toContain('Retrieving claude.ai artifact with an agent. You can follow it on the Wall.');
  });

  it('A link: refuses other hosts, needs a project, and sends a chosen title and kind', async () => {
    const { onCreated } = await open({ defaultProjectId: undefined });
    fireEvent.change(linkField(), { target: { value: 'https://example.com/a' } });
    expect(screen.getByRole('alert').textContent).toBe('Only https links on claude.ai can be imported.');
    fireEvent.change(linkField(), { target: { value: url } });
    expectReason('Retrieve', 'Choose the project the agent runs in.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'billing-api' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title (optional)' }), { target: { value: 'Pricing' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'doc' } });
    fireEvent.click(repo());
    fireEvent.click(button('Retrieve'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('artifacts.importLink', { url, title: 'Pricing', kind: 'doc', projectId: 'billing-api', location: 'repo' });
  });

  it('A link: says to add a project when there is none', async () => {
    await open({ defaultProjectId: undefined, projects: [] });
    fireEvent.change(linkField(), { target: { value: url } });
    expectReason('Retrieve', 'Add a project first: the agent runs in one.');
  });

  it('Files: picks files, lists them, asks which page it opens on, and imports them with the link', async () => {
    const { onCreated } = await open();
    startFrom('Files');
    expectReason('Create', 'Choose or drop files first.');
    fireEvent.click(button('Choose files…'));
    expect(await screen.findByText('3 files')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('dialog.pickArtifactFiles', { folder: false });
    const files = screen.getByRole('list', { name: '3 files' });
    expect(within(files).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['index.html', 'pricing.html', 'site.css']);
    expect((screen.getByRole('combobox', { name: 'Kind' }) as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Detect (Design)');
    const opensOn = screen.getByRole('combobox', { name: 'Opens on' }) as HTMLSelectElement;
    expect(opensOn.value).toBe('index.html');
    fireEvent.change(opensOn, { target: { value: 'pricing.html' } });

    fireEvent.click(within(files).getByRole('button', { name: 'Remove site.css' }));
    expect(screen.getByText('2 files')).toBeTruthy();
    const cameFrom = screen.getByRole('textbox', { name: 'Came from (optional)' });
    fireEvent.change(cameFrom, { target: { value: 'https://claude.ai/chat/0b6c3f2a-1111-4222-8333-444455556666' } });
    expectReason('Create', 'Fix the link it came from, or clear it.');
    fireEvent.change(cameFrom, { target: { value: url } });
    fireEvent.click(button('Create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(fromFiles));
    expect(invoke).toHaveBeenCalledWith('artifacts.importFiles', { filePaths: picked.slice(0, 2), entry: 'pricing.html', url, projectId: 'oide', location: 'app-data' });
  });

  it('Files: imports a whole folder', async () => {
    const { onCreated } = await open();
    startFrom('Files');
    fireEvent.click(button('Choose a folder…'));
    expect(await screen.findByText('A folder: every file in it, keeping its subfolders.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Opens on' })).toBeNull();
    fireEvent.click(button('Create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('artifacts.importFiles', { filePaths: [], folderPath: 'C:\\Downloads\\site', projectId: 'oide', location: 'app-data' });
  });

  it('Files: takes several dropped files and adds dropped images after the import', async () => {
    const attachDropped = vi.fn(async () => ({
      attachments: [
        { kind: 'file' as const, path: 'C:\\Downloads\\index.html', name: 'index.html', size: 120 },
        { kind: 'image' as const, mediaType: 'image/png' as const, dataBase64: 'iVBORw0K', name: 'hero.png' },
      ],
      rejected: [{ name: 'shots', reason: 'Folders cannot be attached. Attach the files inside it.' }],
    }));
    const { onCreated } = await open();
    (window as { oide?: unknown }).oide = { ...bridge, attachDropped };
    // A drop on the link choice switches to Files.
    dropOn(linkField().closest('form')!, [new File(['x'], 'index.html'), new File(['y'], 'hero.png'), new File([''], 'shots')]);
    expect(await screen.findByText('2 files')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Files' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe("shots: folders can't be dropped. Use Choose a folder… instead.");
    fireEvent.click(button('Create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ ...fromFiles, version: 2, fileCount: 4 }));
    expect(invoke).toHaveBeenCalledWith('artifacts.importFiles', { filePaths: ['C:\\Downloads\\index.html'], projectId: 'oide', location: 'app-data' });
    expect(invoke).toHaveBeenCalledWith('artifacts.writeFiles', { id: 'a-files', files: [{ path: 'hero.png', encoding: 'base64', data: 'iVBORw0K' }], baseVersion: 1, note: 'Added the dropped images' });
  });

  it('Files: dropped images alone need another file, and the dev build says to use Choose files', async () => {
    const attachDropped = vi.fn(async () => ({ attachments: [{ kind: 'image' as const, mediaType: 'image/png' as const, dataBase64: 'AAAA', name: 'a.png' }], rejected: [] }));
    await open();
    startFrom('Files');
    const zone = button('Choose files…').closest('form')!;
    dropOn(zone, [new File(['x'], 'a.png')]);
    expect((await screen.findByRole('alert')).textContent).toBe('Dropping files needs the desktop app. Use Choose files… instead.');
    (window as { oide?: unknown }).oide = { ...bridge, attachDropped };
    dropOn(zone, [new File(['x'], 'a.png')]);
    expect(await screen.findByText('1 file')).toBeTruthy();
    expect(button('Create').disabled).toBe(true);
    expect(screen.getByText(/doesn't give oIDE an image's file path/)).toBeTruthy();
  });

  it('Blank: needs a title, takes a kind, and creates it in the repo by default', async () => {
    const { onCreated } = await open();
    startFrom('Blank');
    expectReason('Create', 'Give it a title first.');
    expect(repo().checked).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Checkout flow' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Whiteboard' }));
    fireEvent.click(button('Create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(blank));
    expect(invoke).toHaveBeenCalledWith('artifacts.create', { title: 'Checkout flow', kind: 'whiteboard', projectId: 'oide', location: 'repo' });
  });

  it('starts each use from the scope: a previous "Personal" choice does not carry over', async () => {
    const { NewArtifactDialog } = await import('./Dialogs');
    const props = { onClose: () => {}, projects, defaultProjectId: 'oide', onCreated: () => {} };
    const { rerender } = render(<NewArtifactDialog open {...props} />);
    startFrom('Blank');
    expect(repo().checked).toBe(true);
    fireEvent.click(personal());
    expect(personal().checked).toBe(true);
    rerender(<NewArtifactDialog open={false} {...props} />);
    rerender(<NewArtifactDialog open {...props} />);
    // The "Start from" choice is remembered; where it lives starts again from the default.
    await waitFor(() => expect(repo().checked).toBe(true));
    expect(screen.getByRole('radio', { name: 'Blank' }).getAttribute('aria-checked')).toBe('true');
  });

  it('defaults to the repo when a project is picked after "No project"', async () => {
    const { NewArtifactDialog } = await import('./Dialogs');
    render(<NewArtifactDialog open onClose={() => {}} projects={projects} onCreated={() => {}} />);
    startFrom('Blank');
    expect(personal().checked).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'billing-api' } });
    expect(repo().checked).toBe(true);
  });
});

describe('New artifact from files dropped on the grid', () => {
  const base = invoke.getMockImplementation()!;
  afterEach(() => invoke.mockImplementation(base));

  it('opens the dialog on Files with the dropped files chosen', async () => {
    const attachDropped = vi.fn(async () => ({
      attachments: [
        { kind: 'file' as const, path: '/Users/you/Downloads/pricing.html', name: 'pricing.html', size: 10 },
        { kind: 'file' as const, path: '/Users/you/Downloads/site.css', name: 'site.css', size: 10 },
      ],
      rejected: [],
    }));
    (window as { oide?: unknown }).oide = { ...bridge, attachDropped };
    const imported = meta('a-new', 'pricing', 'design', 'oide');
    invoke.mockImplementation(async (command: string, input: unknown) => (command === 'artifacts.importFiles' ? imported : base(command, input)));
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'Main window v2', level: 2 });
    dropOn(screen.getByRole('main'), [new File(['x'], 'pricing.html'), new File(['y'], 'site.css')]);
    // The dialog is a lazy chunk and the dropped files arrive after the bridge answers: wait for both,
    // with room for a loaded machine running the whole suite.
    const slow = { timeout: 5000 };
    const dialog = await screen.findByRole('dialog', { name: 'New artifact' }, slow);
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'Files' }).getAttribute('aria-checked')).toBe('true'), slow);
    expect(await within(dialog).findByText('2 files', {}, slow)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.importFiles', expect.objectContaining({ filePaths: ['/Users/you/Downloads/pricing.html', '/Users/you/Downloads/site.css'] })), slow);
    await waitFor(() => expect(useRouter.getState().route).toEqual({ screen: 'artifacts', params: { artifactId: 'a-new' } }), slow);
  });
});

describe('Retrieval by an agent', () => {
  const link = 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm';
  const reason = 'This Claude Code CLI has no tool that can read claude.ai artifact links.';
  const retrieving = meta('a-pending', 'Pricing calculator', 'design', 'oide', { version: 0, importedFrom: link, retrieval: { status: 'retrieving', agentId: 'ag-r', trigger: 'import', startedAt: now } });
  const failed = meta('a-failed', 'Old calculator', 'design', 'oide', { version: 0, importedFrom: link, retrieval: { status: 'failed', agentId: 'ag-old', trigger: 'import', startedAt: now - 60_000, finishedAt: now - 30_000, error: reason } });
  const site = meta('a-site', 'oIDE site', 'design', undefined, {
    version: 2,
    location: 'app-data',
    importedFrom: 'https://claude.ai/design/p/oide-site',
    retrieval: { status: 'ready', agentId: 'ag-site', trigger: 'update', startedAt: now - 7_300_000, finishedAt: now - 7_200_000, retrievedAt: now - 7_200_000 },
  });
  const base = invoke.getMockImplementation()!;
  let arts: ArtifactMeta[];
  let refreshError: string | null;

  beforeEach(() => {
    arts = [retrieving, failed, site];
    refreshError = null;
    useAgents.setState({ byId: { 'ag-r': agent('ag-r', 'running', { activity: ['Reading the link with the claude.ai tools…'] }) }, order: ['ag-r'], loaded: true });
    invoke.mockImplementation(async (command: string, input: unknown) => {
      const i = input as { id: string; projectId?: string };
      const find = () => arts.find((a) => a.id === i.id)!;
      switch (command) {
        case 'artifacts.list':
          return arts;
        case 'artifacts.uses':
          return {};
        case 'artifacts.get': {
          const m = find();
          return { meta: m, content: m.version ? '<p>site</p>' : '', uses: [], versions: m.version ? [{ version: m.version, ts: now, author: 'agent:ag-site' }] : [] };
        }
        case 'artifacts.refresh': {
          if (refreshError) {
            const e = refreshError;
            refreshError = null;
            throw new Error(e);
          }
          const m = { ...find(), retrieval: { status: 'retrieving' as const, agentId: 'ag-new', trigger: 'update' as const, startedAt: now } };
          arts = arts.map((a) => (a.id === m.id ? m : a));
          return m;
        }
        case 'artifacts.cancelRetrieval': {
          const m = { ...find(), retrieval: { ...find().retrieval!, status: 'failed' as const, error: 'Cancelled.' } };
          arts = arts.map((a) => (a.id === m.id ? m : a));
          return m;
        }
        default:
          return base(command, input);
      }
    });
  });
  afterEach(() => invoke.mockImplementation(base));

  const show = (id: string) => useRouter.setState({ route: { screen: 'artifacts', params: { artifactId: id } }, back: [], forward: [] });

  it('marks retrieving and failed cards with text, not colour alone', async () => {
    render(<ArtifactsScreen />);
    const pending = await cardOf(/Pricing calculator/);
    expect(within(pending).getByText('Retrieving with an agent')).toBeTruthy();
    const bad = await cardOf(/Old calculator/);
    expect(within(bad).getByText('Retrieval failed')).toBeTruthy();
    expect(within(bad).getByText('Retrieval failed').querySelector('svg')).toBeTruthy();
    // Version 0 cards show the kind thumbnail.
    expect(pending.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('while retrieving: the agent live status, Open agent and Cancel', async () => {
    show('a-pending');
    render(<ArtifactsScreen />);
    expect(await screen.findByRole('heading', { name: 'Retrieving from claude.ai', level: 3 })).toBeTruthy();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Retrieve Pricing calculator from claude.ai');
    expect(status.textContent).toContain('Running');
    expect(status.textContent).toContain('Reading the link with the claude.ai tools…');
    expect(screen.getByText(/The artifact fills in when it is done/)).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('No versions yet.')).toBeTruthy();

    // The agent waits behind Max running.
    act(() => useAgents.setState({ byId: { 'ag-r': agent('ag-r', 'queued') } }));
    expect(screen.getByRole('status').textContent).toMatch(/Waiting for a free slot/);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.cancelRetrieval', { id: 'a-pending' }));
    expect(await screen.findByRole('heading', { name: 'Retrieval failed' })).toBeTruthy();
    expect(screen.getByText('Cancelled.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open agent' }));
    expect(useRouter.getState().route).toEqual({ screen: 'focus', params: { agentId: 'ag-r' } });
  });

  it('after a failed retrieval: the reason, Retry, Open agent and Delete', async () => {
    show('a-failed');
    render(<ArtifactsScreen />);
    expect(await screen.findByRole('heading', { name: 'Retrieval failed', level: 3 })).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open agent' })).toBeTruthy();
    // No Update while the failed one waits for a Retry.
    expect(screen.queryByRole('button', { name: 'Update from claude.ai' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Old calculator?' });
    expect(confirm.textContent).toMatch(/It has no files yet/);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.refresh', { id: 'a-failed' }));
    expect(await screen.findByRole('heading', { name: 'Retrieving from claude.ai' })).toBeTruthy();
  });

  it('Update on a linked artifact: retrieved time, and a project asked for inline when it has none', async () => {
    show('a-site');
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'oIDE site', level: 2 });
    expect(screen.getByText(/^Retrieved 2h ago\./)).toBeTruthy();
    refreshError = '[needs_project] Pick a project for the retrieval agent to run in.';
    const update = screen.getByRole('button', { name: 'Update from claude.ai' });
    expect(update.textContent).toBe('Update');
    fireEvent.click(update);
    const select = await screen.findByRole('combobox', { name: 'Run the agent in' });
    fireEvent.change(select, { target: { value: 'billing-api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.refresh', { id: 'a-site', projectId: 'billing-api' }));
    // The current version stays on show while the new one is retrieved.
    expect(await screen.findByText(/You're seeing v2 until it's done/)).toBeTruthy();
    expect(document.querySelector('iframe')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Run the agent in' })).toBeNull();
  });

  it('says so when a retrieval is already running', async () => {
    show('a-site');
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'oIDE site', level: 2 });
    refreshError = '[busy] Retrieving already';
    fireEvent.click(screen.getByRole('button', { name: 'Update from claude.ai' }));
    expect((await screen.findByRole('alert')).textContent).toBe('An agent is already retrieving it.');
  });

  it('reloads on artifacts.changed with change "retrieval"', async () => {
    show('a-pending');
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'Retrieving from claude.ai' });
    arts = arts.map((a) => (a.id === 'a-pending' ? { ...a, retrieval: { ...a.retrieval!, status: 'failed' as const, error: reason } } : a));
    emit('artifacts.changed', { id: 'a-pending', change: 'retrieval', version: 0 });
    expect(await screen.findByRole('heading', { name: 'Retrieval failed', level: 3 })).toBeTruthy();
    expect(within(await cardOf(/Pricing calculator/)).getByText('Retrieval failed')).toBeTruthy();
  });

  it('shows the retrieval status in place of the editors when opened with no files', async () => {
    show('a-pending');
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'Retrieving from claude.ai' });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const viewer = await screen.findByRole('region', { name: 'Pricing calculator (open)' });
    expect(within(viewer).getByRole('heading', { name: 'Retrieving from claude.ai' })).toBeTruthy();
    expect(within(viewer).getByText(/no files yet/)).toBeTruthy();
    expect(within(viewer).queryByRole('radiogroup', { name: 'View' })).toBeNull();
    expect(within(viewer).queryByRole('complementary', { name: 'Agent' })).toBeNull();
    expect(within(viewer).queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('Broken imports', () => {
  const link = 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T';
  const broken = meta('a-broken', 'Pricing page', 'doc', 'oide', { importedFrom: link, brokenImport: true });
  const stub = `Imported from ${link}. oIDE cannot fetch claude.ai artifacts: open the link, copy the artifact's code and paste it here to keep a local copy.\n`;
  const base = invoke.getMockImplementation()!;
  let current = broken;

  beforeEach(() => {
    current = broken;
    invoke.mockImplementation(async (command: string, input: unknown) => {
      switch (command) {
        case 'artifacts.list':
          return [current, ...list];
        case 'artifacts.get':
          if ((input as { id: string }).id === 'a-broken') return { meta: current, content: stub, uses: [], versions: [{ version: 1, ts: now, author: 'user' }] };
          return base(command, input);
        case 'artifacts.refresh':
          current = { ...current, retrieval: { status: 'retrieving', agentId: 'ag-r', trigger: 'import', startedAt: now } };
          return current;
        case 'artifacts.importFiles':
          return meta('a-fixed', 'Pricing page', 'design', 'oide', { importedFrom: link });
        case 'artifacts.delete':
          return { ok: true };
        case 'dialog.pickArtifactFiles':
          return ['C:\\Downloads\\pricing.html', 'C:\\Downloads\\site.css'];
        default:
          return base(command, input);
      }
    });
    useRouter.setState({ route: { screen: 'artifacts', params: { artifactId: 'a-broken' } }, back: [], forward: [] });
  });
  afterEach(() => invoke.mockImplementation(base));

  it('marks the card with a badge (text and icon) and offers an agent, files or Delete, no paste box', async () => {
    render(<ArtifactsScreen />);
    const card = await cardOf(/Pricing page/);
    expect(within(card).getByText('Import has no content')).toBeTruthy();
    expect(card.querySelector('svg')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'This import has no content', level: 3 })).toBeTruthy();
    expect(screen.getByText(/An older oIDE saved only the link/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retrieve with an agent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose files…' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('textbox', { name: /Paste/ })).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('Retrieve with an agent starts a retrieval and shows it in place of the panel', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve with an agent' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.refresh', { id: 'a-broken' }));
    expect(await screen.findByRole('heading', { name: 'Retrieving from claude.ai' })).toBeTruthy();
  });

  it('imports chosen files as a new artifact with the link, then deletes the empty one', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose files…' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.delete', { id: 'a-broken' }));
    expect(invoke).toHaveBeenCalledWith('dialog.pickArtifactFiles', { folder: false });
    expect(invoke).toHaveBeenCalledWith('artifacts.importFiles', { filePaths: ['C:\\Downloads\\pricing.html', 'C:\\Downloads\\site.css'], url: link, title: 'Pricing page', projectId: 'oide', location: 'repo' });
    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order.indexOf('artifacts.importFiles')).toBeLessThan(order.indexOf('artifacts.delete'));
    await waitFor(() => expect(useRouter.getState().route).toEqual({ screen: 'artifacts', params: { artifactId: 'a-fixed' } }));
  });

  it('keeps the empty import when it changed while the files were being imported (an agent wrote it)', async () => {
    const real = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, input: unknown) => {
      if (command === 'artifacts.importFiles') {
        current = meta('a-broken', 'Pricing page', 'doc', 'oide', { importedFrom: link, version: 2 });
        return meta('a-fixed', 'Pricing page', 'design', 'oide', { importedFrom: link });
      }
      if (command === 'artifacts.get' && (input as { id: string }).id === 'a-broken') return { meta: current, content: '# Real', uses: [], versions: [] };
      return real(command, input);
    });
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose files…' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.importFiles', expect.objectContaining({ title: 'Pricing page' })));
    await waitFor(() => expect(invoke.mock.calls.filter((c) => c[0] === 'artifacts.get' && (c[1] as { id: string }).id === 'a-broken').length).toBeGreaterThan(1));
    expect(invoke).not.toHaveBeenCalledWith('artifacts.delete', expect.anything());
  });

  it('an old chat link is neither retrieved nor carried over to the replacement', async () => {
    const chat = 'https://claude.ai/chat/0f8fad5b-d9cb-469f-a165-70867728950e';
    current = meta('a-broken', 'Pricing page', 'doc', 'oide', { importedFrom: chat, brokenImport: true });
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    expect(screen.queryByRole('button', { name: 'Retrieve with an agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose files…' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.importFiles', { filePaths: ['C:\\Downloads\\pricing.html', 'C:\\Downloads\\site.css'], title: 'Pricing page', projectId: 'oide', location: 'repo' }));
  });

  it('opens the panel in the viewer with its first action focused', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Pricing page (open)' })).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retrieve with an agent' }));
    expect(screen.queryByRole('radio', { name: 'Preview' })).toBeNull();
  });
});

describe('React designs', () => {
  const base = invoke.getMockImplementation()!;
  const react = "import React from 'react';\nexport default function App() {\n  return <main>Hi</main>;\n}\n";
  const design = meta('a-react', 'Pricing app', 'design', 'oide', { entry: 'App.jsx', version: 2 });
  afterEach(() => invoke.mockImplementation(base));

  it('previews the saved version by URL and shows a notice instead of old React source', async () => {
    invoke.mockImplementation(async (command: string, input: unknown) => {
      switch (command) {
        case 'artifacts.list':
          return [design];
        case 'artifacts.get':
          return { meta: design, content: react, uses: [], versions: [{ version: 2, ts: now, author: 'user' }, { version: 1, ts: now - 1000, author: 'user' }] };
        case 'artifacts.previewUrl':
          return { url: 'oide-artifact://a-react/index.html' };
        case 'artifacts.readVersion':
          return { content: `${react}// v1` };
        default:
          return base(command, input);
      }
    });
    useRouter.setState({ route: { screen: 'artifacts', params: { artifactId: 'a-react' } }, back: [], forward: [] });
    render(<ArtifactsScreen />);
    await waitFor(() => expect(document.querySelector('iframe')?.getAttribute('src')).toBe('oide-artifact://a-react/index.html'));
    fireEvent.click(screen.getByRole('button', { name: /^v1 ·/ }));
    expect(await screen.findByText('Only the saved version of a React design can be previewed. Save your changes, or use Compare to see older versions.')).toBeTruthy();
    // React source never goes into srcdoc.
    expect(document.querySelector('iframe[srcdoc]')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('draft store subscription', () => {
  it('a screen watching the draft ids does not re-render on each keystroke', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useArtifactDrafts(draftIdsKey);
    });
    const d = { baseVersion: 1, baseContent: 'a', baseline: 'a', entry: 'x', draft: 'a1' };
    act(() => useArtifactDrafts.getState().set('a-doc', d));
    const afterFirst = renders;
    act(() => useArtifactDrafts.getState().set('a-doc', { ...d, draft: 'a12' }));
    act(() => useArtifactDrafts.getState().set('a-doc', { ...d, draft: 'a123' }));
    expect(renders).toBe(afterFirst);
    act(() => useArtifactDrafts.getState().set('a-board', d));
    expect(renders).toBe(afterFirst + 1);
  });
});
