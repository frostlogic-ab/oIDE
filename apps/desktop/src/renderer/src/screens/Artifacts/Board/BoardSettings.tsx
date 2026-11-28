/**
 * "Columns and properties" (ADR 0022): everything about a board's shape in one keyboard-friendly
 * dialog. Columns (name, colour, order, delete with where their cards go) and properties (name,
 * type, shown on cards, order, delete; options of selects with name and colour). Each change is a
 * board operation saved at once; names save when the field loses focus or on Enter.
 */
import { useEffect, useId, useState } from 'react';
import { BOARD_COLORS, BOARD_PROPERTY_TYPES, type BoardColor, type BoardColumn, type BoardOp, type BoardOpResult, type BoardProperty, type BoardPropertyType, type KanbanBoard } from '@oide/protocol';
import { Button, Checkbox, Dialog, IconButton, Select, Tabs, tabPanelProps } from '@oide/ui';
import { plural } from '../../../lib/format';
import { chipStyle, COLOR_LABEL, PROPERTY_TYPE_LABEL, typeChangeLoss } from './boardModel';

type Apply = (ops: BoardOp[]) => Promise<BoardOpResult[] | null>;
const COLOR_OPTIONS = BOARD_COLORS.map((c) => ({ value: c, label: COLOR_LABEL[c] }));

export function BoardSettings({ board, apply, onClose, initialTab = 'properties' }: { board: KanbanBoard; apply: Apply; onClose: () => void; initialTab?: 'columns' | 'properties' }) {
  const [tab, setTab] = useState<'columns' | 'properties'>(initialTab);
  const tabsId = useId();
  return (
    <Dialog
      open
      onClose={onClose}
      title="Columns and properties"
      description="Changes save as you make them; History keeps every version."
      width={620}
      footer={
        <Button size={32} variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3 min-h-[320px]">
        <Tabs
          idPrefix={tabsId}
          label="Board settings"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'properties' as const, label: 'Properties' },
            { id: 'columns' as const, label: 'Columns' },
          ]}
        />
        <div {...tabPanelProps(tabsId, tab)} className="flex flex-col gap-3 max-h-[52vh] overflow-y-auto pr-1">
          {tab === 'columns' ? <ColumnsTab board={board} apply={apply} /> : <PropertiesTab board={board} apply={apply} />}
        </div>
      </div>
    </Dialog>
  );
}

/** A name field that saves on blur or Enter (and shows a newer saved name when not being edited). */
function NameField({ label, value, onSave, className }: { label: string; value: string; onSave: (name: string) => void; className?: string }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const n = draft.trim();
    if (n && n !== value) onSave(n);
    else setDraft(value);
  };
  return (
    <input
      aria-label={label}
      value={draft}
      maxLength={100}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          // Esc puts the name back; the dialog stays open.
          e.stopPropagation();
          setDraft(value);
          setEditing(false);
        }
      }}
      className={className ?? 'h-8 flex-1 min-w-0 px-2 rounded-md border border-line-3 bg-card text-[13px] text-ink outline-none focus:border-accent'}
    />
  );
}

function ColorPick({ label, value, onChange }: { label: string; value: BoardColor; onChange: (c: BoardColor) => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="w-3 h-3 rounded-full border" style={{ background: chipStyle(value).color, borderColor: chipStyle(value).borderColor }} />
      <Select label={label} hideLabel size={28} value={value} onChange={(e) => onChange(e.target.value as BoardColor)} options={COLOR_OPTIONS} className="w-[96px]" />
    </span>
  );
}

function ColumnsTab({ board, apply }: { board: KanbanBoard; apply: Apply }) {
  const [name, setName] = useState('');
  const counts = new Map(board.columns.map((c) => [c.id, board.cards.filter((x) => x.column === c.id).length]));
  return (
    <>
      <ol className="list-none m-0 p-0 flex flex-col gap-2">
        {board.columns.map((c, i) => (
          <ColumnRow key={c.id} board={board} column={c} index={i} count={counts.get(c.id) ?? 0} apply={apply} />
        ))}
      </ol>
      <form
        className="flex items-center gap-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (n) void apply([{ op: 'add_column', name: n }]).then((r) => r && setName(''));
        }}
      >
        <input
          aria-label="New column name"
          placeholder="New column"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          className="h-8 flex-1 px-2 rounded-md border border-line-3 bg-card text-[13px] text-ink outline-none focus:border-accent placeholder:text-ink-4"
        />
        <Button size={32} type="submit" icon="plus" disabled={!name.trim()}>
          Add column
        </Button>
      </form>
    </>
  );
}

function ColumnRow({ board, column: c, index: i, count, apply }: { board: KanbanBoard; column: BoardColumn; index: number; count: number; apply: Apply }) {
  const [deleting, setDeleting] = useState(false);
  const others = board.columns.filter((x) => x.id !== c.id);
  const [to, setTo] = useState(others[0]?.id ?? '');
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line-2 bg-card p-2">
      <div className="flex items-center gap-2">
        <ColorPick label={`Colour of ${c.name}`} value={c.color} onChange={(color) => void apply([{ op: 'update_column', column: c.id, color }])} />
        <NameField label={`Name of column ${c.name}`} value={c.name} onSave={(n) => void apply([{ op: 'update_column', column: c.id, name: n }])} />
        <span className="text-[12px] text-ink-3 w-[64px] shrink-0">{plural(count, 'card')}</span>
        <IconButton icon="arrow-up" aria-label={`Move ${c.name} left`} title="Move left" disabled={i === 0} onClick={() => void apply([{ op: 'move_column', column: c.id, index: i - 1 }])} />
        <IconButton icon="arrow-down" aria-label={`Move ${c.name} right`} title="Move right" disabled={i === board.columns.length - 1} onClick={() => void apply([{ op: 'move_column', column: c.id, index: i + 1 }])} />
        <IconButton icon="trash" aria-label={`Delete column ${c.name}`} title="Delete column" disabled={board.columns.length === 1} onClick={() => setDeleting((d) => !d)} />
      </div>
      {deleting && (
        <div role="group" aria-label={`Delete column ${c.name}`} className="flex items-end gap-2 flex-wrap rounded-md bg-bad-bg border border-bad-line p-2">
          {count > 0 ? (
            <Select label={`Move its ${plural(count, 'card')} to`} size={28} value={to} onChange={(e) => setTo(e.target.value)} options={others.map((x) => ({ value: x.id, label: x.name }))} />
          ) : (
            <span className="text-[12.5px] text-ink-2">It has no cards.</span>
          )}
          <Button size={28} variant="danger" onClick={() => void apply([{ op: 'delete_column', column: c.id, ...(count ? { moveCardsTo: to } : {}) }])}>
            Delete column
          </Button>
          <Button size={28} variant="ghost" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}

function PropertiesTab({ board, apply }: { board: KanbanBoard; apply: Apply }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<BoardPropertyType>('select');
  return (
    <>
      {board.properties.length === 0 && <p className="m-0 text-[12.5px] text-ink-3">No properties yet. Add one below: a priority, an effort, a type, a due date…</p>}
      <ol className="list-none m-0 p-0 flex flex-col gap-2">
        {board.properties.map((p, i) => (
          <PropertyRow key={p.id} board={board} property={p} index={i} apply={apply} />
        ))}
      </ol>
      <form
        className="flex items-end gap-2 pt-1 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (n) void apply([{ op: 'add_property', name: n, type }]).then((r) => r && setName(''));
        }}
      >
        <input
          aria-label="New property name"
          placeholder="New property"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          className="h-8 flex-1 min-w-[160px] px-2 rounded-md border border-line-3 bg-card text-[13px] text-ink outline-none focus:border-accent placeholder:text-ink-4"
        />
        <Select label="Type" hideLabel size={34} value={type} onChange={(e) => setType(e.target.value as BoardPropertyType)} options={BOARD_PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABEL[t] }))} />
        <Button size={32} type="submit" icon="plus" disabled={!name.trim()}>
          Add property
        </Button>
      </form>
    </>
  );
}

function PropertyRow({ board, property: p, index: i, apply }: { board: KanbanBoard; property: BoardProperty; index: number; apply: Apply }) {
  const [deleting, setDeleting] = useState(false);
  const [option, setOption] = useState('');
  /** A type change that would lose values, waiting for the user to confirm it. */
  const [retype, setRetype] = useState<{ to: BoardPropertyType; lost: number } | null>(null);
  const used = board.cards.filter((c) => c.props[p.id] !== undefined).length;
  const changeType = (to: BoardPropertyType) => {
    if (to === p.type) return;
    const lost = typeChangeLoss(board, p.id, to);
    if (lost > 0) setRetype({ to, lost });
    else void apply([{ op: 'update_property', property: p.id, type: to }]);
  };
  const hasOptions = p.type === 'select' || p.type === 'multi_select';
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line-2 bg-card p-2">
      <div className="flex items-center gap-2 flex-wrap">
        <NameField label={`Name of property ${p.name}`} value={p.name} onSave={(n) => void apply([{ op: 'update_property', property: p.id, name: n }])} />
        <Select
          label={`Type of ${p.name}`}
          hideLabel
          size={28}
          value={p.type}
          onChange={(e) => changeType(e.target.value as BoardPropertyType)}
          options={BOARD_PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABEL[t] }))}
          className="w-[120px]"
        />
        <Checkbox checked={p.showOnCard} onChange={(on) => void apply([{ op: 'update_property', property: p.id, showOnCard: on }])} label={<span className="text-[12px] text-ink-2">On cards</span>} />
        <IconButton icon="arrow-up" aria-label={`Move ${p.name} up`} title="Move up" disabled={i === 0} onClick={() => void apply([{ op: 'move_property', property: p.id, index: i - 1 }])} />
        <IconButton icon="arrow-down" aria-label={`Move ${p.name} down`} title="Move down" disabled={i === board.properties.length - 1} onClick={() => void apply([{ op: 'move_property', property: p.id, index: i + 1 }])} />
        <IconButton icon="trash" aria-label={`Delete property ${p.name}`} title="Delete property" onClick={() => setDeleting((d) => !d)} />
      </div>
      {retype && (
        <div role="group" aria-label={`Change the type of ${p.name}`} className="flex items-center gap-2 flex-wrap rounded-md bg-bad-bg border border-bad-line p-2">
          <span className="text-[12.5px] text-ink-2 flex-1">
            As {PROPERTY_TYPE_LABEL[retype.to]}, {plural(retype.lost, 'card')} lose{retype.lost === 1 ? 's' : ''} {retype.lost === 1 ? 'its value' : 'their values'} (or part of {retype.lost === 1 ? 'it' : 'them'}).
          </span>
          <Button
            size={28}
            variant="danger"
            onClick={() => {
              const to = retype.to;
              setRetype(null);
              void apply([{ op: 'update_property', property: p.id, type: to }]);
            }}
          >
            Change type
          </Button>
          <Button size={28} variant="ghost" onClick={() => setRetype(null)}>
            Cancel
          </Button>
        </div>
      )}
      {deleting && (
        <div role="group" aria-label={`Delete property ${p.name}`} className="flex items-center gap-2 flex-wrap rounded-md bg-bad-bg border border-bad-line p-2">
          <span className="text-[12.5px] text-ink-2 flex-1">{used ? `Its value on ${plural(used, 'card')} goes too.` : 'No card has a value for it.'}</span>
          <Button size={28} variant="danger" onClick={() => void apply([{ op: 'delete_property', property: p.id }])}>
            Delete property
          </Button>
          <Button size={28} variant="ghost" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
        </div>
      )}
      {hasOptions && (
        <div className="flex flex-col gap-1.5 pl-3 border-l-2 border-line-2">
          <ul aria-label={`Options of ${p.name}`} className="list-none m-0 p-0 flex flex-col gap-1.5">
            {(p.options ?? []).map((o) => (
              <li key={o.id} className="flex items-center gap-2">
                <ColorPick label={`Colour of ${o.name}`} value={o.color} onChange={(color) => void apply([{ op: 'update_option', property: p.id, option: o.id, color }])} />
                <NameField
                  label={`Name of option ${o.name}`}
                  value={o.name}
                  onSave={(n) => void apply([{ op: 'update_option', property: p.id, option: o.id, name: n }])}
                  className="h-7 flex-1 min-w-0 px-2 rounded-md border border-line-3 bg-panel text-[12.5px] text-ink outline-none focus:border-accent"
                />
                <IconButton icon="close" aria-label={`Delete option ${o.name}`} title="Delete option" onClick={() => void apply([{ op: 'delete_option', property: p.id, option: o.id }])} />
              </li>
            ))}
          </ul>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = option.trim();
              if (n) void apply([{ op: 'add_option', property: p.id, name: n }]).then((r) => r && setOption(''));
            }}
          >
            <input
              aria-label={`New option of ${p.name}`}
              placeholder="New option"
              value={option}
              maxLength={100}
              onChange={(e) => setOption(e.target.value)}
              className="h-7 flex-1 px-2 rounded-md border border-line-2 bg-panel text-[12.5px] text-ink outline-none focus:border-accent placeholder:text-ink-4"
            />
            <Button size={28} type="submit" disabled={!option.trim()}>
              Add option
            </Button>
          </form>
        </div>
      )}
    </li>
  );
}
