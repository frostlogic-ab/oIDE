// @vitest-environment jsdom
/**
 * Artifact editors (Viewer.tsx): doc editing with live preview and save as a new version, agent
 * updates while open ("Updated by …" vs the conflict banner), whiteboard dirty tracking, version
 * compare, rename and delete. Monaco, Excalidraw and the diff editor are replaced with light stubs
 * (jsdom has no canvas or layout); the Viewer's own logic runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  AgentSummary,
  ArtifactMeta,
  Project,
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
const meta = (id: string, title: string, kind: ArtifactMeta['kind'], version = 1) =>
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
  });

interface Art {
  meta: ArtifactMeta;
  versions: ArtifactVersion[];
  snapshots: Record<number, string>;
}

let arts: Record<string, Art>;
let listeners: Map<string, Set<(p: unknown) => void>>;
let saveError: string | null;

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
  };
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
  };
  switch (command) {
    case 'artifacts.list':
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
    default:
      throw new Error(`[not_implemented] ${command}`);
  }
});

const calls = (command: string) =>
  invoke.mock.calls.filter((c) => c[0] === command).map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  seed();
  saveError = null;
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
