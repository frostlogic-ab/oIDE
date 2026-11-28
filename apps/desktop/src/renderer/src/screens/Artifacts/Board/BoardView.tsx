/**
 * The columns of a kanban board (ADR 0022). Cards drag between and within columns (HTML drag and
 * drop); every move also works from the keyboard (Alt+arrows on a card, or its "Move" menu), and
 * columns reorder by dragging their header or from the column menu. Every change is a board operation
 * (`apply`), the same ones agents send with board_update.
 */
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { BOARD_COLORS, type AgentSummary, type BoardCard, type BoardColumn, type BoardOp, type BoardOpResult, type KanbanBoard } from '@oide/protocol';
import { Button, Dialog, Icon, Menu, Select, StatusDot, cn, type MenuItem } from '@oide/ui';
import { plural } from '../../../lib/format';
import { cardChips, cardStyle, chipStyle, COLOR_LABEL, dropIndex, laneStyle } from './boardModel';

const CARD_TYPE = 'application/x-oide-board-card';
const COLUMN_TYPE = 'application/x-oide-board-column';

export interface BoardViewProps {
  board: KanbanBoard;
  /** Cards to show (a search narrows them); drag and drop is off while searching. */
  cards: readonly BoardCard[];
  searching: boolean;
  selectedCardId: string | null;
  agents: Record<string, AgentSummary | undefined>;
  onOpenCard: (id: string) => void;
  apply: (ops: BoardOp[]) => Promise<BoardOpResult[] | null>;
  /** Says something to screen readers (a card moved). */
  announce: (message: string) => void;
}

type Drag = { kind: 'card'; id: string } | { kind: 'column'; id: string } | null;

export function BoardView({ board, cards, searching, selectedCardId, agents, onOpenCard, apply, announce }: BoardViewProps) {
  const [drag, setDrag] = useState<Drag>(null);
  /** Where a dragged card would land: column and index among the other cards. */
  const [target, setTarget] = useState<{ column: string; index: number } | null>(null);
  const [columnTarget, setColumnTarget] = useState<number | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [newColumn, setNewColumn] = useState<string | null>(null);
  /** The card to focus after it moved (keyboard moves re-render it in another list). */
  const focusAfter = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-card-open="${CSS.escape(id)}"]`);
    if (el) {
      el.focus();
      focusAfter.current = null;
    }
  });

  const byColumn = new Map<string, BoardCard[]>(board.columns.map((c) => [c.id, []]));
  for (const c of cards) byColumn.get(c.column)?.push(c);
  const allByColumn = new Map<string, BoardCard[]>(board.columns.map((c) => [c.id, []]));
  for (const c of board.cards) allByColumn.get(c.column)?.push(c);
  const columnName = (id: string) => board.columns.find((c) => c.id === id)?.name ?? '';

  const move = async (card: BoardCard, column: string, index: number | undefined, viaKeyboard = false) => {
    if (viaKeyboard) focusAfter.current = card.id;
    const res = await apply([{ op: 'move_card', cardId: card.id, column, ...(index !== undefined ? { index } : {}) }]);
    if (res) announce(`Moved ${card.title} to ${columnName(column)}${index !== undefined ? `, position ${index + 1}` : ''}.`);
  };

  /** Alt+arrows on a card: left / right to the next column (at the bottom), up / down within the column. */
  const onCardKey = (e: KeyboardEvent, card: BoardCard) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || searching) return;
    const ci = board.columns.findIndex((c) => c.id === card.column);
    const list = allByColumn.get(card.column) ?? [];
    const i = list.indexOf(card);
    if (e.key === 'ArrowLeft' && ci > 0) void move(card, board.columns[ci - 1]!.id, undefined, true);
    else if (e.key === 'ArrowRight' && ci < board.columns.length - 1) void move(card, board.columns[ci + 1]!.id, undefined, true);
    else if (e.key === 'ArrowUp' && i > 0) void move(card, card.column, i - 1, true);
    else if (e.key === 'ArrowDown' && i < list.length - 1) void move(card, card.column, i + 1, true);
    else return;
    e.preventDefault();
  };

  const endDrag = () => {
    setDrag(null);
    setTarget(null);
    setColumnTarget(null);
  };

  const onLaneDragOver = (e: DragEvent<HTMLElement>, col: BoardColumn, colIndex: number) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drag.kind === 'column') {
      const box = e.currentTarget.getBoundingClientRect();
      setColumnTarget(e.clientX < box.left + box.width / 2 ? colIndex : colIndex + 1);
      return;
    }
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-card-id]')].filter((el) => el.dataset.cardId !== drag.id);
    const index = dropIndex(
      e.clientY,
      items.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, height: r.height };
      }),
    );
    setTarget((t) => (t && t.column === col.id && t.index === index ? t : { column: col.id, index }));
  };

  const onLaneDrop = (e: DragEvent<HTMLElement>, col: BoardColumn) => {
    e.preventDefault();
    const d = drag;
    const t = target;
    const ct = columnTarget;
    endDrag();
    if (!d) return;
    if (d.kind === 'column') {
      const from = board.columns.findIndex((c) => c.id === d.id);
      if (ct === null || from < 0) return;
      const to = ct > from ? ct - 1 : ct;
      if (to !== from) void apply([{ op: 'move_column', column: d.id, index: to }]).then((r) => r && announce(`Moved column ${columnName(d.id)} to position ${to + 1}.`));
      return;
    }
    const card = board.cards.find((c) => c.id === d.id);
    if (!card) return;
    const index = t?.column === col.id ? t.index : undefined;
    // Dropped where it already was (the index counts the other cards): nothing to save.
    const current = allByColumn.get(col.id) ?? [];
    if (card.column === col.id && (index ?? current.length - 1) === current.indexOf(card)) return;
    void move(card, col.id, index);
  };

  return (
    <div ref={root} className="flex-1 min-h-0 min-w-0 overflow-x-auto overflow-y-hidden">
      <ol aria-label="Columns" className="list-none m-0 p-0 h-full flex gap-3 items-stretch">
        {board.columns.map((col, ci) => {
          const list = byColumn.get(col.id) ?? [];
          const total = allByColumn.get(col.id)?.length ?? 0;
          const dropHere = drag?.kind === 'card' && target?.column === col.id;
          return (
            <li
              key={col.id}
              aria-label={`${col.name}, ${plural(total, 'card')}`}
              className={cn(
                'relative shrink-0 w-[280px] h-full min-h-0 flex flex-col rounded-xl border border-transparent',
                dropHere && 'border-accent/60',
                drag?.kind === 'column' && drag.id === col.id && 'opacity-50',
              )}
              style={laneStyle(col.color)}
              onDragOver={(e) => onLaneDragOver(e, col, ci)}
              onDrop={(e) => onLaneDrop(e, col)}
            >
              {drag?.kind === 'column' && columnTarget === ci && <span aria-hidden="true" className="absolute -left-[7px] top-0 bottom-0 w-[2px] rounded bg-accent" />}
              {drag?.kind === 'column' && columnTarget === ci + 1 && ci === board.columns.length - 1 && (
                <span aria-hidden="true" className="absolute -right-[7px] top-0 bottom-0 w-[2px] rounded bg-accent" />
              )}
              <ColumnHeader
                board={board}
                column={col}
                index={ci}
                count={total}
                apply={apply}
                announce={announce}
                onAdd={() => setAdding(col.id)}
                draggable={!searching}
                onDragStart={(e) => {
                  e.dataTransfer.setData(COLUMN_TYPE, col.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDrag({ kind: 'column', id: col.id });
                }}
                onDragEnd={endDrag}
              />
              <ol aria-label={`${col.name} cards`} className="list-none m-0 px-2 pb-2 flex-1 min-h-[40px] overflow-y-auto flex flex-col gap-2">
                {list.map((card, i) => (
                  <li key={card.id} data-card-id={card.id} className="relative">
                    {dropHere && target.index === i && drag.id !== card.id && <DropLine />}
                    <CardTile
                      board={board}
                      card={card}
                      column={col}
                      selected={selectedCardId === card.id}
                      dragging={drag?.kind === 'card' && drag.id === card.id}
                      draggable={!searching}
                      agents={agents}
                      onOpen={() => onOpenCard(card.id)}
                      onKeyDown={(e) => onCardKey(e, card)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(CARD_TYPE, card.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDrag({ kind: 'card', id: card.id });
                      }}
                      onDragEnd={endDrag}
                      menu={cardMenu(board, card, i, allByColumn.get(col.id)?.length ?? 0, {
                        open: () => onOpenCard(card.id),
                        move: (column, index) => void move(card, column, index, true),
                        remove: () => void apply([{ op: 'delete_card', cardId: card.id }]).then((r) => r && announce(`Deleted ${card.title}.`)),
                      })}
                    />
                  </li>
                ))}
                {dropHere && target.index >= list.filter((c) => c.id !== drag.id).length && (
                  <li aria-hidden="true" className="relative h-1">
                    <DropLine />
                  </li>
                )}
                {list.length === 0 && !dropHere && (
                  <li className="text-[12px] text-ink-4 px-1 py-2">{searching && total ? 'No matching cards' : 'No cards'}</li>
                )}
              </ol>
              <div className="px-2 pb-2 shrink-0">
                {adding === col.id ? (
                  <NewCardInput
                    columnName={col.name}
                    onCancel={() => setAdding(null)}
                    onCreate={async (title, again) => {
                      const res = await apply([{ op: 'add_card', title, column: col.id }]);
                      if (res) announce(`Added ${title} to ${col.name}.`);
                      if (!again) setAdding(null);
                      return res !== null;
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setAdding(col.id)}
                    className="w-full h-8 flex items-center gap-1.5 px-2 rounded-md text-[12.5px] text-ink-3 hover:bg-raised hover:text-ink-2"
                  >
                    <Icon name="plus" size={14} />
                    New card<span className="sr-only"> in {col.name}</span>
                  </button>
                )}
              </div>
            </li>
          );
        })}
        <li className="shrink-0 w-[240px]">
          {newColumn !== null ? (
            <form
              className="flex flex-col gap-2 p-2 rounded-xl border border-line-2 bg-panel"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newColumn.trim();
                if (!name) return;
                void apply([{ op: 'add_column', name }]).then((r) => {
                  if (!r) return;
                  announce(`Added column ${name}.`);
                  setNewColumn(null);
                });
              }}
            >
              <label className="text-[11.5px] text-ink-3" htmlFor="board-new-column">
                Column name
              </label>
              <input
                id="board-new-column"
                autoFocus
                value={newColumn}
                maxLength={100}
                onChange={(e) => setNewColumn(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setNewColumn(null);
                  }
                }}
                className="h-8 px-2 rounded-md border border-line-3 bg-card text-[13px] text-ink outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <Button size={28} variant="primary" type="submit" disabled={!newColumn.trim()}>
                  Add column
                </Button>
                <Button size={28} variant="ghost" onClick={() => setNewColumn(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setNewColumn('')}
              className="h-9 w-full flex items-center gap-1.5 px-3 rounded-xl border border-dashed border-line-3 text-[12.5px] text-ink-3 hover:text-ink-2 hover:border-line-hover"
            >
              <Icon name="plus" size={14} />
              Add column
            </button>
          )}
        </li>
      </ol>
    </div>
  );
}

function DropLine() {
  return <span aria-hidden="true" className="absolute -top-[5px] left-0 right-0 h-[2px] rounded bg-accent" />;
}

function cardMenu(
  board: KanbanBoard,
  card: BoardCard,
  index: number,
  count: number,
  act: { open: () => void; move: (column: string, index?: number) => void; remove: () => void },
): MenuItem[] {
  return [
    { id: 'open', label: 'Open', onSelect: act.open },
    ...(index > 0 ? [{ id: 'up', label: 'Move up', hint: 'Alt+↑', onSelect: () => act.move(card.column, index - 1) }] : []),
    ...(index < count - 1 ? [{ id: 'down', label: 'Move down', hint: 'Alt+↓', onSelect: () => act.move(card.column, index + 1) }] : []),
    ...board.columns.filter((c) => c.id !== card.column).map((c) => ({ id: `to-${c.id}`, label: `Move to ${c.name}`, onSelect: () => act.move(c.id) })),
    { id: 'delete', label: 'Delete card', icon: 'trash' as const, danger: true, onSelect: act.remove },
  ];
}

interface CardTileProps {
  board: KanbanBoard;
  card: BoardCard;
  column: BoardColumn;
  selected: boolean;
  dragging: boolean;
  draggable: boolean;
  agents: Record<string, AgentSummary | undefined>;
  menu: MenuItem[];
  onOpen: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

function CardTile({ board, card, column, selected, dragging, draggable, agents, menu, onOpen, onKeyDown, onDragStart, onDragEnd }: CardTileProps) {
  const chips = cardChips(board, card);
  const linked = card.agents.map((id) => agents[id]).filter((a): a is AgentSummary => !!a);
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative rounded-lg border px-3 py-2.5 flex flex-col gap-2 cursor-pointer',
        selected ? 'border-accent' : 'border-line-2 hover:border-line-hover',
        dragging && 'opacity-40',
      )}
      style={cardStyle(column.color)}
      onClick={(e) => {
        // The menu and its items handle their own clicks.
        if ((e.target as HTMLElement).closest('[data-card-menu]')) return;
        onOpen();
      }}
    >
      <div className="flex items-start gap-2">
        <Icon name="file" size={14} className="mt-[3px] text-ink-3 shrink-0" />
        <button
          type="button"
          data-card-open={card.id}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          onKeyDown={onKeyDown}
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
          aria-current={selected ? 'true' : undefined}
          className="flex-1 min-w-0 text-left text-[13px] font-semibold text-ink leading-[1.4] break-words outline-none focus-visible:underline"
        >
          {card.title}
        </button>
        <span data-card-menu className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 -mr-1 -mt-0.5">
          <Menu
            label={`Actions for ${card.title}`}
            align="end"
            portal
            trigger={<Icon name="more" size={14} />}
            triggerClassName="h-6 w-6 rounded-md text-ink-3 hover:bg-raised hover:text-ink"
            items={menu}
          />
        </span>
      </div>
      {chips.length > 0 && (
        <ul aria-label="Properties" className="list-none m-0 p-0 flex flex-wrap gap-1">
          {chips.map((c) => (
            <li
              key={c.key}
              title={c.title}
              className={cn('h-5 px-1.5 rounded-[4px] border text-[11px] leading-[18px] max-w-full truncate', !c.color && 'border-line-3 text-ink-2 bg-raised')}
              style={c.color ? chipStyle(c.color) : undefined}
            >
              <span className="sr-only">{c.title.slice(0, c.title.length - c.label.length)}</span>
              {c.label}
            </li>
          ))}
        </ul>
      )}
      {(card.comments.length > 0 || card.agents.length > 0) && (
        <div className="flex items-center gap-2.5 text-[11.5px] text-ink-3 min-w-0">
          {card.comments.length > 0 && <span>{plural(card.comments.length, 'comment')}</span>}
          {linked.slice(-2).map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1 min-w-0" title={`${a.title}: ${a.status}`}>
              <StatusDot status={a.status} size={6} />
              <span className="truncate max-w-[120px]">{a.title}</span>
            </span>
          ))}
          {card.agents.length > linked.length && linked.length === 0 && <span>{plural(card.agents.length, 'agent')} (archived)</span>}
        </div>
      )}
    </div>
  );
}

function NewCardInput({ columnName, onCreate, onCancel }: { columnName: string; onCreate: (title: string, again: boolean) => Promise<boolean>; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (again: boolean) => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await onCreate(t, again);
    setBusy(false);
    if (ok) setTitle('');
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(true);
      }}
    >
      <label className="sr-only" htmlFor={`new-card-${columnName}`}>
        Title of the new card in {columnName}
      </label>
      <textarea
        id={`new-card-${columnName}`}
        autoFocus
        rows={2}
        value={title}
        maxLength={500}
        placeholder="Title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit(true);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
        className="w-full resize-none rounded-md border border-line-3 bg-card px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
      />
      <div className="flex gap-2">
        <Button size={28} variant="primary" type="submit" disabled={!title.trim() || busy}>
          Add card
        </Button>
        <Button size={28} variant="ghost" onClick={onCancel}>
          Done
        </Button>
      </div>
    </form>
  );
}

interface ColumnHeaderProps {
  board: KanbanBoard;
  column: BoardColumn;
  index: number;
  count: number;
  draggable: boolean;
  apply: (ops: BoardOp[]) => Promise<BoardOpResult[] | null>;
  announce: (message: string) => void;
  onAdd: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

function ColumnHeader({ board, column, index, count, draggable, apply, announce, onAdd, onDragStart, onDragEnd }: ColumnHeaderProps) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.name);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!renaming) setName(column.name);
  }, [column.name, renaming]);
  const commit = () => {
    setRenaming(false);
    const n = name.trim();
    if (n && n !== column.name) void apply([{ op: 'update_column', column: column.id, name: n }]);
    else setName(column.name);
  };
  const last = board.columns.length - 1;
  const items: MenuItem[] = [
    { id: 'rename', label: 'Rename', icon: 'pencil', onSelect: () => setRenaming(true) },
    { id: 'add', label: 'New card', icon: 'plus', onSelect: onAdd },
    ...(index > 0 ? [{ id: 'left', label: 'Move left', onSelect: () => void apply([{ op: 'move_column', column: column.id, index: index - 1 }]).then((r) => r && announce(`Moved column ${column.name} left.`)) }] : []),
    ...(index < last ? [{ id: 'right', label: 'Move right', onSelect: () => void apply([{ op: 'move_column', column: column.id, index: index + 1 }]).then((r) => r && announce(`Moved column ${column.name} right.`)) }] : []),
    ...BOARD_COLORS.map((c) => ({ id: `color-${c}`, label: `${COLOR_LABEL[c]}`, checked: column.color === c, onSelect: () => void apply([{ op: 'update_column', column: column.id, color: c }]) })),
    ...(board.columns.length > 1 ? [{ id: 'delete', label: 'Delete column', icon: 'trash' as const, danger: true, onSelect: () => setDeleting(true) }] : []),
  ];
  return (
    <div draggable={draggable && !renaming} onDragStart={onDragStart} onDragEnd={onDragEnd} className="flex items-center gap-1.5 px-2 pt-2 pb-1.5 shrink-0 cursor-grab active:cursor-grabbing">
      {renaming ? (
        <input
          autoFocus
          aria-label={`Rename column ${column.name}`}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              setName(column.name);
              setRenaming(false);
            }
          }}
          className="h-7 flex-1 min-w-0 px-2 rounded-md border border-accent bg-card text-[12.5px] font-semibold text-ink outline-none"
        />
      ) : (
        <h3 className="m-0 min-w-0 flex items-center gap-1.5">
          <span className="truncate rounded-[5px] border px-1.5 text-[12px] leading-[20px] font-semibold" style={chipStyle(column.color)}>
            {column.name}
          </span>
          <span className="text-[12px] text-ink-3 font-normal">
            {count}
            <span className="sr-only"> {count === 1 ? 'card' : 'cards'}</span>
          </span>
        </h3>
      )}
      <span className="flex-1" />
      <button type="button" aria-label={`New card in ${column.name}`} title="New card" onClick={onAdd} className="h-6 w-6 grid place-items-center rounded-md text-ink-3 hover:bg-raised hover:text-ink">
        <Icon name="plus" size={14} />
      </button>
      <Menu label={`Column ${column.name} actions`} align="end" portal trigger={<Icon name="more" size={14} />} triggerClassName="h-6 w-6 rounded-md text-ink-3 hover:bg-raised hover:text-ink" items={items} />
      {deleting && <DeleteColumnDialog board={board} column={column} count={count} apply={apply} announce={announce} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function DeleteColumnDialog({
  board,
  column,
  count,
  apply,
  announce,
  onClose,
}: {
  board: KanbanBoard;
  column: BoardColumn;
  count: number;
  apply: (ops: BoardOp[]) => Promise<BoardOpResult[] | null>;
  announce: (message: string) => void;
  onClose: () => void;
}) {
  const others = board.columns.filter((c) => c.id !== column.id);
  const [to, setTo] = useState(others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const res = await apply([{ op: 'delete_column', column: column.id, ...(count ? { moveCardsTo: to } : {}) }]);
    setBusy(false);
    if (res) {
      announce(`Deleted column ${column.name}.`);
      onClose();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${column.name}?`}
      width={420}
      description={count ? `Its ${plural(count, 'card')} move to another column.` : 'It has no cards.'}
      footer={
        <>
          <Button size={32} variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size={32} variant="danger" onClick={() => void run()} disabled={busy || (count > 0 && !to)}>
            Delete column
          </Button>
        </>
      }
    >
      {count > 0 && <Select label="Move its cards to" value={to} onChange={(e) => setTo(e.target.value)} options={others.map((c) => ({ value: c.id, label: c.name }))} />}
    </Dialog>
  );
}
