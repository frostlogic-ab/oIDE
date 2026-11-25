import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Commands, type AgentSummary, type CommandName, type CommandOutput } from '@oide/protocol';
import { settings } from './fixtures';
import { libraryHandlers } from './library';

/**
 * The dev mock's artifact retrieval (ADR 0014) behaves like main's contract: a link creates a
 * version-0 artifact and a Wall agent, an /artifact/ link fails with a reason, a claude.ai/design link
 * becomes a multi-file version, and the files commands read and write it.
 */
describe('mock artifacts: retrieval and files', () => {
  let agents: Map<string, AgentSummary>;
  let call: <K extends CommandName>(name: K, input: unknown) => Promise<CommandOutput<K>>;

  beforeEach(() => {
    vi.useFakeTimers();
    agents = new Map();
    const handlers = libraryHandlers({
      emit: () => {},
      getSettings: () => settings,
      setSettings: () => {},
      putAgent: (a) => agents.set(a.id, a),
    }) as Record<string, (i: unknown) => unknown>;
    call = async (name, input) => Commands[name].output.parse(await handlers[name]!(Commands[name].input.parse(input))) as CommandOutput<typeof name>;
  });
  afterEach(() => vi.useRealTimers());

  it('fails an /artifact/ link after a short while, with the reason and the agent', async () => {
    const m = await call('artifacts.importLink', { url: 'https://claude.ai/artifact/MyEmjmATV3mpUv6SZmFj4T', projectId: 'oide' });
    expect(m).toMatchObject({ version: 0, fileCount: 0, retrieval: { status: 'retrieving', trigger: 'import' } });
    expect(agents.get(m.retrieval!.agentId!)?.status).toBe('running');
    await expect(call('artifacts.refresh', { id: m.id })).rejects.toThrow(/\[busy\]/);
    await vi.advanceTimersByTimeAsync(5000);
    const { meta } = await call('artifacts.get', { id: m.id });
    expect(meta.retrieval).toMatchObject({ status: 'failed', error: expect.stringMatching(/no tool that can read claude\.ai artifact links/) });
    expect(agents.get(m.retrieval!.agentId!)?.status).toBe('error');
  });

  it('turns a claude.ai/design link into a multi-file version, then reads and writes its files', async () => {
    const m = await call('artifacts.importLink', { url: 'https://claude.ai/design/p/oide-site', projectId: 'oide' });
    await vi.advanceTimersByTimeAsync(5000);
    const { meta } = await call('artifacts.get', { id: m.id });
    expect(meta).toMatchObject({ version: 1, entry: 'index.html', fileCount: 9, title: 'oIDE site', retrieval: { status: 'ready' } });
    const files = await call('artifacts.files', { id: m.id });
    expect(files.find((f) => f.path === 'shots/home.png')).toMatchObject({ text: false });
    expect(await call('artifacts.readFile', { id: m.id, path: 'site.css' })).toMatchObject({ encoding: 'utf8' });

    const next = await call('artifacts.writeFiles', { id: m.id, files: [{ path: 'site.css', encoding: 'utf8', data: 'x' }], entry: 'about.html', baseVersion: 1 });
    expect(next).toMatchObject({ version: 2, entry: 'about.html', fileCount: 9 });
    await expect(call('artifacts.writeFiles', { id: m.id, entry: 'index.html', baseVersion: 1 })).rejects.toThrow(/\[conflict\]/);

    // Restore brings back every file and the entry of that version, as a new version.
    const back = await call('artifacts.restore', { id: m.id, version: 1, baseVersion: 2 });
    expect(back).toMatchObject({ version: 3, entry: 'index.html', fileCount: 9 });
    expect(await call('artifacts.readFile', { id: m.id, path: 'site.css' })).not.toMatchObject({ data: 'x' });
    await expect(call('artifacts.restore', { id: m.id, version: 1, baseVersion: 2 })).rejects.toThrow(/\[conflict\]/);
  });

  it('asks for a project to refresh an artifact that has none, and cancels a running retrieval', async () => {
    const m = await call('artifacts.importFiles', { filePaths: ['/x/index.html', '/x/site.css'], url: 'https://claude.ai/design/p/x', location: 'app-data' });
    expect(m).toMatchObject({ kind: 'design', entry: 'index.html', fileCount: 2, importedFrom: 'https://claude.ai/design/p/x' });
    await expect(call('artifacts.refresh', { id: m.id })).rejects.toThrow(/\[needs_project\]/);
    const r = await call('artifacts.refresh', { id: m.id, projectId: 'oide' });
    expect(r.retrieval).toMatchObject({ status: 'retrieving', trigger: 'update' });
    const c = await call('artifacts.cancelRetrieval', { id: m.id });
    expect(c.retrieval).toMatchObject({ status: 'failed', error: 'Cancelled.' });
    expect(c.version).toBe(1);
  });
});
