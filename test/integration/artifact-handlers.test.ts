import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, startHarness, type Harness } from './harness.js';

/**
 * artifacts.* handlers (apps/desktop/src/main/handlers/artifacts.ts) through the real IPC router:
 * rename, delete, save with `baseVersion` (conflict), and the `artifacts.changed` payloads an open
 * editor relies on ("updated by <agent>").
 */

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.close().catch(() => undefined);
    cleanup(h.userData);
  }
});

async function harness(): Promise<Harness> {
  const h = await startHarness();
  open.push(h);
  return h;
}

describe('artifacts handlers', () => {
  it('rename: validates the title, keeps the version, emits renamed', async () => {
    const h = await harness();
    const art = await h.call('artifacts.create', { title: 'Retry notes', kind: 'doc', content: '# Retry\n' });
    const renamed = await h.call('artifacts.rename', { id: art.id, title: '  Webhook retry design ' });
    expect(renamed).toMatchObject({ id: art.id, title: 'Webhook retry design', version: 1, slug: art.slug });
    expect((await h.call('artifacts.list', {})).map((a) => a.title)).toEqual(['Webhook retry design']);
    expect(h.eventsOf('artifacts.changed').at(-1)).toEqual({ id: art.id, change: 'renamed', version: 1 });

    expect(await h.fails('artifacts.rename', { id: art.id, title: '   ' })).toBe('invalid_input');
    expect(await h.fails('artifacts.rename', { id: art.id, title: 'x'.repeat(201) })).toBe('invalid_input');
    expect(await h.fails('artifacts.rename', { id: 'missing', title: 'Title' })).toBe('not_found');
  });

  it('save with baseVersion: conflict after an agent write, then keep mine on top', async () => {
    const h = await harness();
    const art = await h.call('artifacts.create', { title: 'Plan', kind: 'doc', content: 'v1' });
    // An agent writes through the MCP backend while the editor holds v1.
    await h.services.artifacts.backend().write(art.id, 'agent text', 'agent-9');
    expect(h.eventsOf('artifacts.changed').at(-1)).toEqual({
      id: art.id,
      change: 'saved',
      version: 2,
      author: 'agent:agent-9',
    });

    expect(await h.fails('artifacts.save', { id: art.id, content: 'mine', baseVersion: 1 })).toBe('conflict');
    expect((await h.call('artifacts.get', { id: art.id })).content).toContain('agent text');

    const mine = await h.call('artifacts.save', {
      id: art.id,
      content: 'mine',
      baseVersion: 2,
      note: 'Edited by you over v2',
    });
    expect(mine.version).toBe(3);
    const detail = await h.call('artifacts.get', { id: art.id });
    expect(detail.versions.map((v) => `${v.version}:${v.author}`)).toEqual([
      '3:user',
      '2:agent:agent-9',
      '1:user',
    ]);
    expect((await h.call('artifacts.readVersion', { id: art.id, version: 2 })).content).toContain(
      'agent text',
    );

    // Without baseVersion a save still always succeeds (Restore, older callers).
    expect((await h.call('artifacts.save', { id: art.id, content: 'restored' })).version).toBe(4);
  });

  it('delete: gone from list and get, emits deleted, second delete is not_found', async () => {
    const h = await harness();
    const art = await h.call('artifacts.create', { title: 'Board', kind: 'whiteboard' });
    expect(await h.call('artifacts.delete', { id: art.id })).toEqual({ ok: true });
    expect(await h.call('artifacts.list', {})).toEqual([]);
    expect(await h.fails('artifacts.get', { id: art.id })).toBe('not_found');
    expect(h.eventsOf('artifacts.changed').at(-1)).toEqual({ id: art.id, change: 'deleted' });
    expect(await h.fails('artifacts.delete', { id: art.id })).toBe('not_found');
  });

  it('whiteboard saves must stay an Excalidraw JSON object', async () => {
    const h = await harness();
    const art = await h.call('artifacts.create', { title: 'Board', kind: 'whiteboard' });
    expect(await h.fails('artifacts.save', { id: art.id, content: '[1,2]', baseVersion: 1 })).toBe(
      'artifact_failed',
    );
    const scene = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [{ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
      appState: {},
      files: {},
    });
    expect((await h.call('artifacts.save', { id: art.id, content: scene, baseVersion: 1 })).version).toBe(2);
  });
});
