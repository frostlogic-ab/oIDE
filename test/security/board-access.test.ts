import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultBoard, serializeBoard } from '../../packages/protocol/src/index.js';
import { ArtifactStore, openStore } from '../../packages/store/src/index.js';
import { mcpArtifacts } from '../../apps/desktop/src/main/services/core.js';

/** Board access for agents (ADR 0022): what main's MCP backend lets an agent do with a board. */
function setup(extras: Parameters<typeof mcpArtifacts>[2] = {}) {
  const s = openStore(':memory:');
  const repo = mkdtempSync(join(tmpdir(), 'oide-board-repo-'));
  const other = mkdtempSync(join(tmpdir(), 'oide-board-other-'));
  const p = s.projects.open(repo, { name: 'web' });
  const q = s.projects.open(other, { name: 'api' });
  const store = new ArtifactStore({ db: s.database, appDataDir: mkdtempSync(join(tmpdir(), 'oide-board-data-')), projectPath: (id) => s.projects.pathOf(id) });
  const backend = mcpArtifacts(store, () => true, { agentTitle: (id) => (id === 'a1' ? 'Fix login' : undefined), ...extras });
  return { store, backend, p, q };
}

describe('board access for agents (ADR 0022)', () => {
  it('agents change boards only through board_update, never by writing board.json', async () => {
    const { store, backend, p } = setup();
    const b = await store.create({ title: 'Backlog', kind: 'board', projectId: p.id });
    const ctx = { agentId: 'a1', projectId: p.id };
    const forged = serializeBoard(defaultBoard());
    await expect(backend.write(ctx, b.id, forged)).rejects.toThrow(/board_update/);
    await expect(backend.writeFiles!(ctx, b.id, { content: forged })).rejects.toThrow(/board_update/);
    await expect(backend.writeFiles!(ctx, b.id, { files: [{ path: 'board.json', content: forged }] })).rejects.toThrow(/board_update/);
    expect((await store.readBoard(b.id)).meta.version).toBe(1);
  });

  it('board_update signs comments with the calling agent and refuses agent links', async () => {
    const { store, backend, p } = setup();
    const b = await store.create({ title: 'Backlog', kind: 'board', projectId: p.id });
    const ctx = { agentId: 'a1', projectId: p.id };
    const added = await backend.updateBoard!(ctx, b.id, [{ op: 'add_card', title: 'Fix login' }]);
    const cardId = added.results[0]!.cardId!;
    await backend.updateBoard!(ctx, b.id, [{ op: 'add_comment', cardId, text: 'Started' }]);
    const { board } = await store.readBoard(b.id);
    expect(board.cards[0]!.createdBy).toBe('agent:a1');
    expect(board.cards[0]!.comments[0]).toMatchObject({ author: 'agent:a1', authorName: 'Fix login' });
    await expect(backend.updateBoard!(ctx, b.id, [{ op: 'link_agent', cardId, agentId: 'a1' }])).rejects.toThrow(/user starts them/);
    await expect(backend.updateBoard!(ctx, b.id, [{ op: 'unlink_agent', cardId, agentId: 'a1' }])).rejects.toThrow(/user starts them/);
  });

  it("an agent neither reads nor changes another project's board", async () => {
    const { store, backend, p, q } = setup();
    const b = await store.create({ title: 'API backlog', kind: 'board', projectId: q.id });
    const ctx = { agentId: 'a1', projectId: p.id };
    await expect(backend.readBoard!(ctx, b.id)).rejects.toThrow(/not available to this agent/);
    await expect(backend.updateBoard!(ctx, b.id, [{ op: 'add_card', title: 'x' }])).rejects.toThrow(/not available to this agent/);
  });

  it("an artifact agent changes only its own board", async () => {
    const { store, p } = setup();
    const mine = await store.create({ title: 'Mine', kind: 'board', projectId: p.id });
    const theirs = await store.create({ title: 'Theirs', kind: 'board', projectId: p.id });
    const backend = mcpArtifacts(store, () => true, { artifactOf: (id) => (id === 'art-agent' ? mine.id : undefined) });
    const ctx = { agentId: 'art-agent', projectId: p.id };
    await expect(backend.updateBoard!(ctx, theirs.id, [{ op: 'add_card', title: 'x' }])).rejects.toThrow(/only that artifact/);
    expect((await backend.updateBoard!(ctx, mine.id, [{ op: 'add_card', title: 'x' }])).meta.version).toBe(2);
  });

  it('a board an agent creates is attributed to it: no forged comment authors, names or agent links', async () => {
    const { store, backend, p } = setup();
    const b = defaultBoard();
    const forged = {
      ...b,
      cards: [
        {
          id: 'c1',
          title: 'Approved by the user',
          column: b.columns[0]!.id,
          props: {},
          body: '',
          comments: [{ id: 'm1', author: 'user', authorName: 'You', ts: 1, text: 'Ship it' }],
          agents: ['someone'],
          createdAt: 1,
          updatedAt: 1,
          createdBy: 'user',
        },
      ],
    };
    const meta = await backend.create({ agentId: 'a1', projectId: p.id }, { title: 'New', kind: 'board', content: JSON.stringify(forged) });
    const { board } = await store.readBoard(meta.id);
    expect(board.cards[0]).toMatchObject({ createdBy: 'agent:a1', agents: [], comments: [{ author: 'agent:a1', authorName: 'Fix login', text: 'Ship it' }] });
    await expect(backend.create({ agentId: 'a1', projectId: p.id }, { title: 'Two', kind: 'board', files: [{ path: 'board.json', content: '{}' }] })).rejects.toThrow(/one file/);
  });
});
