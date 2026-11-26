// @vitest-environment jsdom
/**
 * Artifact editors (Viewer.tsx): doc editing with live preview and save as a new version, agent
 * updates while open ("Updated by …" vs the conflict banner), whiteboard dirty tracking, version
 * compare, rename and delete; artifacts of several files (Files panel, editing another file with
 * `artifacts.writeFiles`, images, "Open on this page") and a first retrieval landing while open. Monaco, Excalidraw and the diff editor are replaced with light stubs
 * (jsdom has no canvas or layout); the Viewer's own logic runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  AgentSummary,
  ArtifactMeta,
  Project,
  type ArtifactFileContent,
  type ArtifactVersion,
  type EventName,
  type OideBridge,
} from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useUi } from '../../stores/ui';
import { useArtifactDrafts } from './draftStore';
import ArtifactsScreen from './index';

vi.mock('./SourceEditor', () => ({
  default: (p: { value: string; label: string; onChange: (v: string) => void; onSave: () => void }) => (
    <textarea
      aria-label={p.label}
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 's') p.onSave();
      }}
    />
  ),
}));

vi.mock('./WhiteboardEditor', () => ({
  default: (p: {
    content: string;
    onChange: (json: string, initial: boolean) => void;
    onSave: () => void;
  }) => (
    <div data-testid="whiteboard">
      <span data-testid="whiteboard-loaded">{p.content}</span>
      <button type="button" onClick={() => p.onChange(normalised(p.content), true)}>
        stub: loaded
      </button>
      <button
        type="button"
        onClick={() => p.onChange(JSON.stringify({ type: 'excalidraw', elements: [{ id: 'new' }] }), false)}
      >
        stub: draw
      </button>
    </div>
  ),
}));

vi.mock('./VersionDiff', () => ({
  default: (p: { original: string; modified: string; label: string }) => (
    <div data-testid="diff" aria-label={p.label}>
      <pre data-testid="diff-original">{p.original}</pre>
      <pre data-testid="diff-modified">{p.modified}</pre>
    </div>
  ),
}));

/** What Excalidraw's serialiser would produce for the loaded scene (stub: compact JSON). */
function normalised(content: string): string {
  return JSON.stringify(JSON.parse(content));
}

const now = Date.now();
const meta = (id: string, title: string, kind: ArtifactMeta['kind'], version = 1, extra: Partial<ArtifactMeta> = {}) =>
  ArtifactMeta.parse({
    id,
    slug: id,
    title,
    kind,
    projectId: 'oide',
    location: 'repo',
    version,
    entry: 'x',
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

type FileSet = Record<string, ArtifactFileContent>;

interface Art {
  meta: ArtifactMeta;
  versions: ArtifactVersion[];
  snapshots: Record<number, string>;
  /** Artifacts of several files: every file per version (the entry's text is also in `snapshots`). */
  files?: Record<number, FileSet>;
}

const SITE: FileSet = {
  'index.html': { encoding: 'utf8', data: '<link rel="stylesheet" href="site.css"><h1>Home</h1>' },
  'about.html': { encoding: 'utf8', data: '<h1>About</h1>' },
  'site.css': { encoding: 'utf8', data: 'h1{color:red}' },
  'shots/home.png': { encoding: 'base64', data: 'iVBORw0KGgo=' },
};

let arts: Record<string, Art>;
let listeners: Map<string, Set<(p: unknown) => void>>;
let saveError: string | null;
let listError: string | null;

function seed() {
  const board = JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {} }, null, 2);
  arts = {
    'a-doc': {
      meta: meta('a-doc', 'Webhook retry design', 'doc'),
      versions: [{ version: 1, ts: now, author: 'user' }],
      snapshots: { 1: '# Retry\n\nBackoff' },
    },
    'a-board': {
      meta: meta('a-board', 'Session lifecycle', 'whiteboard'),
      versions: [{ version: 1, ts: now, author: 'user' }],
      snapshots: { 1: board },
    },
    'a-site': {
      meta: meta('a-site', 'Docs site', 'design', 1, { entry: 'index.html', fileCount: 4, importedFrom: 'https://claude.ai/design/p/docs-site' }),
      versions: [{ version: 1, ts: now, author: 'agent:ag-fix' }],
      snapshots: { 1: SITE['index.html']!.data },
      files: { 1: SITE },
    },
  };
}

/** A new version of a multi-file artifact holding `set` (what main does for writeFiles). */
function writeSet(a: Art, set: FileSet, entry: string, author: string, note?: string) {
  const v = a.meta.version + 1;
  a.files![v] = set;
  a.snapshots[v] = set[entry]!.data;
  a.versions = [{ version: v, ts: now, author, note }, ...a.versions];
  a.meta = { ...a.meta, version: v, entry, fileCount: Object.keys(set).length };
  return v;
}

/** An agent writes some files of a multi-file artifact, then main emits. */
function agentWritesFiles(id: string, changes: Record<string, string>, agentId = 'ag-fix') {
  const a = arts[id]!;
  const set = { ...a.files![a.meta.version]! };
  for (const [path, data] of Object.entries(changes)) set[path] = { encoding: 'utf8', data };
  const v = writeSet(a, set, a.meta.entry, `agent:${agentId}`);
  emit('artifacts.changed', { id, change: 'saved', version: v, author: `agent:${agentId}` });
}

function content(a: Art): string {
  return a.snapshots[a.meta.version]!;
}

function emit(event: EventName, payload: unknown) {
  act(() => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  });
}

/** An agent writes a new version (what the MCP `artifacts_write` tool does), then main emits. */
function agentWrites(id: string, text: string, agentId = 'ag-fix') {
  const a = arts[id]!;
  const v = a.meta.version + 1;
  a.snapshots[v] = text;
  a.versions = [{ version: v, ts: now, author: `agent:${agentId}` }, ...a.versions];
  a.meta = { ...a.meta, version: v };
  emit('artifacts.changed', { id, change: 'saved', version: v, author: `agent:${agentId}` });
}

const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  const i = input as {
    id: string;
    content?: string;
    title?: string;
    version?: number;
    baseVersion?: number;
    note?: string;
    path?: string;
    files?: Array<{ path: string } & ArtifactFileContent>;
    deletes?: string[];
    entry?: string;
  };
  switch (command) {
    case 'artifacts.list':
      if (listError) throw new Error(listError);
      return Object.values(arts).map((a) => a.meta);
    case 'artifacts.uses':
      return {};
    case 'artifacts.get': {
      const a = arts[i.id];
      if (!a) throw new Error('[not_found] gone');
      return { meta: a.meta, content: content(a), uses: [], versions: a.versions };
    }
    case 'artifacts.readVersion':
      return { content: arts[i.id]!.snapshots[i.version!] };
    case 'artifacts.save': {
      if (saveError) throw new Error(saveError);
      const a = arts[i.id]!;
      if (i.baseVersion !== undefined && i.baseVersion !== a.meta.version)
        throw new Error(`[conflict] changed (now v${a.meta.version})`);
      const v = a.meta.version + 1;
      a.snapshots[v] = i.content!;
      a.versions = [{ version: v, ts: now, author: 'user', note: i.note }, ...a.versions];
      a.meta = { ...a.meta, version: v };
      queueMicrotask(() =>
        emit('artifacts.changed', { id: i.id, change: 'saved', version: v, author: 'user' }),
      );
      return a.meta;
    }
    case 'artifacts.rename': {
      const a = arts[i.id]!;
      a.meta = { ...a.meta, title: i.title! };
      return a.meta;
    }
    case 'artifacts.delete':
      delete arts[i.id];
      return { ok: true };
    case 'artifacts.files': {
      const a = arts[i.id]!;
      return Object.entries(a.files?.[i.version ?? a.meta.version] ?? {}).map(([path, c]) => ({ path, size: c.data.length, text: c.encoding === 'utf8' }));
    }
    case 'artifacts.readFile': {
      const a = arts[i.id]!;
      const c = a.files?.[i.version ?? a.meta.version]?.[i.path!];
      if (!c) throw new Error(`[not_found] ${i.path}`);
      return c;
    }
    case 'artifacts.writeFiles': {
      const a = arts[i.id]!;
      if (i.baseVersion !== undefined && i.baseVersion !== a.meta.version) throw new Error(`[conflict] changed (now v${a.meta.version})`);
      const set = { ...a.files![a.meta.version]! };
      for (const d of i.deletes ?? []) delete set[d];
      for (const f of i.files ?? []) set[f.path] = { encoding: f.encoding, data: f.data };
      const v = writeSet(a, set, i.entry ?? a.meta.entry, 'user', i.note);
      queueMicrotask(() => emit('artifacts.changed', { id: i.id, change: 'saved', version: v, author: 'user' }));
      return a.meta;
    }
    case 'artifacts.restore': {
      const a = arts[i.id]!;
      if (i.baseVersion !== undefined && i.baseVersion !== a.meta.version) throw new Error(`[conflict] changed (now v${a.meta.version})`);
      const v = writeSet(a, { ...(a.files?.[i.version!] ?? {}) }, a.meta.entry, 'user', `Restored v${i.version}`);
      queueMicrotask(() => emit('artifacts.changed', { id: i.id, change: 'saved', version: v, author: 'user' }));
      return a.meta;
    }
    default:
      throw new Error(`[not_implemented] ${command}`);
  }
});

const calls = (command: string) =>
  invoke.mock.calls.filter((c) => c[0] === command).map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  seed();
  saveError = null;
  listError = null;
  listeners = new Map();
  const bridge: OideBridge = {
    invoke: invoke as unknown as OideBridge['invoke'],
    on: ((event: string, fn: (p: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => listeners.get(event)!.delete(fn);
    }) as OideBridge['on'],
    platform: 'win32',
  };
  installFallbackBridge(bridge);
  invoke.mockClear();
  useProjects.setState({
    list: [Project.parse({ id: 'oide', name: 'oide', path: '/code/oide', trusted: true, createdAt: now })],
    loaded: true,
  });
  useScope.setState({ scope: 'all' });
  useRouter.setState({ route: { screen: 'artifacts', params: {} }, back: [], forward: [] });
  useAgents.setState({
    byId: {
      'ag-fix': AgentSummary.parse({
        id: 'ag-fix',
        projectId: 'oide',
        title: 'Retry policy',
        status: 'running',
        mode: 'auto',
        model: 'opus',
        branch: 'b',
        worktreePath: '/w',
        contextUsed: 0,
        contextWindow: 200_000,
        subagents: [],
        createdAt: now,
        updatedAt: now,
      }),
    },
    order: ['ag-fix'],
    loaded: true,
  });
  useUi.setState({ toasts: [] });
  useArtifactDrafts.getState().reset();
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  useUi.getState().setHeaderSlot('actions', slot);
});

afterEach(() => {
  cleanup();
  useUi.getState().setHeaderSlot('actions', null);
  document.body.innerHTML = '';
});

async function openArtifact(title: RegExp) {
  render(<ArtifactsScreen />);
  const card = await screen.findByRole('button', { name: title });
  fireEvent.click(card);
  fireEvent.doubleClick(card);
  return screen.findByRole('region', { name: /\(open\)/ });
}

describe('Doc editor', () => {
  it('edits Markdown with a live preview and saves version 2 from the version it started on', async () => {
    const viewer = await openArtifact(/Webhook retry design/);
    const editor = (await within(viewer).findByLabelText(
      'Source of Webhook retry design',
    )) as HTMLTextAreaElement;
    expect(editor.value).toBe('# Retry\n\nBackoff');
    expect(within(viewer).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);

    fireEvent.change(editor, { target: { value: '# Retry\n\nBackoff with **jitter**' } });
    expect(within(viewer).getByText('Unsaved changes')).toBeTruthy();
    // Live preview (sanitised Markdown) beside the editor.
    expect(
      within(viewer).getByRole('region', { name: 'Preview of Webhook retry design' }).querySelector('strong')
        ?.textContent,
    ).toBe('jitter');

    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() => expect(within(viewer).getByText(/Doc · oide · v2/)).toBeTruthy());
    expect(calls('artifacts.save')).toEqual([
      { id: 'a-doc', content: '# Retry\n\nBackoff with **jitter**', note: 'Edited by you', baseVersion: 1 },
    ]);
    expect(within(viewer).queryByText('Unsaved changes')).toBeNull();
    // Our own save coming back as artifacts.changed is not announced as someone else's.
    await waitFor(() => expect(calls('artifacts.get').length).toBeGreaterThan(1));
    expect(within(viewer).queryByText(/Updated by/)).toBeNull();
  });

  it('loads an agent write when there are no unsaved edits and says who wrote it', async () => {
    const viewer = await openArtifact(/Webhook retry design/);
    await within(viewer).findByLabelText('Source of Webhook retry design');
    agentWrites('a-doc', '# Retry\n\nExponential backoff, 5 attempts');
    await waitFor(() =>
      expect(
        (within(viewer).getByLabelText('Source of Webhook retry design') as HTMLTextAreaElement).value,
      ).toContain('5 attempts'),
    );
    const notice = within(viewer).getByRole('status');
    expect(notice.textContent).toMatch(/Updated by Retry policy agent · v2/);
    expect(within(viewer).getByText(/Doc · oide · v2/)).toBeTruthy();

    // "See changes" compares v1 with v2.
    fireEvent.click(within(notice).getByRole('button', { name: 'See changes' }));
    await waitFor(() => expect(screen.getByTestId('diff-original').textContent).toBe('# Retry\n\nBackoff'));
    expect(screen.getByTestId('diff-modified').textContent).toContain('5 attempts');
  });

  it('keeps unsaved edits and shows a conflict banner when an agent writes meanwhile', async () => {
    const viewer = await openArtifact(/Webhook retry design/);
    const editor = (await within(viewer).findByLabelText(
      'Source of Webhook retry design',
    )) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'my edit' } });
    agentWrites('a-doc', 'agent edit');

    const banner = await within(viewer).findByRole('alert');
    expect(banner.textContent).toMatch(/Retry policy agent saved v2 while you were editing/);
    expect(
      (within(viewer).getByLabelText('Source of Webhook retry design') as HTMLTextAreaElement).value,
    ).toBe('my edit');
    expect(within(viewer).getByText(/v1$/)).toBeTruthy();

    // Compare theirs with mine.
    fireEvent.click(within(banner).getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByTestId('diff-original').textContent).toBe('agent edit'));
    expect(screen.getByTestId('diff-modified').textContent).toBe('my edit');

    // Keep mine: saved on top of the agent's version.
    fireEvent.click(within(viewer).getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(calls('artifacts.save')).toHaveLength(1));
    expect(calls('artifacts.save')[0]).toMatchObject({
      content: 'my edit',
      baseVersion: 2,
      note: 'Edited by you over v2',
    });
    await waitFor(() => expect(within(viewer).queryByRole('alert')).toBeNull());
    expect(arts['a-doc']!.meta.version).toBe(3);
  });

  it('Use theirs discards the draft and loads the agent version', async () => {
    const viewer = await openArtifact(/Webhook retry design/);
    fireEvent.change(await within(viewer).findByLabelText('Source of Webhook retry design'), {
      target: { value: 'my edit' },
    });
    agentWrites('a-doc', 'agent edit');
    fireEvent.click(await within(viewer).findByRole('button', { name: 'Use theirs' }));
    expect(
      (within(viewer).getByLabelText('Source of Webhook retry design') as HTMLTextAreaElement).value,
    ).toBe('agent edit');
    expect(within(viewer).queryByText('Unsaved changes')).toBeNull();
    expect(calls('artifacts.save')).toEqual([]);
  });

  it('a save refused with conflict (no event seen yet) turns into the banner', async () => {
    const viewer = await openArtifact(/Webhook retry design/);
    fireEvent.change(await within(viewer).findByLabelText('Source of Webhook retry design'), {
      target: { value: 'mine' },
    });
    // The agent's write landed in main but its event has not arrived.
    const a = arts['a-doc']!;
    a.snapshots[2] = 'theirs';
    a.versions = [{ version: 2, ts: now, author: 'agent:ag-fix' }, ...a.versions];
    a.meta = { ...a.meta, version: 2 };
    fireEvent.click(within(viewer).getByRole('button', { name: 'Save' }));
    const banner = await within(viewer).findByRole('alert');
    expect(banner.textContent).toMatch(/saved v2 while you were editing/);
    expect(arts['a-doc']!.meta.version).toBe(2);
  });
});

describe('Whiteboard editor', () => {
  it('counts only real scene changes as edits and saves Excalidraw JSON', async () => {
    const viewer = await openArtifact(/Session lifecycle/);
    await within(viewer).findByTestId('whiteboard');
    expect(within(viewer).getByRole('tab', { name: 'Board' })).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: 'stub: loaded' }));
    expect(within(viewer).queryByText('Unsaved changes')).toBeNull();

    fireEvent.click(within(viewer).getByRole('button', { name: 'stub: draw' }));
    expect(within(viewer).getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('artifacts.save')).toHaveLength(1));
    expect(JSON.parse(String(calls('artifacts.save')[0]!.content))).toEqual({
      type: 'excalidraw',
      elements: [{ id: 'new' }],
    });
    await waitFor(() => expect(within(viewer).queryByText('Unsaved changes')).toBeNull());
  });

  it('reloads the board when an agent writes and there are no edits', async () => {
    const viewer = await openArtifact(/Session lifecycle/);
    fireEvent.click(await within(viewer).findByRole('button', { name: 'stub: loaded' }));
    const next = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'from-agent' }] });
    agentWrites('a-board', next);
    await waitFor(() => expect(within(viewer).getByTestId('whiteboard-loaded').textContent).toBe(next));
    expect(within(viewer).getByRole('status').textContent).toMatch(/Updated by Retry policy agent/);
  });
});

describe('Unsaved edits survive leaving the screen', () => {
  const draftsOf = () => useArtifactDrafts.getState().drafts;

  async function typeAndLeave(text: string) {
    const viewer = await openArtifact(/Webhook retry design/);
    fireEvent.change(await within(viewer).findByLabelText('Source of Webhook retry design'), { target: { value: text } });
    expect(draftsOf()['a-doc']).toMatchObject({ baseVersion: 1, draft: text });
    // Another screen replaces this one (left rail, Ctrl+K, a toast action).
    cleanup();
    expect(draftsOf()['a-doc']?.draft).toBe(text);
  }

  async function comeBack() {
    render(<ArtifactsScreen />);
    const viewer = await screen.findByRole('region', { name: /\(open\)/ });
    return viewer;
  }

  it('reopens the artifact with the typed text and the Unsaved changes badge', async () => {
    await typeAndLeave('# Retry\n\nhalf-written');
    const viewer = await comeBack();
    expect(((await within(viewer).findByLabelText('Source of Webhook retry design')) as HTMLTextAreaElement).value).toBe('# Retry\n\nhalf-written');
    expect(within(viewer).getByText('Unsaved changes')).toBeTruthy();
    expect(within(viewer).getByText(/Doc · oide · v1/)).toBeTruthy();
    // A save from the resumed editor is based on the version the edit started from, and clears the draft.
    fireEvent.click(within(viewer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(viewer).getByText(/Doc · oide · v2/)).toBeTruthy());
    expect(calls('artifacts.save')).toEqual([{ id: 'a-doc', content: '# Retry\n\nhalf-written', note: 'Edited by you', baseVersion: 1 }]);
    await waitFor(() => expect(draftsOf()['a-doc']).toBeUndefined());
    await waitFor(() => expect(within(viewer).queryByText('Unsaved changes')).toBeNull());
  });

  it('marks the artifact in the grid when the route points at another one (no auto-open)', async () => {
    await typeAndLeave('draft text');
    // Coming back to the grid with the route on another artifact: marker on the card, no auto-open.
    useRouter.setState({ route: { screen: 'artifacts', params: { artifactId: 'a-board' } }, back: [], forward: [] });
    render(<ArtifactsScreen />);
    const card = await screen.findByRole('button', { name: /Webhook retry design/ });
    expect(within(card).getByText('Unsaved')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /\(open\)/ })).toBeNull();
  });

  const viaRail = () => useRouter.setState({ route: { screen: 'artifacts', params: {} }, back: [], forward: [] });
  const viewerOpen = () => screen.queryByRole('region', { name: /\(open\)/ });
  const gridCard = async (title: RegExp) => within(await screen.findByRole('tabpanel', { name: 'Artifacts' })).findByRole('button', { name: title });

  it('reopens the open artifact when the rail (no artifact in the route) brings the screen back', async () => {
    await typeAndLeave('half-written');
    viaRail();
    const viewer = await comeBack();
    expect(((await within(viewer).findByLabelText('Source of Webhook retry design')) as HTMLTextAreaElement).value).toBe('half-written');
    expect(useRouter.getState().route).toEqual({ screen: 'artifacts', params: { artifactId: 'a-doc' } });
  });

  it('Keep as draft goes back to the grid with the draft kept, and the grid stays browsable', async () => {
    await typeAndLeave('draft text');
    viaRail();
    const viewer = await comeBack();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Artifacts' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    expect(within(confirm).getByRole('button', { name: 'Keep editing' })).toBeTruthy();
    expect(within(confirm).getByRole('button', { name: 'Discard' })).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep as draft' }));
    await waitFor(() => expect(viewerOpen()).toBeNull());
    expect(draftsOf()['a-doc']?.draft).toBe('draft text');
    expect(within(await gridCard(/Webhook retry design/)).getByText('Unsaved')).toBeTruthy();
    // Leaving and coming back by the rail lands on the grid, not in the editor again.
    cleanup();
    viaRail();
    render(<ArtifactsScreen />);
    const card = await gridCard(/Webhook retry design/);
    expect(within(card).getByText('Unsaved')).toBeTruthy();
    expect(viewerOpen()).toBeNull();
    // The badge is the way back: the card opens the editor with the kept text.
    fireEvent.click(card);
    fireEvent.doubleClick(card);
    const again = await screen.findByRole('region', { name: /\(open\)/ });
    expect(((await within(again).findByLabelText('Source of Webhook retry design')) as HTMLTextAreaElement).value).toBe('draft text');
  });

  it('a Viewer without edits closes straight away, with no Keep as draft', async () => {
    const viewer = await openArtifact(/Webhook retry design/);
    fireEvent.click(within(viewer).getByRole('button', { name: 'Artifacts' }));
    await waitFor(() => expect(viewerOpen()).toBeNull());
    expect(screen.queryByRole('button', { name: 'Keep as draft' })).toBeNull();
  });

  it('keeps every draft when the first load of the list fails, and resumes once it works', async () => {
    await typeAndLeave('draft text');
    listError = 'disk is busy';
    render(<ArtifactsScreen />);
    await waitFor(() => expect(calls('artifacts.list').length).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });
    expect(draftsOf()['a-doc']?.draft).toBe('draft text');
    expect(viewerOpen()).toBeNull();
    // A later successful load: the draft is still there and the route's artifact reopens with it.
    listError = null;
    emit('artifacts.changed', { id: 'a-doc', change: 'saved', version: 1, author: 'user' });
    const viewer = await screen.findByRole('region', { name: /\(open\)/ });
    expect(((await within(viewer).findByLabelText('Source of Webhook retry design')) as HTMLTextAreaElement).value).toBe('draft text');
  });

  it('still drops the draft of an artifact that no longer exists', async () => {
    await typeAndLeave('draft text');
    delete arts['a-doc'];
    viaRail();
    render(<ArtifactsScreen />);
    await screen.findByRole('button', { name: /Session lifecycle/ });
    await waitFor(() => expect(draftsOf()['a-doc']).toBeUndefined());
  });

  it('drops a draft whose artifact now opens on another page, with a notice, instead of writing it to the wrong file', async () => {
    const viewer = await openArtifact(/Docs site/);
    fireEvent.change(await within(viewer).findByLabelText('Source of Docs site'), { target: { value: '<h1>Home mine</h1>' } });
    expect(draftsOf()['a-site']).toMatchObject({ entry: 'index.html', draft: '<h1>Home mine</h1>' });
    cleanup();
    // An agent made about.html the page while the screen was away.
    const a = arts['a-site']!;
    writeSet(a, { ...a.files![1]! }, 'about.html', 'agent:ag-fix');
    render(<ArtifactsScreen />);
    await screen.findByRole('button', { name: /Docs site/ });
    await waitFor(() => expect(draftsOf()['a-site']).toBeUndefined());
    expect(viewerOpen()).toBeNull();
    expect(useUi.getState().toasts.map((t) => t.message)).toContain('Docs site now opens on another page, so your unsaved edits to the old one were discarded.');
    expect(calls('artifacts.writeFiles')).toEqual([]);
  });

  it('does not remember an artifact whose Viewer was never shown when the route moves while one is open', async () => {
    // a-doc has a kept draft (Unsaved badge); the user then opens another artifact.
    await typeAndLeave('draft text');
    useRouter.setState({ route: { screen: 'artifacts', params: { artifactId: 'a-board' } }, back: [], forward: [] });
    render(<ArtifactsScreen />);
    const board = await gridCard(/Session lifecycle/);
    fireEvent.click(board);
    fireEvent.doubleClick(board);
    await screen.findByRole('region', { name: /\(open\)/ });
    // A toast action or Ctrl+K moves the route to a-doc: the Viewer closes, its editor was never shown.
    act(() => useRouter.getState().replace('artifacts', { artifactId: 'a-doc' }));
    await waitFor(() => expect(viewerOpen()).toBeNull());
    expect(useArtifactDrafts.getState().lastOpenId).toBeNull();
    // Back by the rail later: the grid, not a-doc's editor.
    cleanup();
    viaRail();
    render(<ArtifactsScreen />);
    expect(within(await gridCard(/Webhook retry design/)).getByText('Unsaved')).toBeTruthy();
    expect(viewerOpen()).toBeNull();
  });

  it('tells the user when a kept draft is dropped on reopening from the card because the page changed meanwhile', async () => {
    const viewer = await openArtifact(/Docs site/);
    fireEvent.change(await within(viewer).findByLabelText('Source of Docs site'), { target: { value: '<h1>Home mine</h1>' } });
    fireEvent.click(within(viewer).getByRole('button', { name: 'Artifacts' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' })).getByRole('button', { name: 'Keep as draft' }));
    await waitFor(() => expect(viewerOpen()).toBeNull());
    // While the grid is shown, an agent makes about.html the page.
    const a = arts['a-site']!;
    const v = writeSet(a, { ...a.files![a.meta.version]! }, 'about.html', 'agent:ag-fix');
    emit('artifacts.changed', { id: 'a-site', change: 'saved', version: v, author: 'agent:ag-fix' });
    const card = await gridCard(/Docs site/);
    fireEvent.click(card);
    fireEvent.doubleClick(card);
    await screen.findByRole('region', { name: /\(open\)/ });
    await waitFor(() => expect(draftsOf()['a-site']).toBeUndefined());
    expect(useUi.getState().toasts.map((t) => t.message)).toContain('Docs site now opens on another page, so your unsaved edits to the old one were discarded.');
    expect(calls('artifacts.writeFiles')).toEqual([]);
  });

  it('Discard clears the stored draft', async () => {
    await typeAndLeave('draft text');
    const viewer = await comeBack();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Artifacts' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /\(open\)/ })).toBeNull());
    expect(draftsOf()['a-doc']).toBeUndefined();
    cleanup();
    render(<ArtifactsScreen />);
    await screen.findByRole('button', { name: /Webhook retry design/ });
    expect(screen.queryByRole('region', { name: /\(open\)/ })).toBeNull();
  });

  it('Use theirs clears the stored draft', async () => {
    const viewer = await openArtifact(/Webhook retry design/);
    fireEvent.change(await within(viewer).findByLabelText('Source of Webhook retry design'), { target: { value: 'my edit' } });
    agentWrites('a-doc', 'agent edit');
    fireEvent.click(await within(viewer).findByRole('button', { name: 'Use theirs' }));
    await waitFor(() => expect(draftsOf()['a-doc']).toBeUndefined());
  });

  it('a draft whose artifact moved on while away comes back as the conflict banner, not lost', async () => {
    await typeAndLeave('my edit');
    agentWrites('a-doc', 'agent edit');
    const viewer = await comeBack();
    const banner = await within(viewer).findByRole('alert');
    expect(banner.textContent).toMatch(/Retry policy agent saved v2 while you were editing/);
    expect((within(viewer).getByLabelText('Source of Webhook retry design') as HTMLTextAreaElement).value).toBe('my edit');
    expect(within(viewer).getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(calls('artifacts.save')[0]).toMatchObject({ content: 'my edit', baseVersion: 2 }));
    await waitFor(() => expect(draftsOf()['a-doc']).toBeUndefined());
  });

  it('keeps a whiteboard with a changed scene and restores it as edited', async () => {
    const viewer = await openArtifact(/Session lifecycle/);
    fireEvent.click(await within(viewer).findByRole('button', { name: 'stub: loaded' }));
    expect(draftsOf()['a-board']).toBeUndefined();
    fireEvent.click(within(viewer).getByRole('button', { name: 'stub: draw' }));
    await waitFor(() => expect(draftsOf()['a-board']).toBeDefined());
    cleanup();
    const back = await comeBack();
    expect(within(back).getByText('Unsaved changes')).toBeTruthy();
    // Loading the stored scene again is not a new baseline: still unsaved.
    fireEvent.click(await within(back).findByRole('button', { name: 'stub: loaded' }));
    expect(within(back).getByText('Unsaved changes')).toBeTruthy();
  });
});

describe('Rename, delete and compare', () => {
  it('renames from the detail pane', async () => {
    render(<ArtifactsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /Webhook retry design/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Webhook retry design' }));
    const dialog = await screen.findByRole('dialog', { name: /Rename Webhook retry design/ });
    const field = within(dialog).getByLabelText('Title');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(within(dialog).getByText('Give it a title.')).toBeTruthy();
    expect(calls('artifacts.rename')).toEqual([]);

    fireEvent.change(field, { target: { value: 'Retry policy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await screen.findByRole('heading', { name: 'Retry policy', level: 2 });
    expect(calls('artifacts.rename')).toEqual([{ id: 'a-doc', title: 'Retry policy' }]);
  });

  it('deletes after a confirm, from the open viewer', async () => {
    const viewer = await openArtifact(/Webhook retry design/);
    fireEvent.click(within(viewer).getByRole('button', { name: 'More actions for Webhook retry design' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Webhook retry design?' });
    expect(dialog.textContent).toMatch(/Copies you committed stay in git history/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls('artifacts.delete')).toEqual([]);

    fireEvent.click(within(viewer).getByRole('button', { name: 'More actions for Webhook retry design' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete Webhook retry design?' })).getByRole(
        'button',
        { name: 'Delete' },
      ),
    );
    await waitFor(() => expect(calls('artifacts.delete')).toEqual([{ id: 'a-doc' }]));
    await waitFor(() => expect(screen.queryByRole('region', { name: /\(open\)/ })).toBeNull());
    expect(useUi.getState().toasts.map((t) => t.message)).toContain('Deleted Webhook retry design');
  });

  it('compares two versions from History', async () => {
    agentWrites('a-doc', '# Retry\n\nv2 text');
    render(<ArtifactsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /Webhook retry design/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Compare versions' }));
    const viewer = await screen.findByRole('region', { name: /\(open\)/ });
    await waitFor(() =>
      expect(within(viewer).getByTestId('diff-original').textContent).toBe('# Retry\n\nBackoff'),
    );
    expect(within(viewer).getByTestId('diff-modified').textContent).toBe('# Retry\n\nv2 text');
    expect(calls('artifacts.readVersion')).toEqual([{ id: 'a-doc', version: 1 }]);
    // Swap the sides with the selects.
    fireEvent.change(within(viewer).getByLabelText('From'), { target: { value: '2' } });
    fireEvent.change(within(viewer).getByLabelText('To'), { target: { value: '1' } });
    expect(within(viewer).getByTestId('diff-original').textContent).toBe('# Retry\n\nv2 text');
  });
});

describe('History > Restore', () => {
  it('restores the whole version with artifacts.restore, not only the entry text', async () => {
    agentWritesFiles('a-site', { 'site.css': 'h1{color:blue}', 'index.html': '<h1>Home v2</h1>' });
    render(<ArtifactsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /Docs site/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^v1 ·/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls('artifacts.restore')).toEqual([{ id: 'a-site', version: 1, baseVersion: 2 }]));
    // The entry-only path is gone: nothing is saved over the current files.
    expect(calls('artifacts.save')).toEqual([]);
    expect(calls('artifacts.writeFiles')).toEqual([]);
    await waitFor(() => expect(useUi.getState().toasts.map((t) => t.message)).toContain('Restored v1 as v3'));
    expect(arts['a-site']!.files![3]).toEqual(SITE);
  });
});

describe('Artifacts of several files', () => {
  const files = () => screen.getByRole('navigation', { name: 'Files' });
  const fileButton = (name: string) => within(files()).getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')}`) });

  it('lists the files with the entry marked, and saves another text file with writeFiles from its version', async () => {
    const viewer = await openArtifact(/Docs site/);
    expect(within(viewer).getByText(/Design · oide · v1 · 4 files/)).toBeTruthy();
    await waitFor(() => expect(within(files()).getAllByRole('button').map((b) => b.textContent)).toEqual(['home.png', 'about.html', 'index.htmlOpens on', 'site.css']));
    expect(within(files()).getByText('shots')).toBeTruthy();
    expect(fileButton('index.html').getAttribute('aria-current')).toBe('true');

    fireEvent.click(fileButton('site.css'));
    const editor = (await within(viewer).findByLabelText('Source of site.css')) as HTMLTextAreaElement;
    expect(editor.value).toBe('h1{color:red}');
    expect(fileButton('site.css').getAttribute('aria-current')).toBe('true');
    // The entry's tabs give way to the file; the design preview stays beside it.
    expect(within(viewer).queryByRole('tab', { name: 'Edit' })).toBeNull();
    expect(within(viewer).getByTitle('Preview of Docs site')).toBeTruthy();

    fireEvent.change(editor, { target: { value: 'h1{color:blue}' } });
    expect(within(viewer).getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('artifacts.writeFiles')).toHaveLength(1));
    expect(calls('artifacts.writeFiles')[0]).toEqual({ id: 'a-site', files: [{ path: 'site.css', encoding: 'utf8', data: 'h1{color:blue}' }], note: 'Edited site.css', baseVersion: 1 });
    await waitFor(() => expect(within(viewer).queryByText('Unsaved changes')).toBeNull());
    await waitFor(() => expect(within(viewer).getByText(/v2 · 4 files/)).toBeTruthy());
    // Our own save coming back is not announced as someone else's.
    expect(within(viewer).queryByText(/Updated by/)).toBeNull();
    expect(calls('artifacts.save')).toEqual([]);
  });

  it('asks before leaving unsaved edits to a file, and saves entry edits with writeFiles', async () => {
    const viewer = await openArtifact(/Docs site/);
    fireEvent.click(await waitFor(() => fileButton('site.css')));
    fireEvent.change(await within(viewer).findByLabelText('Source of site.css'), { target: { value: 'mine' } });
    fireEvent.click(fileButton('index.html'));
    const confirm = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    expect(confirm.textContent).toMatch(/site\.css/);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Discard' }));

    const entry = (await within(viewer).findByLabelText('Source of Docs site')) as HTMLTextAreaElement;
    fireEvent.change(entry, { target: { value: '<h1>Home 2</h1>' } });
    fireEvent.click(within(viewer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('artifacts.writeFiles')).toEqual([{ id: 'a-site', files: [{ path: 'index.html', encoding: 'utf8', data: '<h1>Home 2</h1>' }], note: 'Edited by you', baseVersion: 1 }]));
    expect(arts['a-site']!.files![2]!['site.css']!.data).toBe('h1{color:red}');
  });

  it('an agent changing another file is taken quietly; changing the open file with edits is a conflict', async () => {
    const viewer = await openArtifact(/Docs site/);
    fireEvent.click(await waitFor(() => fileButton('site.css')));
    fireEvent.change(await within(viewer).findByLabelText('Source of site.css'), { target: { value: 'mine' } });

    agentWritesFiles('a-site', { 'about.html': '<h1>About us</h1>' });
    await waitFor(() => expect(within(viewer).getByText(/v2 · 4 files/)).toBeTruthy());
    expect(within(viewer).queryByRole('alert')).toBeNull();

    agentWritesFiles('a-site', { 'site.css': 'theirs' });
    const banner = await within(viewer).findByRole('alert');
    expect(banner.textContent).toMatch(/Retry policy agent saved v3 with changes to site\.css while you were editing it/);
    expect((within(viewer).getByLabelText('Source of site.css') as HTMLTextAreaElement).value).toBe('mine');
    fireEvent.click(within(banner).getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(calls('artifacts.writeFiles')).toHaveLength(1));
    expect(calls('artifacts.writeFiles')[0]).toMatchObject({ files: [{ path: 'site.css', data: 'mine' }], baseVersion: 3, note: 'Edited site.css over v3' });
    await waitFor(() => expect(within(viewer).queryByRole('alert')).toBeNull());
  });

  it('loads an agent write to the open file when there are no edits, and Use theirs drops edits', async () => {
    const viewer = await openArtifact(/Docs site/);
    fireEvent.click(await waitFor(() => fileButton('site.css')));
    await within(viewer).findByLabelText('Source of site.css');
    agentWritesFiles('a-site', { 'site.css': 'from the agent' });
    await waitFor(() => expect((within(viewer).getByLabelText('Source of site.css') as HTMLTextAreaElement).value).toBe('from the agent'));
    expect(within(viewer).getByRole('status').textContent).toMatch(/Updated by Retry policy agent · v2/);

    fireEvent.change(within(viewer).getByLabelText('Source of site.css'), { target: { value: 'mine' } });
    agentWritesFiles('a-site', { 'site.css': 'again' });
    fireEvent.click(await within(viewer).findByRole('button', { name: 'Use theirs' }));
    expect((within(viewer).getByLabelText('Source of site.css') as HTMLTextAreaElement).value).toBe('again');
    expect(within(viewer).queryByText('Unsaved changes')).toBeNull();
  });

  it('shows an image inline as a data URL', async () => {
    const viewer = await openArtifact(/Docs site/);
    fireEvent.click(await waitFor(() => fileButton('home.png')));
    const img = (await within(viewer).findByRole('img', { name: 'shots/home.png' })) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(within(viewer).queryByLabelText('Source of shots/home.png')).toBeNull();
    expect(calls('artifacts.readFile')).toContainEqual({ id: 'a-site', path: 'shots/home.png' });
  });

  it('Open on this page makes another page the entry, with no file changes', async () => {
    const viewer = await openArtifact(/Docs site/);
    fireEvent.click(await waitFor(() => fileButton('about.html')));
    await within(viewer).findByLabelText('Source of about.html');
    fireEvent.click(within(viewer).getByRole('button', { name: 'Open on this page' }));
    await waitFor(() => expect(calls('artifacts.writeFiles')).toEqual([{ id: 'a-site', entry: 'about.html', note: 'Opens on about.html', baseVersion: 1 }]));
    // The entry editor now holds the new entry, marked in the panel.
    await waitFor(() => expect((within(viewer).getByLabelText('Source of Docs site') as HTMLTextAreaElement).value).toBe('<h1>About</h1>'));
    await waitFor(() => expect(fileButton('about.html').textContent).toBe('about.htmlOpens on'));
    expect(within(viewer).getByRole('tab', { name: 'Edit' })).toBeTruthy();
  });
});

describe('A first retrieval landing while open', () => {
  it('replaces the retrieval status with the editors and the retrieved content', async () => {
    arts['a-pending'] = {
      meta: meta('a-pending', 'Pricing calculator', 'doc', 0, { importedFrom: 'https://claude.ai/artifact/NFaggV4JC9X6prTgKhobKm', retrieval: { status: 'retrieving', agentId: 'ag-fix', trigger: 'import', startedAt: now } }),
      versions: [],
      snapshots: { 0: '' },
    };
    const viewer = await openArtifact(/Pricing calculator/);
    expect(within(viewer).getByRole('heading', { name: 'Retrieving from claude.ai' })).toBeTruthy();
    expect(within(viewer).getByRole('status').textContent).toMatch(/Retry policy\s*· Running/);
    const a = arts['a-pending']!;
    a.snapshots[1] = '# Pricing\n\nTiers';
    a.versions = [{ version: 1, ts: now, author: 'agent:ag-fix', note: 'Retrieved from claude.ai' }];
    a.meta = { ...a.meta, version: 1, retrieval: { ...a.meta.retrieval!, status: 'ready', retrievedAt: now } };
    emit('artifacts.changed', { id: 'a-pending', change: 'saved', version: 1, author: 'agent:ag-fix' });
    // The editor mounts in the commit where `meta.version` leaves 0, one render before the Viewer's
    // effect copies the retrieved content into its draft, so wait for the content, not the element.
    await within(viewer).findByLabelText('Source of Pricing calculator');
    await waitFor(() => expect((within(viewer).getByLabelText('Source of Pricing calculator') as HTMLTextAreaElement).value).toBe('# Pricing\n\nTiers'));
    expect(within(viewer).queryByRole('heading', { name: 'Retrieving from claude.ai' })).toBeNull();
    expect(within(viewer).getByText(/Doc · oide · v1/)).toBeTruthy();
  });
});
