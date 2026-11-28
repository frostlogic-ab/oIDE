/**
 * Pure helpers for kanban boards (artifact kind `board`, ADR 0022): colours on the dark UI, the chips a
 * card shows, search, and the goal an agent started from a card gets. No React, no bridge.
 */
import { applyBoardOps, displayValue, type BoardCard, type BoardPropertyType, type BoardColor, type BoardColumn, type BoardProperty, type KanbanBoard } from '@oide/protocol';

/**
 * Base hues on the oIDE palette: gray, yellow, green, blue, purple and red are design tokens (ink-3,
 * warn, ok, accent, the violet accent option, bad); brown, orange and pink are board-only hues of the
 * same lightness (design-system.md › Board colours). Chips and column headers use the hue as text on a
 * ~15% tint of itself over the dark surface (at least 4.5:1).
 */
export const BOARD_HUE: Record<BoardColor, string> = {
  gray: '#9AA3AE',
  brown: '#C4A484',
  orange: '#EDA86A',
  yellow: '#F2C078',
  green: '#7FC8A9',
  blue: '#7AA2F7',
  purple: '#C4A7E7',
  pink: '#E79AC0',
  red: '#F08A8A',
};

export const COLOR_LABEL: Record<BoardColor, string> = {
  gray: 'Gray',
  brown: 'Brown',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
};

/** Inline styles for a coloured chip or column label. */
export function chipStyle(color: BoardColor): { color: string; background: string; borderColor: string } {
  const hue = BOARD_HUE[color];
  return { color: hue, background: `${hue}26`, borderColor: `${hue}40` };
}

/** A column's lane background: a faint tint of its colour. */
export function laneStyle(color: BoardColor): { background: string } {
  return { background: `${BOARD_HUE[color]}0D` };
}

/** A card in a column: the card surface with a little of the column's colour. */
export function cardStyle(color: BoardColor): { background: string } {
  return { background: `color-mix(in srgb, ${BOARD_HUE[color]} 7%, var(--color-card))` };
}

export const PROPERTY_TYPE_LABEL: Record<BoardProperty['type'], string> = {
  select: 'Select',
  multi_select: 'Multi-select',
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  url: 'Link',
};

export interface Chip {
  key: string;
  label: string;
  /** Option colour; plain chips (text, numbers, dates) have none. */
  color?: BoardColor;
  /** "Priority: P1", for screen readers and the tooltip. */
  title: string;
}

/** The chips a card shows: every property marked "show on card" that has a value, in property order. */
export function cardChips(board: KanbanBoard, card: BoardCard): Chip[] {
  const out: Chip[] = [];
  for (const p of board.properties) {
    if (!p.showOnCard) continue;
    const v = card.props[p.id];
    if (v === undefined) continue;
    if (p.type === 'select' || p.type === 'multi_select') {
      for (const id of Array.isArray(v) ? v : [String(v)]) {
        const o = p.options?.find((x) => x.id === id);
        if (o) out.push({ key: `${p.id}:${o.id}`, label: o.name, color: o.color, title: `${p.name}: ${o.name}` });
      }
    } else if (p.type === 'checkbox') {
      if (v === true) out.push({ key: p.id, label: p.name, title: `${p.name}: yes` });
    } else {
      const text = String(v);
      out.push({ key: p.id, label: text.length > 40 ? `${text.slice(0, 39)}…` : text, title: `${p.name}: ${text}` });
    }
  }
  return out;
}

/** Cards of each column, in board order. */
export function cardsByColumn(board: KanbanBoard, cards: readonly BoardCard[] = board.cards): Map<string, BoardCard[]> {
  const m = new Map<string, BoardCard[]>(board.columns.map((c) => [c.id, []]));
  for (const c of cards) m.get(c.column)?.push(c);
  return m;
}

/** Cards matching a search: the title, the body and property values (case-insensitive). */
export function filterCards(board: KanbanBoard, query: string): BoardCard[] {
  const q = query.trim().toLowerCase();
  if (!q) return board.cards;
  return board.cards.filter((c) => {
    if (c.title.toLowerCase().includes(q) || c.body.toLowerCase().includes(q)) return true;
    return board.properties.some((p) => {
      const v = displayValue(p, c.props[p.id]);
      return v !== undefined && String(Array.isArray(v) ? v.join(' ') : v).toLowerCase().includes(q);
    });
  });
}

/** A column whose name says work is going on, under review, or done (for an agent's instructions). */
function columnLike(columns: readonly BoardColumn[], re: RegExp): BoardColumn | undefined {
  return columns.find((c) => re.test(c.name));
}

/** Biggest goal a card hands to Spawn (the protocol allows 100 000 characters). */
const MAX_GOAL = 60_000;

/**
 * The goal of an agent started from a card ("Start an agent"): the ticket (title, properties, body,
 * the latest comments) and how to keep the card up to date with the board tools.
 */
export function goalForCard(board: KanbanBoard, card: BoardCard, ids: { boardId: string; boardTitle: string }): string {
  const props = board.properties
    .map((p) => {
      const v = displayValue(p, card.props[p.id]);
      return v === undefined ? null : `${p.name}: ${Array.isArray(v) ? v.join(', ') : String(v)}`;
    })
    .filter((x): x is string => x !== null);
  const doing = columnLike(board.columns, /progress|doing|working|started/i);
  const review = columnLike(board.columns, /review|qa|testing/i);
  const comments = card.comments.slice(-5).map((m) => `- ${m.authorName ?? (m.author === 'user' ? 'User' : m.author)}: ${m.text}`);
  const ticket = [`# ${card.title}`, props.length ? props.join(' · ') : '', card.body.trim(), comments.length ? `Latest comments:\n${comments.join('\n')}` : '']
    .filter(Boolean)
    .join('\n\n');
  const steps = [
    `This task is a ticket on the oIDE kanban board "${ids.boardTitle}" (board id ${ids.boardId}, card id ${card.id}). Read the card in full with mcp__oide__board_read {"id":"${ids.boardId}","cardId":"${card.id}"}.`,
    doing ? `When you start, move the card to "${doing.name}" with mcp__oide__board_update (op move_card).` : 'When you start, move the card to the column that means work is in progress with mcp__oide__board_update (op move_card), if there is one.',
    `When you finish, add a comment on the card (op add_comment) with what you did${review ? `, and move it to "${review.name}" when you submit for review` : ''}.`,
  ];
  const text = `${ticket}\n\n---\n${steps.join('\n')}`;
  return text.length > MAX_GOAL ? `${ticket.slice(0, MAX_GOAL - 2000)}\n\n[…the card is longer: read it with board_read]\n\n---\n${steps.join('\n')}` : text;
}

/**
 * How many cards would lose all or part of their value if `property` became `to` (a dry run of the
 * same conversion main does). 0 when nothing is lost or the change can't apply.
 */
export function typeChangeLoss(board: KanbanBoard, propertyId: string, to: BoardPropertyType): number {
  let after: KanbanBoard;
  try {
    after = applyBoardOps(board, [{ op: 'update_property', property: propertyId, type: to }], { author: 'user' }).board;
  } catch {
    return 0;
  }
  let lost = 0;
  board.cards.forEach((c, i) => {
    const was = c.props[propertyId];
    const now = after.cards[i]?.props[propertyId];
    if (was === undefined) return;
    if (now === undefined || (Array.isArray(was) && (Array.isArray(now) ? now.length : 1) < was.length)) lost++;
  });
  return lost;
}

/** The index a dragged card lands at in a column, from the pointer's Y and the cards' boxes. */
export function dropIndex(pointerY: number, boxes: ReadonlyArray<{ top: number; height: number }>): number {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    if (pointerY < b.top + b.height / 2) return i;
  }
  return boxes.length;
}
