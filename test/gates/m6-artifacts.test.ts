import { describe, expect, it } from 'vitest';
import { makeRepo } from '../integration/harness.js';
import { driveTo, gateHarness, single, track, useGateCleanup } from './helpers.js';

/**
 * M6 gate: "An agent reads a design artifact and writes a doc artifact the user then edits."
 *
 * The design goes to the agent as a Spawn context chip (and, for a second agent, through "Give to
 * an agent"). fake-claude's `artifacts` scenario calls oIDE's MCP tools `mcp__oide__artifacts_read`
 * (pre-allowed) and `mcp__oide__artifacts_create` (asks first), over the agent's real MCP endpoint.
 * Then: "Agents using it" on both artifacts, and the user's `artifacts.save` makes version 2.
 */

useGateCleanup();

const DESIGN = '<!doctype html><title>Landing</title><h1>Hero</h1><h2>Pricing</h2><h2>FAQ</h2>';

describe('M6 gate: design artifact → agent → doc artifact → user edit', { timeout: 60_000 }, () => {
  it('reads the design, writes a doc, shows Agents using it, and the user edit is version 2', async () => {
    const repo = makeRepo();
    track(repo);
    const h = await gateHarness();
    await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario artifacts' } } });
    const project = (await h.call('projects.open', { path: repo }))!;
    const design = await h.call('artifacts.create', {
      title: 'Landing page',
      kind: 'design',
      projectId: project.id,
      content: DESIGN,
    });
    expect(design.version).toBe(1);

    const [spawned] = await h.call('agents.spawn', {
      projectId: project.id,
      title: 'Doc writer',
      goal: 'Write a doc that lists the sections of the design.',
      context: [{ kind: 'artifact', id: design.id, title: design.title }],
      mode: 'default',
      strategy: single,
    });
    const { agent, prompts } = await driveTo(h, spawned!.id, 'has-question');
    // artifacts_read is pre-allowed; creating an artifact asks first.
    expect(prompts.map((p) => p.toolName)).toEqual(['mcp__oide__artifacts_create']);

    // The first message named the artifact and how to read it.
    const events = await h.call('agents.events', { agentId: agent.id, limit: 500 });
    const first = events.find((e) => e.type === 'user-text');
    expect(first?.type === 'user-text' && first.text).toContain(
      `mcp__oide__artifacts_read tool using {"id":"${design.id}"}`,
    );
    const reads = events.filter((e) => e.type === 'tool-use' && e.name === 'mcp__oide__artifacts_read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ input: { id: design.id } });

    // The doc artifact exists, in the project, authored by the agent, built from the design.
    const docs = await h.call('artifacts.list', { projectId: project.id, kind: 'doc' });
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc).toMatchObject({
      title: 'Notes on Landing page',
      kind: 'doc',
      projectId: project.id,
      version: 1,
      location: 'app-data',
    });
    const got = await h.call('artifacts.get', { id: doc.id });
    // The store adds a front-matter header to docs; the body is what the agent wrote.
    expect(got.content).toContain(
      '# Notes on Landing page\n\nSections in the design:\n- Hero\n- Pricing\n- FAQ\n',
    );
    expect(got.versions).toEqual([expect.objectContaining({ version: 1, author: `agent:${agent.id}` })]);
    const reply = events.filter((e) => e.type === 'assistant-text').at(-1);
    expect(reply?.type === 'assistant-text' && reply.text).toBe(
      `Read "Landing page" and wrote the doc artifact ${doc.id}.`,
    );

    // "Agents using it".
    const uses = await h.call('artifacts.uses', { ids: [design.id, doc.id] });
    expect(uses[design.id]).toEqual([expect.objectContaining({ agentId: agent.id, op: 'read' })]);
    expect(uses[doc.id]).toEqual([expect.objectContaining({ agentId: agent.id, op: 'create' })]);
    expect((await h.call('artifacts.get', { id: design.id })).uses.map((u) => u.agentId)).toEqual([agent.id]);
    expect(h.eventsOf('artifacts.changed').some((e) => e.id === doc.id)).toBe(true);

    // The user edits the doc: version 2, by the user; version 1 is still the agent's.
    const edited = `${got.content}\nEdited by the user.\n`;
    const saved = await h.call('artifacts.save', {
      id: doc.id,
      content: edited,
      note: 'Tightened the wording',
    });
    expect(saved.version).toBe(2);
    const after = await h.call('artifacts.get', { id: doc.id });
    expect(after.content).toBe(edited);
    // History lists the newest version first.
    expect(after.versions.map((v) => [v.version, v.author])).toEqual([
      [2, 'user'],
      [1, `agent:${agent.id}`],
    ]);
    expect(after.versions[0]!.note).toBe('Tightened the wording');
    expect((await h.call('artifacts.readVersion', { id: doc.id, version: 1 })).content).toBe(got.content);
    // The design itself was only read.
    expect((await h.call('artifacts.get', { id: design.id })).meta.version).toBe(1);
  });

  it('"Give to an agent" on a running agent reaches the same tools', async () => {
    const repo = makeRepo();
    track(repo);
    const h = await gateHarness();
    await h.call('settings.update', { patch: { claude: { extraFlags: '--fake-scenario basic,artifacts' } } });
    const project = (await h.call('projects.open', { path: repo }))!;
    const design = await h.call('artifacts.create', {
      title: 'Settings screen',
      kind: 'design',
      projectId: project.id,
      content: '<h1>General</h1>',
    });
    const [spawned] = await h.call('agents.spawn', {
      projectId: project.id,
      title: 'Helper',
      goal: 'Say hi',
      mode: 'default',
      strategy: single,
    });
    await driveTo(h, spawned!.id, 'has-question');
    await h.call('agents.send', {
      agentId: spawned!.id,
      message: { kind: 'artifact', artifactId: design.id, note: 'Write notes on it.' },
    });
    const docsNow = () => h.call('artifacts.list', { projectId: project.id, kind: 'doc' });
    const { prompts } = await driveTo(
      h,
      spawned!.id,
      async (a) => a.status === 'has-question' && (await docsNow()).length > 0,
    );
    expect(prompts.map((p) => p.toolName)).toEqual(['mcp__oide__artifacts_create']);
    const docs = await docsNow();
    expect(docs.map((d) => d.title)).toEqual(['Notes on Settings screen']);
    expect((await h.call('artifacts.uses', { ids: [design.id] }))[design.id]).toEqual([
      expect.objectContaining({ agentId: spawned!.id, op: 'read' }),
    ]);
  });
});
