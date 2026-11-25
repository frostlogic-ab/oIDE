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
  const REACT_APP = "import React from 'react';\nexport default function App() {\n  return <main>Hi</main>;\n}\n";
  afterEach(() => {
    invoke.mockImplementation(base);
    delete (window as { oide?: unknown }).oide;
  });

  async function open() {
    const { ImportDialog } = await import('./Dialogs');
    const onImported = vi.fn();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'artifacts.import') return imported;
      if (command === 'shell.openExternal') return { ok: true };
      if (command === 'dialog.pickFile') return 'C:\\Downloads\\pricing.html';
      throw new Error(`[not_implemented] ${command}`);
    });
    render(<ImportDialog open onClose={() => {}} projects={projects} defaultProjectId="oide" onImported={onImported} />);
    return { onImported };
  }
  const kind = () => (screen.getByRole('combobox', { name: 'Kind' }) as HTMLSelectElement).value;
  const content = () => screen.getByRole('textbox', { name: 'Artifact content' });
  const linkField = () => screen.getByRole('textbox', { name: 'claude.ai link' });
  const importButton = () => screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement;
  const dropTarget = () => screen.getByRole('tablist', { name: 'How to import' }).parentElement!;
  const dropFile = (target: Element, file: File) => fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [file] } });

  it('sends the pasted content with the link, the kind following the content', async () => {
    const { onImported } = await open();
    fireEvent.change(linkField(), { target: { value: url } });
    const page = '<!doctype html><html><body><h1>Checkout</h1></body></html>';
    fireEvent.change(content(), { target: { value: page } });
    expect(kind()).toBe('design');
    fireEvent.click(importButton());
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(imported));
    expect(invoke).toHaveBeenCalledWith('artifacts.import', { url, content: page, title: undefined, kind: 'design', projectId: 'oide', location: 'app-data' });
  });

  it('keeps Import disabled until there is content, and says why', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Import link only' })).toBeNull();
    fireEvent.change(linkField(), { target: { value: url } });
    expect(importButton().disabled).toBe(true);
    const reason = "Paste the artifact's code first. oIDE can't download claude.ai artifacts, even public ones.";
    expect(screen.getByText(reason)).toBeTruthy();
    expect(importButton().getAttribute('aria-describedby')).toBe(screen.getByText(reason).id);
    fireEvent.click(importButton());
    expect(invoke).not.toHaveBeenCalledWith('artifacts.import', expect.anything());
    fireEvent.change(content(), { target: { value: '# Notes' } });
    expect(importButton().disabled).toBe(false);
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('opens the link in the browser and shows the three steps', async () => {
    await open();
    fireEvent.change(linkField(), { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Open the link on claude.ai' }));
    expect(invoke).toHaveBeenCalledWith('shell.openExternal', { url });
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual(['Open the link.', 'On claude.ai, use Copy (or Download).', 'Paste the code here, or drop the downloaded file.']);
  });

  it('accepts React source as a design, and keeps a kind the user picked', async () => {
    const { onImported } = await open();
    fireEvent.change(linkField(), { target: { value: url } });
    fireEvent.change(content(), { target: { value: REACT_APP } });
    expect(kind()).toBe('design');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(importButton());
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('artifacts.import', { url, content: REACT_APP, title: undefined, kind: 'design', projectId: 'oide', location: 'app-data' });
  });

  it('refuses plain text as a design and the old placeholder as anything, before sending', async () => {
    await open();
    fireEvent.change(linkField(), { target: { value: url } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'design' } });
    fireEvent.change(content(), { target: { value: 'just some words' } });
    expect(kind()).toBe('design'); // the user's pick wins over the content
    expect(screen.getByRole('alert').textContent).toMatch(/HTML page or a React component/);
    expect(importButton().disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'doc' } });
    fireEvent.change(content(), { target: { value: "Imported from https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T. oIDE cannot fetch claude.ai artifacts: open the link, copy the artifact's code and paste it here to keep a local copy." } });
    expect(screen.getByRole('alert').textContent).toMatch(/placeholder/);
    expect(importButton().disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('artifacts.import', expect.anything());
  });

  it('says why a chat link is not an artifact link, on the field', async () => {
    await open();
    fireEvent.change(linkField(), { target: { value: 'https://claude.ai/chat/0b6c3f2a-1111-4222-8333-444455556666' } });
    expect(screen.getByRole('alert').textContent).toMatch(/chat link, not an artifact link/);
    expect(linkField().getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(content(), { target: { value: '# Notes' } });
    expect(importButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Fetch with an agent' })).toBeNull();
  });

  it('refuses links that are not https claude.ai', async () => {
    await open();
    fireEvent.change(linkField(), { target: { value: 'https://example.com/a' } });
    expect(screen.getByRole('alert').textContent).toBe('Only https links on claude.ai can be imported.');
    fireEvent.change(content(), { target: { value: '# Notes' } });
    expect(importButton().disabled).toBe(true);
  });

  it('Fetch with an agent opens Spawn with a goal that only creates real content', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Fetch with an agent' })).toBeNull();
    fireEvent.change(linkField(), { target: { value: url } });
    expect(screen.getByText(/Chat artifacts can't be fetched, even public ones/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fetch with an agent' }));
    const { route } = useRouter.getState();
    expect(route.screen).toBe('spawn');
    const params = route.params as { projectId?: string; goal?: string };
    expect(params.projectId).toBe('oide');
    expect(params.goal).toContain('https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T');
    expect(params.goal).toContain('artifacts_create');
    expect(params.goal).toContain('titled "Imported from claude.ai"');
    expect(params.goal).toContain('create nothing');
    expect(invoke).not.toHaveBeenCalledWith('artifacts.import', expect.anything());
  });

  it('keeps the paste and a picked kind across tabs; Pick a file sends the optional link', async () => {
    const { onImported } = await open();
    fireEvent.change(linkField(), { target: { value: url } });
    fireEvent.change(content(), { target: { value: '# Notes' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'whiteboard' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Pick a file' }));
    expect(kind()).toBe('whiteboard');
    expect(importButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a file…' }));
    expect(await screen.findByText('C:\\Downloads\\pricing.html')).toBeTruthy();
    expect(kind()).toBe('whiteboard'); // the user's pick wins over the file name
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'design' } });
    fireEvent.click(importButton());
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('artifacts.import', { filePath: 'C:\\Downloads\\pricing.html', url, title: undefined, kind: 'design', projectId: 'oide', location: 'app-data' });
    expect(invoke).toHaveBeenCalledWith('dialog.pickFile', { title: 'Import an artifact', filters: [{ name: 'Artifacts', extensions: expect.arrayContaining(['html', 'jsx', 'tsx', 'svg']) }] });
  });

  it('keeps the instructions visible when content is refused, and only opens claude.ai links', async () => {
    await open();
    fireEvent.change(linkField(), { target: { value: 'https://claude.site/artifacts/MyEmjmATV3mpUv6SZmFj4T' } });
    expect((screen.getByRole('button', { name: 'Open the link on claude.ai' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'whiteboard' } });
    fireEvent.change(content(), { target: { value: 'not json' } });
    expect(screen.getByRole('alert').textContent).toMatch(/JSON/);
    expect(screen.getByText('Paste the code here, or drop the downloaded file.')).toBeTruthy();
    expect(content().getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(content(), { target: { value: '\uFEFF{"type":"excalidraw","elements":[]}' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('imports a file dropped on the dialog through the preload drop bridge, by path', async () => {
    const attachDropped = vi.fn(async () => ({ attachments: [{ kind: 'file' as const, path: 'C:\\Downloads\\App.jsx', name: 'App.jsx', size: 120 }], rejected: [] }));
    const { onImported } = await open();
    (window as { oide?: unknown }).oide = { ...bridge, attachDropped };
    fireEvent.change(linkField(), { target: { value: url } });
    dropFile(dropTarget(), new File(['x'], 'App.jsx'));
    expect(await screen.findByText('C:\\Downloads\\App.jsx')).toBeTruthy();
    expect(attachDropped).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: 'Pick a file', selected: true })).toBeTruthy();
    expect(kind()).toBe('design');
    fireEvent.click(importButton());
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('artifacts.import', { filePath: 'C:\\Downloads\\App.jsx', url, title: undefined, kind: 'design', projectId: 'oide', location: 'app-data' });
  });

  it('says so when a dropped file has no path (an image) or several files are dropped', async () => {
    const attachDropped = vi.fn(async () => ({ attachments: [{ kind: 'image' as const, mediaType: 'image/png' as const, dataBase64: 'AAAA', name: 'a.png' }], rejected: [] }));
    await open();
    (window as { oide?: unknown }).oide = { ...bridge, attachDropped };
    dropFile(dropTarget(), new File(['x'], 'a.png'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Images can't be imported/);
    fireEvent.drop(dropTarget(), { dataTransfer: { types: ['Files'], files: [new File(['x'], 'a.html'), new File(['y'], 'b.html')] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Drop one file at a time.'));
    expect(importButton().disabled).toBe(true);
  });
});

describe('Import from claude.ai on the grid', () => {
  const base = invoke.getMockImplementation()!;
  afterEach(() => {
    invoke.mockImplementation(base);
    delete (window as { oide?: unknown }).oide;
  });

  it('opens the dialog on the file tab with a file dropped on the grid', async () => {
    const attachDropped = vi.fn(async () => ({ attachments: [{ kind: 'file' as const, path: '/Users/you/Downloads/pricing.html', name: 'pricing.html', size: 10 }], rejected: [] }));
    (window as { oide?: unknown }).oide = { ...bridge, attachDropped };
    const imported = meta('a-new', 'pricing', 'design', 'oide');
    invoke.mockImplementation(async (command: string, input: unknown) => (command === 'artifacts.import' ? imported : base(command, input)));
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'Main window v2', level: 2 });
    fireEvent.drop(screen.getByRole('main'), { dataTransfer: { types: ['Files'], files: [new File(['x'], 'pricing.html')] } });
    expect(await screen.findByText('/Users/you/Downloads/pricing.html')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Pick a file', selected: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.import', expect.objectContaining({ filePath: '/Users/you/Downloads/pricing.html', kind: 'design' })));
  });
});

describe('Broken imports', () => {
  const link = 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T';
  const broken = meta('a-broken', 'Pricing page', 'doc', 'oide', { importedFrom: link, brokenImport: true });
  const stub = `Imported from ${link}. oIDE cannot fetch claude.ai artifacts: open the link, copy the artifact's code and paste it here to keep a local copy.\n`;
  const base = invoke.getMockImplementation()!;
  const paste = () => screen.getByRole('textbox', { name: "Paste the artifact's code" });
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
        case 'artifacts.save': {
          const i = input as { id: string; content: string };
          current = meta('a-broken', 'Pricing page', 'doc', 'oide', { importedFrom: link, version: 2 });
          return { ...current, id: i.id };
        }
        case 'artifacts.import':
          return meta('a-fixed', 'Pricing page', 'design', 'oide', { importedFrom: link });
        case 'artifacts.delete':
          return { ok: true };
        case 'dialog.pickFile':
          return 'C:\\Downloads\\pricing.html';
        default:
          return base(command, input);
      }
    });
    useRouter.setState({ route: { screen: 'artifacts', params: { artifactId: 'a-broken' } }, back: [], forward: [] });
  });
  afterEach(() => {
    invoke.mockImplementation(base);
    delete (window as { oide?: unknown }).oide;
  });

  it('marks the card with a badge (text and icon) and shows the fix panel in the detail pane', async () => {
    render(<ArtifactsScreen />);
    const card = (await screen.findAllByRole('button', { name: /Pricing page/ })).find((b) => grid().contains(b))!;
    expect(within(card).getByText('Import has no content')).toBeTruthy();
    expect(card.querySelector('svg')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'This import has no content', level: 3 })).toBeTruthy();
    expect(screen.getByText("oIDE can't download claude.ai artifacts, so the link came in without the design.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open on claude.ai' })).toBeTruthy();
    expect(screen.getByText(/Replaces this empty import with the file/)).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('saves pasted code as the next version of the import', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(paste(), { target: { value: '# Pricing\n\nTiers and limits.' } });
    fireEvent.click(save);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.save', { id: 'a-broken', content: '# Pricing\n\nTiers and limits.', note: 'Imported from claude.ai', baseVersion: 1 }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'This import has no content' })).toBeNull());
  });

  it('refuses the old placeholder as pasted code', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.change(paste(), { target: { value: stub } });
    expect(screen.getByRole('alert').textContent).toMatch(/placeholder/);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('replaces the empty import with a new design when the paste does not fit a doc', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    const react = "import React from 'react';\nexport default function App() {\n  return <main>Hi</main>;\n}\n";
    fireEvent.change(paste(), { target: { value: react } });
    expect(screen.getByText(/This looks like a design, so Save replaces this import with a new one/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.delete', { id: 'a-broken' }));
    expect(invoke).toHaveBeenCalledWith('artifacts.import', { content: react, url: link, title: 'Pricing page', projectId: 'oide', location: 'repo' });
    expect(invoke).not.toHaveBeenCalledWith('artifacts.save', expect.anything());
    await waitFor(() => expect(useRouter.getState().route).toEqual({ screen: 'artifacts', params: { artifactId: 'a-fixed' } }));
  });

  it('imports a chosen or dropped file as a new artifact, then deletes the empty one', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose downloaded file…' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.delete', { id: 'a-broken' }));
    expect(invoke).toHaveBeenCalledWith('artifacts.import', { filePath: 'C:\\Downloads\\pricing.html', url: link, title: 'Pricing page', projectId: 'oide', location: 'repo' });
    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order.indexOf('artifacts.import')).toBeLessThan(order.indexOf('artifacts.delete'));
  });

  it('keeps the empty import when it changed while the file was being imported (an agent wrote it)', async () => {
    const real = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, input: unknown) => {
      if (command === 'artifacts.import') {
        current = meta('a-broken', 'Pricing page', 'doc', 'oide', { importedFrom: link, version: 2 });
        return meta('a-fixed', 'Pricing page', 'design', 'oide', { importedFrom: link });
      }
      if (command === 'artifacts.get' && (input as { id: string }).id === 'a-broken') return { meta: current, content: '# Real', uses: [], versions: [] };
      return real(command, input);
    });
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose downloaded file…' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.import', expect.objectContaining({ filePath: 'C:\\Downloads\\pricing.html' })));
    await waitFor(() => expect(invoke.mock.calls.filter((c) => c[0] === 'artifacts.get' && (c[1] as { id: string }).id === 'a-broken').length).toBeGreaterThan(1));
    expect(invoke).not.toHaveBeenCalledWith('artifacts.delete', expect.anything());
  });

  it('does not carry an old chat link (refused by the import now) over to the replacement', async () => {
    const chat = 'https://claude.ai/chat/0f8fad5b-d9cb-469f-a165-70867728950e';
    current = meta('a-broken', 'Pricing page', 'doc', 'oide', { importedFrom: chat, brokenImport: true });
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose downloaded file…' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('artifacts.import', { filePath: 'C:\\Downloads\\pricing.html', title: 'Pricing page', projectId: 'oide', location: 'repo' }));
  });

  it('opens the fix panel in the viewer with the paste box focused', async () => {
    render(<ArtifactsScreen />);
    await screen.findByRole('heading', { name: 'This import has no content' });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Pricing page (open)' })).toBeTruthy());
    expect(document.activeElement).toBe(paste());
    expect(screen.queryByRole('tab', { name: 'Preview' })).toBeNull();
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
