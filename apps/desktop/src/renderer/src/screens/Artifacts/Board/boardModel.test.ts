import { describe, expect, it } from 'vitest';
import { applyBoardOps, defaultBoard } from '@oide/protocol';
import { cardChips, cardsByColumn, dropIndex, filterCards, goalForCard, typeChangeLoss } from './boardModel';

function sample() {
  let n = 0;
  const newId = (p: string) => `${p}_${++n}`;
  const { board } = applyBoardOps(
    defaultBoard(newId),
    [
      { op: 'add_property', name: 'Due', type: 'date' },
      { op: 'add_property', name: 'Notes', type: 'text', showOnCard: false },
      { op: 'add_card', title: 'Fix login', column: 'Approved', props: { Priority: 'P1', Type: 'Fix', Due: '2026-12-01', Notes: 'secret' }, body: 'Users are logged out on reload.' },
      { op: 'add_card', title: 'Dark mode', props: { Priority: 'P3' } },
    ],
    { author: 'user', newId },
  );
  return board;
}

describe('board helpers', () => {
  it('cardChips: shown properties in order, option colours, plain chips for other types', () => {
    const b = sample();
    const chips = cardChips(b, b.cards[0]!);
    expect(chips.map((c) => c.label)).toEqual(['P1', 'Fix', '2026-12-01']);
    expect(chips[0]).toMatchObject({ color: 'orange', title: 'Priority: P1' });
    expect(chips[2]!.color).toBeUndefined();
  });

  it('cardsByColumn and filterCards (title, body and property values)', () => {
    const b = sample();
    const by = cardsByColumn(b);
    expect(by.get(b.columns[1]!.id)!.map((c) => c.title)).toEqual(['Fix login']);
    expect(filterCards(b, 'reload').map((c) => c.title)).toEqual(['Fix login']);
    expect(filterCards(b, 'p3').map((c) => c.title)).toEqual(['Dark mode']);
    expect(filterCards(b, '  ')).toHaveLength(2);
  });

  it('goalForCard: the ticket, then how to keep the card up to date on the board', () => {
    const b = sample();
    const goal = goalForCard(b, b.cards[0]!, { boardId: 'art-b', boardTitle: 'Backlog' });
    expect(goal).toMatch(/^# Fix login/);
    expect(goal).toContain('Priority: P1 · Type: Fix · Due: 2026-12-01 · Notes: secret');
    expect(goal).toContain('Users are logged out on reload.');
    expect(goal).toContain('board id art-b, card id');
    expect(goal).toContain('move the card to "In progress"');
    expect(goal).toContain('move it to "In review"');
  });

  it('typeChangeLoss counts the cards a type change would clear', () => {
    const b = sample();
    const priority = b.properties.find((p) => p.name === 'Priority')!;
    expect(typeChangeLoss(b, priority.id, 'multi_select')).toBe(0);
    expect(typeChangeLoss(b, priority.id, 'text')).toBe(0);
    expect(typeChangeLoss(b, priority.id, 'checkbox')).toBe(2);
  });

  it('dropIndex: before the first card whose middle is below the pointer', () => {
    const boxes = [
      { top: 0, height: 40 },
      { top: 50, height: 40 },
    ];
    expect(dropIndex(10, boxes)).toBe(0);
    expect(dropIndex(30, boxes)).toBe(1);
    expect(dropIndex(80, boxes)).toBe(2);
    expect(dropIndex(5, [])).toBe(0);
  });
});
