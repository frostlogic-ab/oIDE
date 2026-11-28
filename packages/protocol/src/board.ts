import { z } from 'zod';

/**
 * Kanban boards (artifact kind `board`, ADR 0022). A board is one JSON file (`board.json`) in an
 * artifact folder, so it gets versions, history, restore, repo sharing and the artifact agent like
 * every other artifact. Users and agents change it through the same operations (`BoardOp`), applied
 * by main under the artifact's lock (`applyBoardOps`): a drag in the UI and an agent's
 * `board_update` call are the same thing, and neither can lose the other's change.
 *
 * Everything is customisable, as in Notion: the columns (name, colour, order), the card properties
 * (select, multi-select, text, number, date, checkbox, link; options with colours) and which
 * properties show on the cards. Cards have a title, property values, a Markdown body, comments and
 * the oIDE agents working on them.
 */

export const BOARD_FILE = 'board.json';
export const BOARD_FORMAT = 'oide-board';

export const BOARD_LIMITS = {
  columns: 50,
  properties: 40,
  options: 100,
  cards: 2000,
  name: 100,
  title: 500,
  body: 50_000,
  text: 2000,
  comments: 200,
  comment: 5000,
  agents: 20,
  ops: 200,
} as const;

export const BOARD_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export const BoardColor = z.enum(BOARD_COLORS);
export type BoardColor = z.infer<typeof BoardColor>;

export const BOARD_PROPERTY_TYPES = ['select', 'multi_select', 'text', 'number', 'date', 'checkbox', 'url'] as const;
export const BoardPropertyType = z.enum(BOARD_PROPERTY_TYPES);
export type BoardPropertyType = z.infer<typeof BoardPropertyType>;

/** Names an object's own machinery: never an id (values are stored in plain objects keyed by id). */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const BoardId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ids are 1 to 64 letters, digits, - or _')
  .refine((s) => !RESERVED_IDS.has(s), 'This id is reserved');
const Name = z.string().trim().min(1).max(BOARD_LIMITS.name);
/** A calendar date, `YYYY-MM-DD`. */
const DateValue = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD');

export const BoardOption = z.object({ id: BoardId, name: Name, color: BoardColor });
export type BoardOption = z.infer<typeof BoardOption>;

export const BoardProperty = z.object({
  id: BoardId,
  name: Name,
  type: BoardPropertyType,
  /** Choices of a select or multi-select property, in display order. */
  options: z.array(BoardOption).max(BOARD_LIMITS.options).optional(),
  /** Shown as a chip on the card (always shown in the card's detail). */
  showOnCard: z.boolean().default(true),
});
export type BoardProperty = z.infer<typeof BoardProperty>;

export const BoardColumn = z.object({ id: BoardId, name: Name, color: BoardColor });
export type BoardColumn = z.infer<typeof BoardColumn>;

/** A property value: an option id (select), option ids (multi-select), text, a URL, a date, a number or a flag. */
export const BoardValue = z.union([z.string().max(BOARD_LIMITS.text), z.number().finite(), z.boolean(), z.array(BoardId).max(BOARD_LIMITS.options)]);
export type BoardValue = z.infer<typeof BoardValue>;

export const BoardComment = z.object({
  id: BoardId,
  /** `user`, or `agent:<agent id>`. */
  author: z.string().max(200),
  /** The agent's title when it wrote the comment (agents come and go; the comment stays readable). */
  authorName: z.string().max(200).optional(),
  ts: z.number(),
  text: z.string().min(1).max(BOARD_LIMITS.comment),
});
export type BoardComment = z.infer<typeof BoardComment>;

export const BoardCard = z.object({
  id: BoardId,
  title: z.string().max(BOARD_LIMITS.title),
  column: BoardId,
  /** Values by property id; a property with no value is left out. */
  props: z.record(BoardId, BoardValue).default({}),
  /** Markdown: the spec of the ticket. */
  body: z.string().max(BOARD_LIMITS.body).default(''),
  comments: z.array(BoardComment).max(BOARD_LIMITS.comments).default([]),
  /** oIDE agents started on this card (newest last). */
  agents: z.array(z.string().max(128)).max(BOARD_LIMITS.agents).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** `user` or `agent:<agent id>`. */
  createdBy: z.string().max(200).optional(),
});
export type BoardCard = z.infer<typeof BoardCard>;

export const KanbanBoard = z.object({
  type: z.literal(BOARD_FORMAT),
  version: z.literal(1),
  columns: z.array(BoardColumn).min(1).max(BOARD_LIMITS.columns),
  properties: z.array(BoardProperty).max(BOARD_LIMITS.properties),
  /** Cards in display order: a column shows its cards in this order. */
  cards: z.array(BoardCard).max(BOARD_LIMITS.cards),
});
export type KanbanBoard = z.infer<typeof KanbanBoard>;

/* ---------------------------------------------------------------- operations */

/** A column: its id or its name (case-insensitive). */
const ColumnRef = z.string().min(1).max(BOARD_LIMITS.name + 64);
/** A property: its id or its name (case-insensitive). */
const PropertyRef = z.string().min(1).max(BOARD_LIMITS.name + 64);
/**
 * What an operation sets a property to. Select: an option id or name (a new name adds the option).
 * Multi-select: an array of option ids or names (or one). Date: `YYYY-MM-DD`. null clears it.
 */
export const BoardValueInput = z.union([z.string().max(BOARD_LIMITS.text), z.number().finite(), z.boolean(), z.array(z.string().max(BOARD_LIMITS.name + 64)).max(BOARD_LIMITS.options), z.null()]);
export type BoardValueInput = z.infer<typeof BoardValueInput>;
const PropsInput = z.record(z.string().max(BOARD_LIMITS.name + 64), BoardValueInput);
const OptionInput = z.object({ name: Name, color: BoardColor.optional() });
const Index = z.number().int().nonnegative().max(100_000);

export const BoardOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_card'),
    title: z.string().trim().min(1).max(BOARD_LIMITS.title),
    /** Default: the first column. */
    column: ColumnRef.optional(),
    /** Position in the column (0 = top). Default: the bottom. */
    index: Index.optional(),
    props: PropsInput.optional(),
    body: z.string().max(BOARD_LIMITS.body).optional(),
  }),
  z.object({
    op: z.literal('update_card'),
    cardId: BoardId,
    title: z.string().trim().min(1).max(BOARD_LIMITS.title).optional(),
    body: z.string().max(BOARD_LIMITS.body).optional(),
    /** Only the properties named change; null clears one. */
    props: PropsInput.optional(),
  }),
  z.object({ op: z.literal('move_card'), cardId: BoardId, column: ColumnRef, index: Index.optional() }),
  z.object({ op: z.literal('delete_card'), cardId: BoardId }),
  z.object({ op: z.literal('add_comment'), cardId: BoardId, text: z.string().trim().min(1).max(BOARD_LIMITS.comment) }),
  z.object({ op: z.literal('delete_comment'), cardId: BoardId, commentId: BoardId }),
  z.object({ op: z.literal('link_agent'), cardId: BoardId, agentId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/) }),
  z.object({ op: z.literal('unlink_agent'), cardId: BoardId, agentId: z.string().min(1).max(128) }),
  z.object({ op: z.literal('add_column'), name: Name, color: BoardColor.optional(), index: Index.optional() }),
  z.object({ op: z.literal('update_column'), column: ColumnRef, name: Name.optional(), color: BoardColor.optional() }),
  z.object({ op: z.literal('move_column'), column: ColumnRef, index: Index }),
  /** Its cards move to `moveCardsTo`; refused when it has cards and none is given. */
  z.object({ op: z.literal('delete_column'), column: ColumnRef, moveCardsTo: ColumnRef.optional() }),
  z.object({
    op: z.literal('add_property'),
    name: Name,
    type: BoardPropertyType,
    options: z.array(OptionInput).max(BOARD_LIMITS.options).optional(),
    showOnCard: z.boolean().optional(),
    index: Index.optional(),
  }),
  /** A new `type` converts every card's value (see `convertProperty`); values that can't convert are cleared. */
  z.object({ op: z.literal('update_property'), property: PropertyRef, name: Name.optional(), type: BoardPropertyType.optional(), showOnCard: z.boolean().optional() }),
  z.object({ op: z.literal('move_property'), property: PropertyRef, index: Index }),
  /** Removes the property and its value on every card. */
  z.object({ op: z.literal('delete_property'), property: PropertyRef }),
  z.object({ op: z.literal('add_option'), property: PropertyRef, name: Name, color: BoardColor.optional() }),
  z.object({ op: z.literal('update_option'), property: PropertyRef, option: z.string().min(1).max(BOARD_LIMITS.name + 64), name: Name.optional(), color: BoardColor.optional() }),
  /** Removes the option and clears it on every card. */
  z.object({ op: z.literal('delete_option'), property: PropertyRef, option: z.string().min(1).max(BOARD_LIMITS.name + 64) }),
]);
export type BoardOp = z.infer<typeof BoardOp>;
export const BoardOps = z.array(BoardOp).min(1).max(BOARD_LIMITS.ops);

/** What one operation made or touched (new ids for the caller). */
export interface BoardOpResult {
  op: BoardOp['op'];
  cardId?: string;
  columnId?: string;
  propertyId?: string;
  optionId?: string;
  commentId?: string;
}

/** An operation that cannot apply (unknown card, a column that still has cards…): the whole batch is refused. */
export class BoardOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardOpError';
  }
}

export interface BoardOpContext {
  /** `user` or `agent:<agent id>`. */
  author: string;
  /** The agent's title, kept on its comments. */
  authorName?: string;
  now?: () => number;
  newId?: (prefix: string) => string;
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** A short random id (`c_k3j9x0a2mq`); `crypto.getRandomValues` exists in main and the renderer. */
export function boardId(prefix: string): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ID_CHARS[b % ID_CHARS.length];
  return `${prefix}_${s}`;
}

const fold = (s: string) => s.trim().toLowerCase();

function findColumn(board: KanbanBoard, ref: string): BoardColumn {
  const c = board.columns.find((x) => x.id === ref) ?? board.columns.find((x) => fold(x.name) === fold(ref));
  if (!c) throw new BoardOpError(`No column "${ref}". Columns: ${board.columns.map((x) => x.name).join(', ')}.`);
  return c;
}

function findProperty(board: KanbanBoard, ref: string): BoardProperty {
  const p = board.properties.find((x) => x.id === ref) ?? board.properties.find((x) => fold(x.name) === fold(ref));
  if (!p) throw new BoardOpError(`No property "${ref}". Properties: ${board.properties.map((x) => x.name).join(', ') || 'none'}.`);
  return p;
}

function findCard(board: KanbanBoard, id: string): BoardCard {
  const c = board.cards.find((x) => x.id === id);
  if (!c) throw new BoardOpError(`No card with id ${id}. Read the board again: it may have been deleted.`);
  return c;
}

function findOption(p: BoardProperty, ref: string): BoardOption | undefined {
  return p.options?.find((o) => o.id === ref) ?? p.options?.find((o) => fold(o.name) === fold(ref));
}

function nextColor(used: number): BoardColor {
  return BOARD_COLORS[(used + 1) % BOARD_COLORS.length]!;
}

function uniqueName(existing: Array<{ name: string }>, name: string, what: string): void {
  if (existing.some((x) => fold(x.name) === fold(name))) throw new BoardOpError(`There is already a ${what} named "${name}".`);
}

/** The option for `ref`, added to the property when it is a new name. */
function optionFor(p: BoardProperty, ref: string, newId: (prefix: string) => string): string {
  const hit = findOption(p, ref);
  if (hit) return hit.id;
  const name = ref.trim();
  if (!name || name.length > BOARD_LIMITS.name) throw new BoardOpError(`"${ref}" is not a valid option of ${p.name}.`);
  const options = (p.options ??= []);
  if (options.length >= BOARD_LIMITS.options) throw new BoardOpError(`${p.name} already has ${BOARD_LIMITS.options} options.`);
  const o: BoardOption = { id: newId('o'), name, color: nextColor(options.length) };
  options.push(o);
  return o.id;
}

/** A value input made to fit the property's type; undefined clears it. */
function coerceValue(p: BoardProperty, v: BoardValueInput, newId: (prefix: string) => string): BoardValue | undefined {
  if (v === null) return undefined;
  const bad = (want: string) => new BoardOpError(`${p.name} is a ${p.type.replace('_', '-')} property: give ${want}.`);
  switch (p.type) {
    case 'select':
      if (typeof v !== 'string') throw bad('one option name');
      return v.trim() ? optionFor(p, v, newId) : undefined;
    case 'multi_select': {
      const list = typeof v === 'string' ? (v.trim() ? [v] : []) : Array.isArray(v) ? v : null;
      if (!list) throw bad('a list of option names');
      const ids = [...new Set(list.map((x) => optionFor(p, x, newId)))];
      return ids.length ? ids : undefined;
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw bad('a number');
      return n;
    }
    case 'checkbox':
      if (typeof v !== 'boolean') throw bad('true or false');
      return v || undefined;
    case 'date':
      if (typeof v !== 'string' || !DateValue.safeParse(v.trim()).success) throw bad('a date as YYYY-MM-DD');
      return v.trim();
    case 'url':
    case 'text':
      if (typeof v !== 'string') throw bad('text');
      return v.trim() ? v : undefined;
  }
}

function setProps(board: KanbanBoard, card: BoardCard, props: Record<string, BoardValueInput>, newId: (prefix: string) => string): void {
  for (const [ref, v] of Object.entries(props)) {
    const p = findProperty(board, ref);
    const value = coerceValue(p, v, newId);
    if (value === undefined) delete card.props[p.id];
    else card.props[p.id] = value;
  }
}

/** Put `card` at `index` among the cards of its column (the array order is the display order). */
function place(board: KanbanBoard, card: BoardCard, index: number | undefined): void {
  const rest = board.cards.filter((c) => c !== card);
  const inColumn = rest.filter((c) => c.column === card.column);
  if (index === undefined || index >= inColumn.length) {
    const last = inColumn[inColumn.length - 1];
    rest.splice(last ? rest.indexOf(last) + 1 : rest.length, 0, card);
  } else rest.splice(rest.indexOf(inColumn[index]!), 0, card);
  board.cards = rest;
}

function moveIn<T>(list: T[], item: T, index: number): T[] {
  const rest = list.filter((x) => x !== item);
  rest.splice(Math.min(index, rest.length), 0, item);
  return rest;
}

const isSelect = (t: BoardPropertyType) => t === 'select' || t === 'multi_select';

/**
 * Change a property's type and convert every card's value: select ↔ multi-select keep their options
 * (multi → select keeps the first); text values become options of a new select (one per distinct text);
 * a select becomes text as its option names; numbers, dates and links keep values that still fit.
 * Anything else is cleared.
 */
function convertProperty(b: KanbanBoard, p: BoardProperty, to: BoardPropertyType, newId: (prefix: string) => string): void {
  const from = p.type;
  const old = new Map(b.cards.map((c) => [c, c.props[p.id]] as const));
  // The options as they were: a select becoming text needs their names after they are gone.
  const options = p.options;
  const names = (v: BoardValue): string[] => (Array.isArray(v) ? v : [String(v)]).map((id) => options?.find((o) => o.id === id)?.name ?? '').filter(Boolean);
  p.type = to;
  if (isSelect(to)) p.options = isSelect(from) ? (options ?? []) : [];
  else delete p.options;
  for (const [card, v] of old) {
    delete card.props[p.id];
    if (v === undefined) continue;
    let next: BoardValue | undefined;
    if (isSelect(from) && isSelect(to)) {
      const ids = Array.isArray(v) ? v : [String(v)];
      next = to === 'select' ? ids[0] : ids;
    } else if (isSelect(to)) {
      const text = typeof v === 'boolean' ? (v ? 'Yes' : '') : String(v).trim().slice(0, BOARD_LIMITS.name);
      if (text) {
        try {
          const id = optionFor(p, text, newId);
          next = to === 'select' ? id : [id];
        } catch {
          next = undefined;
        }
      }
    } else {
      const text = isSelect(from) ? names(v).join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : '') : String(v);
      if (to === 'text' || to === 'url') next = text.slice(0, BOARD_LIMITS.text) || undefined;
      else if (to === 'number') next = text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : undefined;
      else if (to === 'date') next = DateValue.safeParse(text.trim()).success ? text.trim() : undefined;
      else if (to === 'checkbox') next = v === true || undefined;
    }
    if (next !== undefined && !(Array.isArray(next) && !next.length)) card.props[p.id] = next;
  }
}

/**
 * Apply operations in order to a copy of `board`. All or nothing: the first operation that cannot
 * apply throws `BoardOpError` (with a message the user or agent can act on) and nothing changes.
 * The result is checked with `checkBoard`.
 */
export function applyBoardOps(board: KanbanBoard, ops: readonly BoardOp[], ctx: BoardOpContext): { board: KanbanBoard; results: BoardOpResult[] } {
  const b = structuredClone(board);
  const now = ctx.now ?? Date.now;
  const newId = ctx.newId ?? boardId;
  const results: BoardOpResult[] = [];
  for (const op of ops) {
    const ts = now();
    switch (op.op) {
      case 'add_card': {
        if (b.cards.length >= BOARD_LIMITS.cards) throw new BoardOpError(`A board holds at most ${BOARD_LIMITS.cards} cards.`);
        const column = op.column ? findColumn(b, op.column) : b.columns[0]!;
        const card: BoardCard = { id: newId('c'), title: op.title, column: column.id, props: {}, body: op.body ?? '', comments: [], agents: [], createdAt: ts, updatedAt: ts, createdBy: ctx.author };
        if (op.props) setProps(b, card, op.props, newId);
        b.cards.push(card);
        place(b, card, op.index);
        results.push({ op: op.op, cardId: card.id, columnId: column.id });
        break;
      }
      case 'update_card': {
        const card = findCard(b, op.cardId);
        if (op.title !== undefined) card.title = op.title;
        if (op.body !== undefined) card.body = op.body;
        if (op.props) setProps(b, card, op.props, newId);
        card.updatedAt = ts;
        results.push({ op: op.op, cardId: card.id });
        break;
      }
      case 'move_card': {
        const card = findCard(b, op.cardId);
        const column = findColumn(b, op.column);
        if (card.column !== column.id) card.updatedAt = ts;
        card.column = column.id;
        place(b, card, op.index);
        results.push({ op: op.op, cardId: card.id, columnId: column.id });
        break;
      }
      case 'delete_card': {
        const card = findCard(b, op.cardId);
        b.cards = b.cards.filter((c) => c !== card);
        results.push({ op: op.op, cardId: card.id });
        break;
      }
      case 'add_comment': {
        const card = findCard(b, op.cardId);
        if (card.comments.length >= BOARD_LIMITS.comments) throw new BoardOpError(`A card holds at most ${BOARD_LIMITS.comments} comments.`);
        const comment: BoardComment = { id: newId('m'), author: ctx.author, ...(ctx.authorName ? { authorName: ctx.authorName.slice(0, 200) } : {}), ts, text: op.text };
        card.comments.push(comment);
        card.updatedAt = ts;
        results.push({ op: op.op, cardId: card.id, commentId: comment.id });
        break;
      }
      case 'delete_comment': {
        const card = findCard(b, op.cardId);
        const comment = card.comments.find((m) => m.id === op.commentId);
        if (!comment) throw new BoardOpError(`No comment ${op.commentId} on this card.`);
        // Agents remove only their own comments; the user may remove any.
        if (ctx.author !== 'user' && comment.author !== ctx.author) throw new BoardOpError('You can delete only your own comments.');
        card.comments = card.comments.filter((m) => m !== comment);
        results.push({ op: op.op, cardId: card.id, commentId: comment.id });
        break;
      }
      case 'link_agent': {
        const card = findCard(b, op.cardId);
        card.agents = [...card.agents.filter((a) => a !== op.agentId), op.agentId].slice(-BOARD_LIMITS.agents);
        card.updatedAt = ts;
        results.push({ op: op.op, cardId: card.id });
        break;
      }
      case 'unlink_agent': {
        const card = findCard(b, op.cardId);
        card.agents = card.agents.filter((a) => a !== op.agentId);
        results.push({ op: op.op, cardId: card.id });
        break;
      }
      case 'add_column': {
        if (b.columns.length >= BOARD_LIMITS.columns) throw new BoardOpError(`A board holds at most ${BOARD_LIMITS.columns} columns.`);
        uniqueName(b.columns, op.name, 'column');
        const column: BoardColumn = { id: newId('col'), name: op.name, color: op.color ?? nextColor(b.columns.length) };
        b.columns = op.index === undefined ? [...b.columns, column] : moveIn([...b.columns, column], column, op.index);
        results.push({ op: op.op, columnId: column.id });
        break;
      }
      case 'update_column': {
        const column = findColumn(b, op.column);
        if (op.name !== undefined && fold(op.name) !== fold(column.name)) uniqueName(b.columns, op.name, 'column');
        if (op.name !== undefined) column.name = op.name;
        if (op.color !== undefined) column.color = op.color;
        results.push({ op: op.op, columnId: column.id });
        break;
      }
      case 'move_column': {
        const column = findColumn(b, op.column);
        b.columns = moveIn(b.columns, column, op.index);
        results.push({ op: op.op, columnId: column.id });
        break;
      }
      case 'delete_column': {
        const column = findColumn(b, op.column);
        if (b.columns.length === 1) throw new BoardOpError('A board needs at least one column.');
        const cards = b.cards.filter((c) => c.column === column.id);
        if (cards.length) {
          if (!op.moveCardsTo) throw new BoardOpError(`${column.name} has ${cards.length} card${cards.length === 1 ? '' : 's'}: say where they go (moveCardsTo), or move or delete them first.`);
          const to = findColumn(b, op.moveCardsTo);
          if (to.id === column.id) throw new BoardOpError('Move the cards to another column.');
          for (const c of cards) {
            c.column = to.id;
            place(b, c, undefined);
          }
        }
        b.columns = b.columns.filter((c) => c !== column);
        results.push({ op: op.op, columnId: column.id });
        break;
      }
      case 'add_property': {
        if (b.properties.length >= BOARD_LIMITS.properties) throw new BoardOpError(`A board holds at most ${BOARD_LIMITS.properties} properties.`);
        uniqueName(b.properties, op.name, 'property');
        const p: BoardProperty = { id: newId('p'), name: op.name, type: op.type, showOnCard: op.showOnCard ?? true };
        if (op.type === 'select' || op.type === 'multi_select') {
          p.options = [];
          for (const o of op.options ?? []) {
            uniqueName(p.options, o.name, `${p.name} option`);
            p.options.push({ id: newId('o'), name: o.name, color: o.color ?? nextColor(p.options.length) });
          }
        } else if (op.options?.length) throw new BoardOpError(`Only select and multi-select properties have options.`);
        b.properties = op.index === undefined ? [...b.properties, p] : moveIn([...b.properties, p], p, op.index);
        results.push({ op: op.op, propertyId: p.id });
        break;
      }
      case 'update_property': {
        const p = findProperty(b, op.property);
        if (op.name !== undefined && fold(op.name) !== fold(p.name)) uniqueName(b.properties, op.name, 'property');
        if (op.name !== undefined) p.name = op.name;
        if (op.showOnCard !== undefined) p.showOnCard = op.showOnCard;
        if (op.type !== undefined && op.type !== p.type) convertProperty(b, p, op.type, newId);
        results.push({ op: op.op, propertyId: p.id });
        break;
      }
      case 'move_property': {
        const p = findProperty(b, op.property);
        b.properties = moveIn(b.properties, p, op.index);
        results.push({ op: op.op, propertyId: p.id });
        break;
      }
      case 'delete_property': {
        const p = findProperty(b, op.property);
        b.properties = b.properties.filter((x) => x !== p);
        for (const c of b.cards) delete c.props[p.id];
        results.push({ op: op.op, propertyId: p.id });
        break;
      }
      case 'add_option': {
        const p = findProperty(b, op.property);
        if (p.type !== 'select' && p.type !== 'multi_select') throw new BoardOpError(`${p.name} is not a select property.`);
        const options = (p.options ??= []);
        if (options.length >= BOARD_LIMITS.options) throw new BoardOpError(`${p.name} already has ${BOARD_LIMITS.options} options.`);
        uniqueName(options, op.name, `${p.name} option`);
        const o: BoardOption = { id: newId('o'), name: op.name, color: op.color ?? nextColor(options.length) };
        options.push(o);
        results.push({ op: op.op, propertyId: p.id, optionId: o.id });
        break;
      }
      case 'update_option': {
        const p = findProperty(b, op.property);
        const o = findOption(p, op.option);
        if (!o) throw new BoardOpError(`${p.name} has no option "${op.option}".`);
        if (op.name !== undefined && fold(op.name) !== fold(o.name)) uniqueName(p.options ?? [], op.name, `${p.name} option`);
        if (op.name !== undefined) o.name = op.name;
        if (op.color !== undefined) o.color = op.color;
        results.push({ op: op.op, propertyId: p.id, optionId: o.id });
        break;
      }
      case 'delete_option': {
        const p = findProperty(b, op.property);
        const o = findOption(p, op.option);
        if (!o) throw new BoardOpError(`${p.name} has no option "${op.option}".`);
        p.options = (p.options ?? []).filter((x) => x !== o);
        for (const c of b.cards) {
          const v = c.props[p.id];
          if (v === o.id) delete c.props[p.id];
          else if (Array.isArray(v)) {
            const left = v.filter((x) => x !== o.id);
            if (left.length) c.props[p.id] = left;
            else delete c.props[p.id];
          }
        }
        results.push({ op: op.op, propertyId: p.id, optionId: o.id });
        break;
      }
    }
  }
  checkBoard(b);
  return { board: b, results };
}

/* ---------------------------------------------------------------- parse, check, serialise */

/**
 * Integrity beyond the schema: unique ids, every card in a known column, every value set on a known
 * property and fitting its type (select values are option ids of that property). Throws
 * `BoardOpError` with the first problem.
 */
export function checkBoard(b: KanbanBoard): void {
  const ids = new Set<string>();
  const unique = (id: string, what: string) => {
    if (ids.has(id)) throw new BoardOpError(`The id ${id} is used twice (${what}).`);
    ids.add(id);
  };
  const names = (list: Array<{ name: string }>, what: string) => {
    const seen = new Set<string>();
    for (const x of list) {
      if (seen.has(fold(x.name))) throw new BoardOpError(`Two ${what} are named "${x.name}".`);
      seen.add(fold(x.name));
    }
  };
  names(b.columns, 'columns');
  names(b.properties, 'properties');
  for (const c of b.columns) unique(c.id, 'column');
  const props = new Map<string, BoardProperty>();
  for (const p of b.properties) {
    unique(p.id, 'property');
    props.set(p.id, p);
    if (p.type !== 'select' && p.type !== 'multi_select' && p.options?.length) throw new BoardOpError(`${p.name} has options but is not a select property.`);
    for (const o of p.options ?? []) unique(o.id, 'option');
    names(p.options ?? [], `options of ${p.name}`);
  }
  const columns = new Set(b.columns.map((c) => c.id));
  for (const card of b.cards) {
    unique(card.id, 'card');
    if (!columns.has(card.column)) throw new BoardOpError(`Card ${card.id} is in an unknown column ${card.column}.`);
    for (const m of card.comments) unique(m.id, 'comment');
    for (const [pid, v] of Object.entries(card.props)) {
      const p = props.get(pid);
      if (!p) throw new BoardOpError(`Card ${card.id} has a value for an unknown property ${pid}.`);
      const options = new Set((p.options ?? []).map((o) => o.id));
      const ok =
        p.type === 'select'
          ? typeof v === 'string' && options.has(v)
          : p.type === 'multi_select'
            ? Array.isArray(v) && v.every((x) => options.has(x))
            : p.type === 'number'
              ? typeof v === 'number'
              : p.type === 'checkbox'
                ? typeof v === 'boolean'
                : p.type === 'date'
                  ? typeof v === 'string' && DateValue.safeParse(v).success
                  : typeof v === 'string';
      if (!ok) throw new BoardOpError(`Card ${card.id} has a value for ${p.name} that is not a valid ${p.type.replace('_', '-')} value.`);
    }
  }
}

/** Parse and check a board file. Throws `BoardOpError` with a readable reason. */
export function parseBoard(text: string): KanbanBoard {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new BoardOpError(`A board must be JSON: ${(e as Error).message}`);
  }
  const r = KanbanBoard.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new BoardOpError(`Not an oIDE board (${first ? `${first.path.join('.') || 'file'}: ${first.message}` : 'invalid'}).`);
  }
  checkBoard(r.data);
  return r.data;
}

/** True when the text parses as an oIDE board. */
export function isBoardContent(text: string): boolean {
  try {
    parseBoard(text);
    return true;
  } catch {
    return false;
  }
}

/** Pretty-printed (one value per line), so a board shared in a repo diffs well. */
export function serializeBoard(b: KanbanBoard): string {
  return `${JSON.stringify(b, null, 2)}\n`;
}

/** The board a new, blank board starts with: a product backlog. */
export function defaultBoard(newId: (prefix: string) => string = boardId): KanbanBoard {
  const col = (name: string, color: BoardColor): BoardColumn => ({ id: newId('col'), name, color });
  const opt = (name: string, color: BoardColor): BoardOption => ({ id: newId('o'), name, color });
  return {
    type: BOARD_FORMAT,
    version: 1,
    columns: [col('Proposed', 'gray'), col('Approved', 'blue'), col('In progress', 'yellow'), col('In review', 'orange'), col('Shipped', 'green'), col("Won't do", 'red')],
    properties: [
      { id: newId('p'), name: 'Priority', type: 'select', showOnCard: true, options: [opt('P0', 'red'), opt('P1', 'orange'), opt('P2', 'yellow'), opt('P3', 'gray')] },
      { id: newId('p'), name: 'Effort', type: 'select', showOnCard: true, options: [opt('S', 'green'), opt('M', 'yellow'), opt('L', 'orange')] },
      { id: newId('p'), name: 'Type', type: 'select', showOnCard: true, options: [opt('Build', 'blue'), opt('Fix', 'red'), opt('Improve', 'green'), opt('Tech debt', 'orange')] },
    ],
    cards: [],
  };
}

/* ---------------------------------------------------------------- for agents and notes */

/** A value as names (select options by name), for agents and summaries. */
export function displayValue(p: BoardProperty, v: BoardValue | undefined): string | number | boolean | string[] | undefined {
  if (v === undefined) return undefined;
  if (p.type === 'select') return findOption(p, String(v))?.name ?? String(v);
  if (p.type === 'multi_select') return (Array.isArray(v) ? v : [String(v)]).map((id) => findOption(p, id)?.name ?? id);
  return v;
}

function namedProps(b: KanbanBoard, card: BoardCard): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of b.properties) {
    const v = displayValue(p, card.props[p.id]);
    if (v !== undefined) out[p.name] = v;
  }
  return out;
}

/**
 * The board as an agent reads it (`board_read`): names instead of ids where a name is what the
 * operations accept. With `cardId`, that card in full (body and comments); else every card in short.
 */
export function boardForAgent(b: KanbanBoard, opts: { cardId?: string; column?: string } = {}): unknown {
  const columnName = (id: string) => b.columns.find((c) => c.id === id)?.name ?? id;
  if (opts.cardId) {
    const card = findCard(b, opts.cardId);
    return {
      id: card.id,
      title: card.title,
      column: columnName(card.column),
      props: namedProps(b, card),
      body: card.body,
      comments: card.comments.map((m) => ({ id: m.id, author: m.authorName ? `${m.authorName} (${m.author})` : m.author, ts: new Date(m.ts).toISOString(), text: m.text })),
      agents: card.agents,
      createdAt: new Date(card.createdAt).toISOString(),
      updatedAt: new Date(card.updatedAt).toISOString(),
    };
  }
  const only = opts.column ? findColumn(b, opts.column).id : undefined;
  return {
    columns: b.columns.map((c) => ({ id: c.id, name: c.name, color: c.color, cards: b.cards.filter((x) => x.column === c.id).length })),
    properties: b.properties.map((p) => ({ id: p.id, name: p.name, type: p.type, ...(p.options ? { options: p.options.map((o) => o.name) } : {}), showOnCard: p.showOnCard })),
    cards: b.cards
      .filter((c) => !only || c.column === only)
      .map((c) => ({
        id: c.id,
        title: c.title,
        column: columnName(c.column),
        props: namedProps(b, c),
        ...(c.body ? { bodyChars: c.body.length } : {}),
        ...(c.comments.length ? { comments: c.comments.length } : {}),
        ...(c.agents.length ? { agents: c.agents } : {}),
      })),
  };
}

/** What a batch of operations is about, for telemetry (`board_changed.area`): never names or text. */
export function boardOpsArea(ops: readonly BoardOp[]): 'cards' | 'comments' | 'columns' | 'properties' | 'agent_link' | 'mixed' {
  const areaOf = (op: BoardOp['op']) =>
    op === 'add_comment' || op === 'delete_comment'
      ? 'comments'
      : op === 'link_agent' || op === 'unlink_agent'
        ? 'agent_link'
        : op.endsWith('_card')
          ? 'cards'
          : op.endsWith('_column')
            ? 'columns'
            : 'properties';
  const areas = new Set(ops.map((o) => areaOf(o.op)));
  return areas.size === 1 ? [...areas][0]! : 'mixed';
}

/** One line for the version history: what a batch of operations did (at most 300 characters). */
export function describeBoardOps(before: KanbanBoard, after: KanbanBoard, ops: readonly BoardOp[], results: readonly BoardOpResult[]): string {
  const title = (id: string | undefined) => {
    const c = after.cards.find((x) => x.id === id) ?? before.cards.find((x) => x.id === id);
    const t = c?.title ?? 'a card';
    return `"${t.length > 60 ? `${t.slice(0, 57)}…` : t}"`;
  };
  const column = (id: string | undefined) => after.columns.find((x) => x.id === id)?.name ?? before.columns.find((x) => x.id === id)?.name ?? 'a column';
  const parts = ops.map((op, i) => {
    const r = results[i];
    switch (op.op) {
      case 'add_card':
        return `Added ${title(r?.cardId)} to ${column(r?.columnId)}`;
      case 'update_card':
        return `Edited ${title(op.cardId)}`;
      case 'move_card':
        return `Moved ${title(op.cardId)} to ${column(r?.columnId)}`;
      case 'delete_card':
        return `Deleted ${title(op.cardId)}`;
      case 'add_comment':
        return `Commented on ${title(op.cardId)}`;
      case 'delete_comment':
        return `Deleted a comment on ${title(op.cardId)}`;
      case 'link_agent':
        return `Started an agent on ${title(op.cardId)}`;
      case 'unlink_agent':
        return `Unlinked an agent from ${title(op.cardId)}`;
      case 'add_column':
        return `Added column ${column(r?.columnId)}`;
      case 'update_column':
        return `Edited column ${column(r?.columnId)}`;
      case 'move_column':
        return `Moved column ${column(r?.columnId)}`;
      case 'delete_column':
        return `Deleted column ${column(r?.columnId)}`;
      default:
        return 'Edited the properties';
    }
  });
  const uniq = [...new Set(parts)];
  const text = uniq.length > 3 ? `${uniq.slice(0, 3).join('; ')} and ${uniq.length - 3} more` : uniq.join('; ');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
