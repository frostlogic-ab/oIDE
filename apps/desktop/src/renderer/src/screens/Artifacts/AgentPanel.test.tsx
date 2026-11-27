// @vitest-environment jsdom
/**
 * The open view's Agent panel and point and comment (AgentPanel.tsx, Comments.tsx, Viewer.tsx):
 * the Preview | Code switch, starting the artifact agent (and its `needs_project` answer), the
 * running agent's transcript, Compact, model / effort and mode, the design frame's picker messages
 * (only from that frame's window, only when they parse), comments on a doc by click, and the
 * Feedback tray sending only the ticked comments. Monaco is a textarea stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentEvent, AgentSummary, ArtifactMeta, Project, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { settings as settingsFixture } from '../../lib/mock/fixtures';
import { useAgents } from '../../stores/agents';
import { useFocusHistory } from '../Focus/model/history';
import { resetDrafts } from '../Focus/composerDrafts';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { useArtifactDrafts } from './draftStore';
import { useArtifactFeedback } from './feedbackStore';
import ArtifactsScreen from './index';

vi.mock('./SourceEditor', () => ({
  default: (p: { value: string; label: string; onChange: (v: string) => void }) => <textarea aria-label={p.label} value={p.value} onChange={(e) => p.onChange(e.target.value)} />,
}));

const now = Date.now();
const meta = (id: string, title: string, kind: ArtifactMeta['kind'], extra: Partial<ArtifactMeta> = {}) =>
  ArtifactMeta.parse({ id, slug: id, title, kind, projectId: 'oide', location: 'repo', version: 3, entry: kind === 'design' ? 'index.html' : 'doc.md', createdAt: now, updatedAt: now, ...extra });

const DOC = '# Retry policy\n\nBackoff with jitter.\n\n## Limits\n\n- Five attempts\n- Then give up';
const arts: Record<string, { meta: ArtifactMeta; content: string }> = {};
let listeners: Map<string, Set<(p: unknown) => void>>;
let startAgent: (input: Record<string, unknown>) => unknown;
let events: AgentEvent[];

const agentSummary = (extra: Partial<AgentSummary> = {}) =>
  AgentSummary.parse({
    id: 'ag-art',
    projectId: 'oide',
    title: 'Edit Pricing page',
    status: 'done',
    mode: 'acceptEdits',
    model: 'opus',
    effort: 'high',
    workIn: 'artifact-folder',
    artifactId: 'a-site',
    contextUsed: 50_000,
    contextWindow: 200_000,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  const i = input as Record<string, unknown> & { id: string };
  switch (command) {
    case 'artifacts.list':
      return Object.values(arts).map((a) => a.meta);
    case 'artifacts.uses':
      return {};
    case 'artifacts.get': {
      const a = arts[i.id]!;
      return { meta: a.meta, content: a.content, uses: [], versions: [{ version: 3, ts: now, author: 'user' }] };
    }
    case 'artifacts.previewUrl':
      return { url: `oide-artifact://${i.id}/index.html` };
    case 'artifacts.startAgent':
      return startAgent(i);
    case 'agents.events':
      return events;
    case 'agents.send':
    case 'agents.setModel':
    case 'agents.setMode':
    case 'agents.compact':
    case 'agents.stop':
    case 'telemetry.track':
      return { ok: true };
    default:
      throw new Error(`[not_implemented] ${command}`);
  }
});
const calls = (command: string) => invoke.mock.calls.filter((c) => c[0] === command).map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  arts['a-site'] = { meta: meta('a-site', 'Pricing page', 'design'), content: '<main><h2>Pricing that scales</h2></main>' };
  arts['a-doc'] = { meta: meta('a-doc', 'Retry design', 'doc'), content: DOC };
  arts['a-loose'] = { meta: meta('a-loose', 'Loose notes', 'doc', { projectId: undefined, location: 'app-data' }), content: '# Notes' };
  events = [];
  startAgent = () => agentSummary({ status: 'running' });
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
    list: [Project.parse({ id: 'oide', name: 'oide', path: '/code/oide', trusted: true, createdAt: now }), Project.parse({ id: 'docs', name: 'docs-site', path: '/code/docs', trusted: true, createdAt: now })],
    loaded: true,
  });
  useSettings.setState({ settings: { ...settingsFixture, privacy: { ...settingsFixture.privacy, usageAnalytics: true } } });
  useScope.setState({ scope: 'all' });
  useRouter.setState({ route: { screen: 'artifacts', params: {} }, back: [], forward: [] });
  useAgents.setState({ byId: {}, order: [], events: {}, loaded: true });
  useFocusHistory.getState().reset(null);
  useUi.setState({ toasts: [] });
  useArtifactDrafts.getState().reset();
  useArtifactFeedback.getState().reset();
  resetDrafts();
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  useUi.getState().setHeaderSlot('actions', slot);
});

afterEach(() => {
  cleanup();
  useUi.getState().setHeaderSlot('actions', null);
  document.body.innerHTML = '';
});

async function open(title: RegExp) {
  render(<ArtifactsScreen />);
  const card = await screen.findByRole('button', { name: title });
  fireEvent.click(card);
  fireEvent.doubleClick(card);
  return screen.findByRole('region', { name: /\(open\)/ });
}

const panel = () => screen.getByRole('complementary', { name: 'Agent' });
const withAgent = (extra: Partial<AgentSummary> = {}) => {
  const a = agentSummary(extra);
  useAgents.setState({ byId: { [a.id]: a }, order: [a.id] });
  return a;
};

describe('Preview | Code', () => {
  it('opens on Preview and switches to Code (and back) from the keyboard', async () => {
    const viewer = await open(/Retry design/);
    // The heading has focus in the commit that opens the view, so it can't take focus back from a
    // key pressed straight after (this raced on a slow CI runner when it was a passive effect).
    expect(document.activeElement).toBe(within(viewer).getByRole('heading', { name: 'Retry design' }));
    const preview = within(viewer).getByRole('radio', { name: 'Preview' });
    expect(preview.getAttribute('aria-checked')).toBe('true');
    expect(within(viewer).getByRole('region', { name: 'Preview of Retry design' })).toBeTruthy();
    expect(within(viewer).queryByLabelText('Source of Retry design')).toBeNull();
    fireEvent.keyDown(preview, { key: 'ArrowRight' });
    expect(within(viewer).getByRole('radio', { name: 'Code' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(within(viewer).getByRole('radio', { name: 'Code' }));
    expect(await within(viewer).findByLabelText('Source of Retry design')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(within(viewer).getByRole('region', { name: 'Preview of Retry design' })).toBeTruthy();
    // The choice is remembered for the next artifact opened.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(useArtifactFeedback.getState().view).toBe('code');
  });

  it('collapses the Agent panel to a strip and brings it back', async () => {
    await open(/Retry design/);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Hide the agent panel' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Agent' })).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Show the agent panel' }));
    expect(await screen.findByRole('complementary', { name: 'Agent' })).toBeTruthy();
  });
});

describe('Starting the artifact agent', () => {
  it('shows the intro and sends the first direction with mode and model', async () => {
    await open(/Retry design/);
    expect(within(panel()).getByText(/It can edit, add and delete this artifact's files/)).toBeTruthy();
    fireEvent.change(within(panel()).getByRole('combobox', { name: 'Permission mode' }), { target: { value: 'acceptEdits' } });
    fireEvent.change(within(panel()).getByRole('combobox', { name: 'Model' }), { target: { value: 'sonnet' } });
    const box = within(panel()).getByLabelText('Message a new agent for this artifact');
    fireEvent.change(box, { target: { value: 'Shorten the intro' } });
    startAgent = (i) => agentSummary({ status: 'running', artifactId: i.id as string });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls('artifacts.startAgent')).toHaveLength(1));
    expect(calls('artifacts.startAgent')[0]).toMatchObject({ id: 'a-doc', text: 'Shorten the intro', mode: 'acceptEdits', model: { model: 'sonnet' } });
    // The returned summary is the agent: the panel switches to it.
    expect(await within(panel()).findByRole('region', { name: 'Agent transcript' })).toBeTruthy();
    expect(calls('telemetry.track')).toContainEqual({ type: 'event', name: 'artifact_agent_message', props: { kind: 'doc', feedback: 0, has_text: true } });
  });

  it('asks which project to run under when main answers needs_project, then starts with it', async () => {
    startAgent = (i) => {
      if (!i.projectId) throw new Error('[needs_project] Pick a project');
      return agentSummary({ artifactId: 'a-loose', projectId: i.projectId as string });
    };
    await open(/Loose notes/);
    const box = within(panel()).getByLabelText('Message a new agent for this artifact');
    fireEvent.change(box, { target: { value: 'Add a summary' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Start the agent' }));
    const select = await within(panel()).findByRole('combobox', { name: 'Run the agent under' });
    fireEvent.change(select, { target: { value: 'docs' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(calls('artifacts.startAgent')).toHaveLength(2));
    expect(calls('artifacts.startAgent')[1]).toMatchObject({ id: 'a-loose', text: 'Add a summary', projectId: 'docs' });
    await waitFor(() => expect(within(panel()).queryByRole('combobox', { name: 'Run the agent under' })).toBeNull());
  });
});

describe('With an agent', () => {
  it('shows its transcript, compacts through the dialog, and changes model, effort and mode', async () => {
    const a = withAgent();
    events = [
      AgentEvent.parse({ type: 'user-text', agentId: a.id, seq: 0, ts: now, text: 'Make the heading smaller' }),
      AgentEvent.parse({ type: 'assistant-text', agentId: a.id, seq: 1, ts: now, text: 'Done: the heading is 20px now.' }),
    ];
    await open(/Pricing page/);
    // Focus's own transcript pieces: the agent's event log, paged from agents.events (the rows are
    // virtualized, so jsdom, which has no layout, draws none of them).
    expect(within(panel()).getByRole('region', { name: 'Agent transcript' })).toBeTruthy();
    await waitFor(() => expect(calls('agents.events')).toEqual([{ agentId: 'ag-art', limit: 500 }]));
    await waitFor(() => expect(useFocusHistory.getState().events.map((e) => e.seq)).toEqual([0, 1]));
    expect(within(panel()).getByText('Done')).toBeTruthy();

    fireEvent.click(within(panel()).getByRole('button', { name: /Context 25% full/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Compact this session?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Compact' }));
    await waitFor(() => expect(calls('agents.compact')).toEqual([{ agentId: 'ag-art' }]));

    fireEvent.change(within(panel()).getByRole('combobox', { name: 'Model' }), { target: { value: 'sonnet' } });
    await waitFor(() => expect(calls('agents.setModel')).toEqual([{ agentId: 'ag-art', model: 'sonnet', effort: 'high' }]));
    expect(within(panel()).getByRole('combobox', { name: 'Model' }).getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.change(within(panel()).getByRole('combobox', { name: 'Effort' }), { target: { value: 'low' } });
    await waitFor(() => expect(calls('agents.setModel')[1]).toEqual({ agentId: 'ag-art', model: 'opus', effort: 'low' }));

    fireEvent.change(within(panel()).getByRole('combobox', { name: 'Permission mode' }), { target: { value: 'plan' } });
    await waitFor(() => expect(calls('agents.setMode')).toEqual([{ agentId: 'ag-art', mode: 'plan' }]));
  });

  it('offers Bypass only when Settings allow it (an artifact agent never works in the project folder)', async () => {
    withAgent();
    await open(/Pricing page/);
    const bypass = () => within(within(panel()).getByRole('combobox', { name: 'Permission mode' })).getByRole('option', { name: /Bypass/ }) as HTMLOptionElement;
    expect(bypass().disabled).toBe(true);
    act(() => useSettings.setState({ settings: { ...settingsFixture, claude: { ...settingsFixture.claude, allowBypass: true } } }));
    expect(bypass().disabled).toBe(false);
  });

  it('hides the model picker for an agent on a custom model, and offers Stop while it works', async () => {
    withAgent({ model: 'my-local-llama', status: 'running' });
    await open(/Pricing page/);
    expect(within(panel()).queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(within(panel()).getByText('my-local-llama')).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls('agents.stop')).toEqual([{ agentId: 'ag-art' }]));
  });
});

describe('Point and comment', () => {
  const picked = (extra: Record<string, unknown> = {}) => ({
    type: 'oide-picked',
    selector: 'main > h2',
    tag: 'h2',
    text: 'Pricing that scales',
    page: 'index.html',
    rect: { x: 40, y: 30, w: 300, h: 40 },
    viewport: { w: 1000, h: 700 },
    ...extra,
  });
  const post = (data: unknown, source: Window | null) => act(() => void window.dispatchEvent(new MessageEvent('message', { data, source })));

  async function commentOnDesign() {
    const viewer = await open(/Pricing page/);
    const frame = await waitFor(() => {
      const f = viewer.querySelector('iframe');
      if (!f?.getAttribute('src')) throw new Error('no frame yet');
      return f;
    });
    const toFrame = vi.spyOn(frame.contentWindow!, 'postMessage');
    const toggle = within(viewer).getByRole('button', { name: 'Comment' });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(toFrame).toHaveBeenCalledWith({ type: 'oide-pick-mode', on: true }, '*'));
    return { viewer, frame, toFrame };
  }

  it("opens the comment form for a pick from the preview's own frame, and ignores other sources and bad messages", async () => {
    const { viewer, frame } = await commentOnDesign();
    post(picked(), window);
    post(picked(), null);
    post({ type: 'oide-picked', selector: 'h2' }, frame.contentWindow);
    post({ type: 'something-else' }, frame.contentWindow);
    expect(within(viewer).queryByRole('dialog', { name: 'Comment on the preview' })).toBeNull();

    post(picked(), frame.contentWindow);
    const form = await within(viewer).findByRole('dialog', { name: 'Comment on the preview' });
    expect(within(form).getByText('index.html › `main > h2`')).toBeTruthy();
    fireEvent.keyDown(within(form).getByLabelText('What should change here?'), { key: 'Escape' });
    expect(within(viewer).queryByRole('dialog', { name: 'Comment on the preview' })).toBeNull();
  });

  it('pins two comments, sends only the ticked one, and tells the frame where the markers go', async () => {
    withAgent();
    const { viewer, frame, toFrame } = await commentOnDesign();
    for (const [selector, comment] of [
      ['main > h2', 'Make this heading smaller and left-aligned.'],
      ['main > p', 'Drop this paragraph.'],
    ] as const) {
      post(picked({ selector, text: selector === 'main > h2' ? 'Pricing that scales' : 'Some words' }), frame.contentWindow);
      const form = await within(viewer).findByRole('dialog', { name: 'Comment on the preview' });
      fireEvent.change(within(form).getByLabelText('What should change here?'), { target: { value: comment } });
      fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    }
    await waitFor(() => expect(toFrame).toHaveBeenCalledWith({ type: 'oide-pins', pins: [{ n: 1, selector: 'main > h2' }, { n: 2, selector: 'main > p' }] }, '*'));
    // The picker reloads (a save, another page): it gets the mode and the pins again.
    toFrame.mockClear();
    post({ type: 'oide-picker-ready', page: 'index.html' }, frame.contentWindow);
    expect(toFrame).toHaveBeenCalledWith({ type: 'oide-pick-mode', on: true }, '*');
    expect(toFrame).toHaveBeenCalledWith({ type: 'oide-pins', pins: [{ n: 1, selector: 'main > h2' }, { n: 2, selector: 'main > p' }] }, '*');

    const tray = within(panel()).getByRole('region', { name: 'Feedback' });
    fireEvent.click(within(tray).getByRole('checkbox', { name: 'Send comment 2' }));
    fireEvent.click(within(tray).getByRole('button', { name: 'Send 1 to agent' }));
    await waitFor(() => expect(calls('agents.send')).toHaveLength(1));
    const text = (calls('agents.send')[0]!.message as { text: string }).text;
    expect(text).toBe('Feedback on the preview of Pricing page (v3):\n\n1. index.html › `main > h2` ("Pricing that scales"): Make this heading smaller and left-aligned.\n\nChange the artifact to address this point.');
    expect(text).not.toContain('Drop this paragraph');
    // The sent one is gone; the unticked one stays for later.
    await waitFor(() => expect(useArtifactFeedback.getState().pins['a-site']?.map((p) => p.comment)).toEqual(['Drop this paragraph.']));
    expect(calls('telemetry.track')).toContainEqual({ type: 'event', name: 'artifact_agent_message', props: { kind: 'design', feedback: 1, has_text: false } });
  });

  it('starts the agent with the comments when there is none yet', async () => {
    const { viewer, frame } = await commentOnDesign();
    post(picked(), frame.contentWindow);
    const form = await within(viewer).findByRole('dialog', { name: 'Comment on the preview' });
    fireEvent.change(within(form).getByLabelText('What should change here?'), { target: { value: 'Bigger.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    fireEvent.change(within(panel()).getByLabelText('Message a new agent for this artifact'), { target: { value: 'Keep the colours.' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send 1 to agent' }));
    await waitFor(() => expect(calls('artifacts.startAgent')).toHaveLength(1));
    expect(calls('artifacts.startAgent')[0]!.text).toBe('Feedback on the preview of Pricing page (v3):\n\n1. index.html › `main > h2` ("Pricing that scales"): Bigger.\n\nKeep the colours.\n\nChange the artifact to address this point.');
  });

  it('turns Comment off with Esc from the frame', async () => {
    const { viewer, frame } = await commentOnDesign();
    post({ type: 'oide-pick-cancel' }, frame.contentWindow);
    expect(within(viewer).getByRole('button', { name: 'Comment' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('picks a block of a doc by click, with the heading above it, and marks it', async () => {
    const viewer = await open(/Retry design/);
    fireEvent.click(within(viewer).getByRole('button', { name: 'Comment' }));
    const region = within(viewer).getByRole('region', { name: 'Preview of Retry design' });
    fireEvent.click(within(region).getByText('Five attempts'));
    const form = await within(viewer).findByRole('dialog', { name: 'Comment on the preview' });
    expect(within(form).getByText('Under "Limits" › list item')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('What should change here?'), { target: { value: 'Say three.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(within(region).getByText('Five attempts').getAttribute('data-oide-pin')).toBe('1');
    const tray = within(panel()).getByRole('region', { name: 'Feedback' });
    expect(within(tray).getByText('Say three.')).toBeTruthy();
    fireEvent.click(within(tray).getByRole('button', { name: 'Remove comment 1' }));
    expect(within(panel()).queryByRole('region', { name: 'Feedback' })).toBeNull();
    expect(within(region).getByText('Five attempts').getAttribute('data-oide-pin')).toBeNull();
  });

  it('cannot comment on a design preview that main does not serve (no picker in srcdoc)', async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, input: unknown) => (command === 'artifacts.previewUrl' ? null : base(command, input)));
    const viewer = await open(/Pricing page/);
    const toggle = within(viewer).getByRole('button', { name: 'Comment' }) as HTMLButtonElement;
    await waitFor(() => expect(viewer.querySelector('iframe[srcdoc]')).toBeTruthy());
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    invoke.mockImplementation(base);
  });
});
