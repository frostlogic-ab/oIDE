import { describe, expect, it } from 'vitest';
import {
  applyBoardOps,
  boardForAgent,
  boardOpsArea,
  BoardOpError,
  BoardOps,
  checkBoard,
  defaultBoard,
  describeBoardOps,
  isBoardContent,
  parseBoard,
  serializeBoard,
  type BoardOp,
  type KanbanBoard,
} from './board.js';

function ids() {
  let n = 0;
  return (p: string) => `${p}_${++n}`;
}

function setup() {
  const newId = ids();
  const board = defaultBoard(newId);
  let t = 1000;
  const ctx = { author: 'user', newId, now: () => (t += 1) };
  const run = (b: KanbanBoard, ops: BoardOp[], c: Partial<typeof ctx> & { authorName?: string } = {}) => applyBoardOps(b, ops, { ...ctx, ...c });
  return { board, run };
}

const col = (b: KanbanBoard, name: string) => b.columns.find((c) => c.name === name)!;
const prop = (b: KanbanBoard, name: string) => b.properties.find((p) => p.name === name)!;
const inColumn = (b: KanbanBoard, name: string) => b.cards.filter((c) => c.column === col(b, name).id).map((c) => c.title);

describe('kanban boards: the default board', () => {
  it('is a product backlog that parses, with columns, properties and no cards', () => {
    const b = defaultBoard();
    expect(b.columns.map((c) => c.name)).toEqual(['Proposed', 'Approved', 'In progress', 'In review', 'Shipped', "Won't do"]);
    expect(b.properties.map((p) => p.name)).toEqual(['Priority', 'Effort', 'Type']);
    expect(b.cards).toEqual([]);
    expect(parseBoard(serializeBoard(b))).toEqual(b);
    expect(isBoardContent(serializeBoard(b))).toBe(true);
  });
});

describe('kanban boards: card operations', () => {
  it('adds cards (first column by default, by column name, at an index) with properties by name', () => {
    const { board, run } = setup();
    const r = run(board, [
      { op: 'add_card', title: 'A' },
      { op: 'add_card', title: 'B', column: 'in progress', props: { Priority: 'P1', Type: 'Fix' }, body: '# Spec' },
      { op: 'add_card', title: 'C', column: 'Proposed', index: 0 },
    ]);
    expect(inColumn(r.board, 'Proposed')).toEqual(['C', 'A']);
    const b = r.board.cards.find((c) => c.title === 'B')!;
    expect(b.column).toBe(col(r.board, 'In progress').id);
    expect(b.body).toBe('# Spec');
    expect(b.createdBy).toBe('user');
    const priority = prop(r.board, 'Priority');
    expect(b.props[priority.id]).toBe(priority.options!.find((o) => o.name === 'P1')!.id);
    expect(r.results[0]).toMatchObject({ op: 'add_card', cardId: expect.any(String), columnId: col(r.board, 'Proposed').id });
  });

  it('moves cards between and within columns, keeping the others in order', () => {
    const { board, run } = setup();
    const { board: b1, results } = run(board, [
      { op: 'add_card', title: 'A' },
      { op: 'add_card', title: 'B' },
      { op: 'add_card', title: 'C' },
    ]);
    const [a, , c] = results.map((r) => r.cardId!);
    const b2 = run(b1, [{ op: 'move_card', cardId: c!, column: 'Proposed', index: 0 }]).board;
    expect(inColumn(b2, 'Proposed')).toEqual(['C', 'A', 'B']);
    const b3 = run(b2, [{ op: 'move_card', cardId: a!, column: 'Shipped' }]).board;
    expect(inColumn(b3, 'Proposed')).toEqual(['C', 'B']);
    expect(inColumn(b3, 'Shipped')).toEqual(['A']);
    // Index past the end goes to the bottom.
    const b4 = run(b3, [{ op: 'move_card', cardId: c!, column: 'Proposed', index: 99 }]).board;
    expect(inColumn(b4, 'Proposed')).toEqual(['B', 'C']);
  });

  it('updates title, body and properties; null clears; a new option name adds the option', () => {
    const { board, run } = setup();
    const { board: b1, results } = run(board, [{ op: 'add_card', title: 'A', props: { Priority: 'P0' } }]);
    const id = results[0]!.cardId!;
    const b2 = run(b1, [{ op: 'update_card', cardId: id, title: 'A2', body: 'text', props: { Priority: null, Type: 'Research' } }]).board;
    const card = b2.cards[0]!;
    expect(card.title).toBe('A2');
    expect(card.body).toBe('text');
    expect(card.props[prop(b2, 'Priority').id]).toBeUndefined();
    const type = prop(b2, 'Type');
    expect(type.options!.map((o) => o.name)).toContain('Research');
    expect(card.props[type.id]).toBe(type.options!.find((o) => o.name === 'Research')!.id);
  });

  it('checks values against the property type', () => {
    const { board, run } = setup();
    const b = run(board, [
      { op: 'add_property', name: 'Due', type: 'date' },
      { op: 'add_property', name: 'Points', type: 'number' },
      { op: 'add_property', name: 'Blocked', type: 'checkbox' },
      { op: 'add_property', name: 'Gates', type: 'multi_select', options: [{ name: 'CI' }] },
      { op: 'add_card', title: 'A' },
    ]).board;
    const id = b.cards[0]!.id;
    expect(() => run(b, [{ op: 'update_card', cardId: id, props: { Due: 'tomorrow' } }])).toThrow(/YYYY-MM-DD/);
    expect(() => run(b, [{ op: 'update_card', cardId: id, props: { Points: 'lots' } }])).toThrow(/number/);
    expect(() => run(b, [{ op: 'update_card', cardId: id, props: { Blocked: 'yes' } }])).toThrow(/true or false/);
    const ok = run(b, [{ op: 'update_card', cardId: id, props: { Due: '2026-12-01', Points: '3', Blocked: true, Gates: ['CI', 'Field check'] } }]).board;
    const c = ok.cards[0]!;
    expect(c.props[prop(ok, 'Due').id]).toBe('2026-12-01');
    expect(c.props[prop(ok, 'Points').id]).toBe(3);
    expect(c.props[prop(ok, 'Blocked').id]).toBe(true);
    expect(c.props[prop(ok, 'Gates').id]).toHaveLength(2);
    // Unchecking clears the value.
    expect(run(ok, [{ op: 'update_card', cardId: id, props: { Blocked: false } }]).board.cards[0]!.props[prop(ok, 'Blocked').id]).toBeUndefined();
  });

  it('comments carry their author; agents delete only their own', () => {
    const { board, run } = setup();
    const { board: b1, results } = run(board, [{ op: 'add_card', title: 'A' }]);
    const id = results[0]!.cardId!;
    const b2 = run(b1, [{ op: 'add_comment', cardId: id, text: 'Looks good' }]).board;
    const b3 = run(b2, [{ op: 'add_comment', cardId: id, text: 'Done' }], { author: 'agent:a1', authorName: 'Fix login' }).board;
    const [mine, theirs] = b3.cards[0]!.comments;
    expect(mine).toMatchObject({ author: 'user', text: 'Looks good' });
    expect(theirs).toMatchObject({ author: 'agent:a1', authorName: 'Fix login', text: 'Done' });
    expect(() => run(b3, [{ op: 'delete_comment', cardId: id, commentId: mine!.id }], { author: 'agent:a1' })).toThrow(/own comments/);
    expect(run(b3, [{ op: 'delete_comment', cardId: id, commentId: theirs!.id }], { author: 'agent:a1' }).board.cards[0]!.comments).toHaveLength(1);
    expect(run(b3, [{ op: 'delete_comment', cardId: id, commentId: theirs!.id }]).board.cards[0]!.comments).toHaveLength(1);
  });

  it('links agents (newest last, no duplicates) and unlinks them', () => {
    const { board, run } = setup();
    const { board: b1, results } = run(board, [{ op: 'add_card', title: 'A' }]);
    const id = results[0]!.cardId!;
    const b2 = run(b1, [
      { op: 'link_agent', cardId: id, agentId: 'a1' },
      { op: 'link_agent', cardId: id, agentId: 'a2' },
      { op: 'link_agent', cardId: id, agentId: 'a1' },
    ]).board;
    expect(b2.cards[0]!.agents).toEqual(['a2', 'a1']);
    expect(run(b2, [{ op: 'unlink_agent', cardId: id, agentId: 'a2' }]).board.cards[0]!.agents).toEqual(['a1']);
  });

  it('is all or nothing: one bad operation refuses the batch and leaves the board as it was', () => {
    const { board, run } = setup();
    const before = structuredClone(board);
    expect(() => run(board, [{ op: 'add_card', title: 'A' }, { op: 'move_card', cardId: 'c_nope', column: 'Shipped' }])).toThrow(BoardOpError);
    expect(board).toEqual(before);
    expect(() => run(board, [{ op: 'add_card', title: 'A', column: 'Nowhere' }])).toThrow(/No column "Nowhere". Columns: Proposed/);
  });
});

describe('kanban boards: columns and properties', () => {
  it('adds, renames, recolours, moves and deletes columns; names stay unique', () => {
    const { board, run } = setup();
    let b = run(board, [{ op: 'add_column', name: 'Blocked', color: 'red', index: 1 }]).board;
    expect(b.columns.map((c) => c.name).slice(0, 3)).toEqual(['Proposed', 'Blocked', 'Approved']);
    expect(() => run(b, [{ op: 'add_column', name: 'blocked' }])).toThrow(/already a column/);
    b = run(b, [{ op: 'update_column', column: 'Blocked', name: 'On hold', color: 'purple' }]).board;
    expect(col(b, 'On hold').color).toBe('purple');
    b = run(b, [{ op: 'move_column', column: 'On hold', index: 99 }]).board;
    expect(b.columns.at(-1)!.name).toBe('On hold');
    b = run(b, [{ op: 'delete_column', column: 'On hold' }]).board;
    expect(b.columns.some((c) => c.name === 'On hold')).toBe(false);
  });

  it('refuses to delete a column with cards unless they move, and never the last column', () => {
    const { board, run } = setup();
    const b = run(board, [{ op: 'add_card', title: 'A', column: 'Approved' }]).board;
    expect(() => run(b, [{ op: 'delete_column', column: 'Approved' }])).toThrow(/has 1 card/);
    const moved = run(b, [{ op: 'delete_column', column: 'Approved', moveCardsTo: 'Shipped' }]).board;
    expect(inColumn(moved, 'Shipped')).toEqual(['A']);
    let one = board;
    for (const c of board.columns.slice(1)) one = run(one, [{ op: 'delete_column', column: c.id }]).board;
    expect(() => run(one, [{ op: 'delete_column', column: one.columns[0]!.id }])).toThrow(/at least one column/);
  });

  it('deleting a property or an option clears its values on every card', () => {
    const { board, run } = setup();
    const b = run(board, [
      { op: 'add_property', name: 'Gates', type: 'multi_select', options: [{ name: 'CI', color: 'gray' }, { name: 'Field' }] },
      { op: 'add_card', title: 'A', props: { Priority: 'P1', Gates: ['CI', 'Field'] } },
      { op: 'add_card', title: 'B', props: { Gates: ['CI'] } },
    ]).board;
    const gates = prop(b, 'Gates');
    const noCi = run(b, [{ op: 'delete_option', property: 'Gates', option: 'CI' }]).board;
    expect(noCi.cards[0]!.props[gates.id]).toHaveLength(1);
    expect(noCi.cards[1]!.props[gates.id]).toBeUndefined();
    const noPriority = run(b, [{ op: 'delete_property', property: 'Priority' }]).board;
    expect(noPriority.properties.map((p) => p.name)).not.toContain('Priority');
    expect(() => checkBoard(noPriority)).not.toThrow();
  });

  it('options: add, rename, recolour; only select properties have them', () => {
    const { board, run } = setup();
    let b = run(board, [{ op: 'add_option', property: 'Effort', name: 'XL', color: 'red' }]).board;
    expect(prop(b, 'Effort').options!.at(-1)).toMatchObject({ name: 'XL', color: 'red' });
    b = run(b, [{ op: 'update_option', property: 'Effort', option: 'XL', name: 'Huge', color: 'pink' }]).board;
    expect(prop(b, 'Effort').options!.at(-1)).toMatchObject({ name: 'Huge', color: 'pink' });
    const t = run(b, [{ op: 'add_property', name: 'Notes', type: 'text' }]).board;
    expect(() => run(t, [{ op: 'add_option', property: 'Notes', name: 'x' }])).toThrow(/not a select/);
    expect(() => run(t, [{ op: 'add_property', name: 'Owner', type: 'text', options: [{ name: 'x' }] }])).toThrow(/Only select/);
    const moved = run(t, [{ op: 'move_property', property: 'Notes', index: 0 }, { op: 'update_property', property: 'Notes', name: 'Remarks', showOnCard: false }]).board;
    expect(moved.properties[0]).toMatchObject({ name: 'Remarks', showOnCard: false });
  });
});

describe('kanban boards: changing a property type', () => {
  it('select ↔ multi-select keep options; text becomes options; select becomes text; what cannot convert is cleared', () => {
    const { board, run } = setup();
    let b = run(board, [
      { op: 'add_property', name: 'Owner', type: 'text' },
      { op: 'add_card', title: 'A', props: { Priority: 'P1', Owner: 'Ana' } },
      { op: 'add_card', title: 'B', props: { Owner: 'Ben' } },
    ]).board;
    b = run(b, [{ op: 'update_property', property: 'Priority', type: 'multi_select' }]).board;
    const pri = prop(b, 'Priority');
    expect(pri.type).toBe('multi_select');
    expect(b.cards[0]!.props[pri.id]).toEqual([pri.options!.find((o) => o.name === 'P1')!.id]);
    b = run(b, [{ op: 'update_property', property: 'Owner', type: 'select' }]).board;
    const owner = prop(b, 'Owner');
    expect(owner.options!.map((o) => o.name)).toEqual(['Ana', 'Ben']);
    expect(b.cards[1]!.props[owner.id]).toBe(owner.options![1]!.id);
    b = run(b, [{ op: 'update_property', property: 'Priority', type: 'text' }]).board;
    expect(prop(b, 'Priority').options).toBeUndefined();
    expect(b.cards[0]!.props[pri.id]).toBe('P1');
    b = run(b, [{ op: 'update_property', property: 'Priority', type: 'number' }]).board;
    expect(b.cards[0]!.props[pri.id]).toBeUndefined();
    expect(() => checkBoard(b)).not.toThrow();
  });
});

describe('kanban boards: parsing and integrity', () => {
  it('refuses ids that name object machinery (__proto__, constructor, prototype)', () => {
    const b = defaultBoard();
    const evil = { ...b, properties: [...b.properties, { id: '__proto__', name: 'Evil', type: 'text', showOnCard: true }] };
    expect(() => parseBoard(JSON.stringify(evil))).toThrow(/reserved/);
    expect(BoardOps.safeParse([{ op: 'move_card', cardId: 'constructor', column: 'x' }]).success).toBe(false);
  });

  it('refuses files that are not oIDE boards, with a reason', () => {
    expect(() => parseBoard('not json')).toThrow(/must be JSON/);
    expect(() => parseBoard('{"type":"excalidraw"}')).toThrow(/Not an oIDE board/);
    const b = defaultBoard();
    const dupe = { ...b, cards: [{ id: 'c1', title: 'A', column: 'nope', props: {}, body: '', comments: [], agents: [], createdAt: 1, updatedAt: 1 }] };
    expect(() => parseBoard(JSON.stringify(dupe))).toThrow(/unknown column/);
    const badValue = { ...b, cards: [{ id: 'c1', title: 'A', column: b.columns[0]!.id, props: { [b.properties[0]!.id]: 'o_unknown' }, body: '', comments: [], agents: [], createdAt: 1, updatedAt: 1 }] };
    expect(() => parseBoard(JSON.stringify(badValue))).toThrow(/not a valid select value/);
    const sameName = { ...b, columns: [...b.columns, { id: 'col_x', name: 'proposed', color: 'gray' }] };
    expect(() => parseBoard(JSON.stringify(sameName))).toThrow(/Two columns/);
  });

  it('the operation schema refuses unknown operations and empty batches', () => {
    expect(BoardOps.safeParse([]).success).toBe(false);
    expect(BoardOps.safeParse([{ op: 'drop_table' }]).success).toBe(false);
    expect(BoardOps.safeParse([{ op: 'add_card', title: '  ' }]).success).toBe(false);
    expect(BoardOps.safeParse([{ op: 'link_agent', cardId: 'c1', agentId: '../x' }]).success).toBe(false);
  });
});

describe('kanban boards: for agents, history and telemetry', () => {
  it('boardForAgent shows names, not ids; one card in full with its body and comments', () => {
    const { board, run } = setup();
    const { board: b, results } = run(board, [
      { op: 'add_card', title: 'A', column: 'Approved', props: { Priority: 'P2', Effort: 'M' }, body: 'spec' },
      { op: 'add_card', title: 'B' },
    ]);
    const id = results[0]!.cardId!;
    const withComment = run(b, [{ op: 'add_comment', cardId: id, text: 'hi' }]).board;
    const all = boardForAgent(withComment) as { cards: Array<Record<string, unknown>>; columns: Array<{ name: string; cards: number }> };
    expect(all.cards[0]).toMatchObject({ id, title: 'A', column: 'Approved', props: { Priority: 'P2', Effort: 'M' }, bodyChars: 4, comments: 1 });
    expect(all.columns.find((c) => c.name === 'Approved')!.cards).toBe(1);
    const one = boardForAgent(withComment, { cardId: id }) as Record<string, unknown>;
    expect(one).toMatchObject({ title: 'A', body: 'spec', comments: [expect.objectContaining({ text: 'hi', author: 'user' })] });
    expect((boardForAgent(withComment, { column: 'Proposed' }) as { cards: unknown[] }).cards).toHaveLength(1);
  });

  it('describes a batch for the version history', () => {
    const { board, run } = setup();
    const first = run(board, [{ op: 'add_card', title: 'Fix login' }]);
    const ops: BoardOp[] = [{ op: 'move_card', cardId: first.results[0]!.cardId!, column: 'In review' }];
    const second = run(first.board, ops);
    expect(describeBoardOps(first.board, second.board, ops, second.results)).toBe('Moved "Fix login" to In review');
    expect(describeBoardOps(board, first.board, [{ op: 'add_card', title: 'Fix login' }], first.results)).toBe('Added "Fix login" to Proposed');
  });

  it('boardOpsArea names what a batch is about, never its content', () => {
    expect(boardOpsArea([{ op: 'move_card', cardId: 'c1', column: 'x' }])).toBe('cards');
    expect(boardOpsArea([{ op: 'add_comment', cardId: 'c1', text: 'x' }])).toBe('comments');
    expect(boardOpsArea([{ op: 'add_column', name: 'x' }])).toBe('columns');
    expect(boardOpsArea([{ op: 'add_option', property: 'p', name: 'x' }])).toBe('properties');
    expect(boardOpsArea([{ op: 'link_agent', cardId: 'c1', agentId: 'a1' }])).toBe('agent_link');
    expect(boardOpsArea([{ op: 'add_column', name: 'x' }, { op: 'move_card', cardId: 'c1', column: 'x' }])).toBe('mixed');
  });
});
