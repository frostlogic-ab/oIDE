/**
 * The open card (right of the board, ADR 0022): title, column, every property (edited by type), the
 * agents started on it, its Markdown description, comments, "Start an agent" and Delete. Each edit
 * is a board operation, saved at once (text fields when they lose focus or on Enter).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { AgentSummary, ArtifactMeta, BoardCard, BoardOp, BoardOpResult, BoardProperty, BoardValueInput, KanbanBoard } from '@oide/protocol';
import { agentStatusMeta, Button, Checkbox, Dialog, Icon, IconButton, Select, StatusDot, cn } from '@oide/ui';
import { ResizableAside } from '../../../components/ResizableAside';
import { PANELS } from '../../../lib/panels';
import { useRouter } from '../../../stores/router';
import { MarkdownView } from '../Preview';
import { relativeTime } from '../model';
import { chipStyle, goalForCard } from './boardModel';

export interface CardPanelProps {
  meta: ArtifactMeta;
  board: KanbanBoard;
  card: BoardCard;
  agents: Record<string, AgentSummary | undefined>;
  apply: (ops: BoardOp[]) => Promise<BoardOpResult[] | null>;
  announce: (message: string) => void;
  onClose: () => void;
  /** Whether the panel holds typed text not saved yet (the description being edited, a comment). */
  onDirtyChange: (dirty: boolean) => void;
  onEditProperties: () => void;
}

export function CardPanel({ meta, board, card, agents, apply, announce, onClose, onDirtyChange, onEditProperties }: CardPanelProps) {
  const headingId = useId();
  const [descDirty, setDescDirty] = useState(false);
  const [commentDirty, setCommentDirty] = useState(false);
  useEffect(() => onDirtyChange(descDirty || commentDirty), [descDirty, commentDirty, onDirtyChange]);
  // Closing the panel leaves nothing typed behind.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = (patch: Omit<Extract<BoardOp, { op: 'update_card' }>, 'op' | 'cardId'>) => apply([{ op: 'update_card', cardId: card.id, ...patch }]);
  const setProp = (p: BoardProperty, v: BoardValueInput) => update({ props: { [p.id]: v } });

  const startAgent = () => {
    useRouter.getState().navigate('spawn', {
      ...(meta.projectId ? { projectId: meta.projectId } : {}),
      goal: goalForCard(board, card, { boardId: meta.id, boardTitle: meta.title }),
      context: [{ kind: 'artifact', id: meta.id, title: meta.title }],
      card: { boardId: meta.id, cardId: card.id },
    });
  };

  return (
    <ResizableAside panel={PANELS.boardCard} aria-labelledby={headingId} className="min-h-0 flex flex-col bg-panel border-l border-line box-border">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-line shrink-0">
        <span id={headingId} className="text-[12px] font-semibold text-ink-3 uppercase tracking-[0.04em]">
          Card
        </span>
        <span className="flex-1" />
        <IconButton icon="trash" aria-label={`Delete ${card.title}`} title="Delete card" onClick={() => setConfirmDelete(true)} />
        <IconButton icon="close" aria-label="Close the card" title="Close (Esc)" onClick={onClose} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-5">
        <TitleField key={card.id} title={card.title} onCommit={(title) => void update({ title })} />

        <dl className="m-0 grid grid-cols-[minmax(96px,34%)_1fr] gap-x-3 gap-y-2 items-center text-[12.5px]">
          <dt className="text-ink-3">Column</dt>
          <dd className="m-0">
            <Select
              label="Column"
              hideLabel
              size={28}
              value={card.column}
              onChange={(e) => {
                const to = e.target.value;
                void apply([{ op: 'move_card', cardId: card.id, column: to }]).then((r) => r && announce(`Moved ${card.title} to ${board.columns.find((c) => c.id === to)?.name ?? ''}.`));
              }}
              options={board.columns.map((c) => ({ value: c.id, label: c.name }))}
            />
          </dd>
          {board.properties.map((p) => (
            <PropertyRow key={p.id} property={p} value={card.props[p.id]} onChange={(v) => void setProp(p, v)} />
          ))}
        </dl>
        <div>
          <Button size={28} variant="ghost" icon="settings" onClick={onEditProperties}>
            Edit properties
          </Button>
        </div>

        <section aria-label="Agents" className="flex flex-col gap-2">
          <h4 className="m-0 text-[11px] font-semibold text-ink-3 uppercase tracking-[0.04em]">Agents</h4>
          {card.agents.length === 0 && <p className="m-0 text-[12.5px] text-ink-3">No agent has worked on this card yet.</p>}
          <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
            {[...card.agents].reverse().map((id) => {
              const a = agents[id];
              return (
                <li key={id} className="flex items-center gap-2 min-w-0 text-[12.5px]">
                  {a ? (
                    <>
                      <StatusDot status={a.status} />
                      <a
                        href="#focus"
                        className="flex-1 min-w-0 truncate text-link hover:text-link-hover"
                        onClick={(e) => {
                          e.preventDefault();
                          useRouter.getState().navigate('focus', { agentId: a.id });
                        }}
                      >
                        {a.title}
                      </a>
                      <span className="text-ink-3 shrink-0">{agentStatusMeta(a.status).label}</span>
                    </>
                  ) : (
                    <>
                      <StatusDot />
                      <span className="flex-1 min-w-0 truncate text-ink-3">An agent that is no longer on the Wall</span>
                      <Button size={28} variant="ghost" onClick={() => void apply([{ op: 'unlink_agent', cardId: card.id, agentId: id }])}>
                        Remove
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <div>
            <Button size={32} variant="primary" icon="agents" onClick={startAgent}>
              Start an agent
            </Button>
          </div>
          <p className="m-0 text-[11.5px] text-ink-3 leading-[1.5]">The agent gets the card as its task and keeps it up to date on the board.</p>
        </section>

        <DescriptionField key={`body-${card.id}`} body={card.body} onSave={(body) => update({ body })} onDirty={setDescDirty} />

        <Comments card={card} agents={agents} apply={apply} onDirty={setCommentDirty} />
      </div>
      {confirmDelete && (
        <Dialog
          open
          onClose={() => setConfirmDelete(false)}
          title={`Delete ${card.title}?`}
          width={420}
          description="The card, its description and comments go. Restore an older version from History to get it back."
          footer={
            <>
              <Button size={32} variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                size={32}
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void apply([{ op: 'delete_card', cardId: card.id }]).then((r) => {
                    if (!r) return;
                    announce(`Deleted ${card.title}.`);
                    onClose();
                  });
                }}
              >
                Delete card
              </Button>
            </>
          }
        />
      )}
    </ResizableAside>
  );
}

/** The title: saved on blur or Enter; an agent's new title shows unless you are typing. */
function TitleField({ title, onCommit }: { title: string; onCommit: (title: string) => void }) {
  const [value, setValue] = useState(title);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(title);
  }, [title]);
  const commit = () => {
    editing.current = false;
    const t = value.trim();
    if (t && t !== title) onCommit(t);
    else setValue(title);
  };
  return (
    <textarea
      aria-label="Title"
      value={value}
      rows={Math.min(5, Math.max(1, Math.ceil(value.length / 34)))}
      maxLength={500}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          editing.current = false;
          setValue(title);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      className="w-full resize-none bg-transparent border border-transparent rounded-md px-1 -mx-1 text-[18px] font-semibold text-ink leading-[1.35] outline-none hover:border-line-2 focus:border-accent"
    />
  );
}

/** One property: a select, chips to toggle, or a field for its type. Text fields save on blur / Enter. */
function PropertyRow({ property: p, value, onChange }: { property: BoardProperty; value: BoardCard['props'][string] | undefined; onChange: (v: BoardValueInput) => void }) {
  const id = useId();
  return (
    <>
      {/* Each editor carries the property's name as its own label. */}
      <dt className="text-ink-3 truncate" title={p.name}>
        {p.name}
      </dt>
      <dd className="m-0 min-w-0">
        {p.type === 'select' ? (
          <Select
            id={id}
            label={p.name}
            hideLabel
            size={28}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value || null)}
            options={[{ value: '', label: 'Empty' }, ...(p.options ?? []).map((o) => ({ value: o.id, label: o.name }))]}
          />
        ) : p.type === 'multi_select' ? (
          <MultiSelect id={id} property={p} value={Array.isArray(value) ? value : []} onChange={onChange} />
        ) : p.type === 'checkbox' ? (
          <Checkbox id={id} checked={value === true} onChange={(on) => onChange(on)} label={<span className="sr-only">{p.name}</span>} />
        ) : (
          <TextValue id={id} property={p} value={value === undefined ? '' : String(value)} onChange={onChange} />
        )}
      </dd>
    </>
  );
}

function TextValue({ id, property: p, value, onChange }: { id: string; property: BoardProperty; value: string; onChange: (v: BoardValueInput) => void }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const commit = (next = draft) => {
    editing.current = false;
    if (next === value) return;
    if (!next.trim()) return onChange(null);
    onChange(p.type === 'number' ? Number(next) : next);
  };
  const type = p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : p.type === 'url' ? 'url' : 'text';
  return (
    <input
      id={id}
      aria-label={p.name}
      type={type}
      value={draft}
      placeholder="Empty"
      maxLength={2000}
      onFocus={() => (editing.current = true)}
      onChange={(e) => {
        setDraft(e.target.value);
        // A date picker has no typing to wait for.
        if (type === 'date') commit(e.target.value);
      }}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          e.stopPropagation();
          editing.current = false;
          setDraft(value);
        }
      }}
      className={cn('w-full h-7 px-2 rounded-md border border-line-3 bg-card text-[12.5px] text-ink outline-none focus:border-accent placeholder:text-ink-4', p.type === 'url' && 'font-mono text-[12px]')}
    />
  );
}

function MultiSelect({ id, property: p, value, onChange }: { id: string; property: BoardProperty; value: string[]; onChange: (v: BoardValueInput) => void }) {
  const [adding, setAdding] = useState('');
  const toggle = (optionId: string) => onChange(value.includes(optionId) ? value.filter((x) => x !== optionId) : [...value, optionId]);
  return (
    <div className="flex flex-col gap-1.5">
      <ul id={id} aria-label={p.name} className="list-none m-0 p-0 flex flex-wrap gap-1">
        {(p.options ?? []).map((o) => {
          const on = value.includes(o.id);
          return (
            <li key={o.id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(o.id)}
                className={cn('h-6 px-1.5 rounded-[5px] border text-[11.5px] inline-flex items-center gap-1', !on && 'opacity-60 border-dashed')}
                style={on ? chipStyle(o.color) : { borderColor: 'var(--color-line-3)', color: 'var(--color-ink-3)' }}
              >
                {on && <Icon name="check" size={11} />}
                {o.name}
              </button>
            </li>
          );
        })}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const name = adding.trim();
          if (!name) return;
          // A new name adds the option and selects it.
          onChange([...value, name]);
          setAdding('');
        }}
      >
        <input
          aria-label={`Add an option to ${p.name}`}
          value={adding}
          maxLength={100}
          placeholder="Add an option…"
          onChange={(e) => setAdding(e.target.value)}
          className="w-full h-7 px-2 rounded-md border border-line-2 bg-transparent text-[12px] text-ink outline-none focus:border-accent placeholder:text-ink-4"
        />
      </form>
    </div>
  );
}

/** The card's Markdown description: rendered, with Edit (Ctrl/Cmd+Enter saves, Esc cancels). */
function DescriptionField({ body, onSave, onDirty }: { body: string; onSave: (body: string) => Promise<BoardOpResult[] | null>; onDirty: (dirty: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  useEffect(() => onDirty(editing && draft !== startedFrom.current), [editing, draft, onDirty]);
  const [busy, setBusy] = useState(false);
  const startedFrom = useRef(body);
  /** An agent saved another text while you were editing (yours stays in the box until you save or cancel). */
  const changedMeanwhile = editing && body !== draft && body !== startedFrom.current;
  const edit = () => {
    startedFrom.current = body;
    setDraft(body);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    const res = draft === body ? [] : await onSave(draft);
    setBusy(false);
    if (res) setEditing(false);
  };
  return (
    <section aria-label="Description" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 className="m-0 text-[11px] font-semibold text-ink-3 uppercase tracking-[0.04em]">Description</h4>
        <span className="flex-1" />
        {!editing && (
          <Button size={28} variant="ghost" icon="pencil" onClick={edit}>
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <>
          {changedMeanwhile && (
            <p role="status" className="m-0 text-[12px] text-warn">
              The description changed while you were editing. Saving keeps yours (the other text stays in History).
            </p>
          )}
          <textarea
            aria-label="Description (Markdown)"
            autoFocus
            value={draft}
            rows={12}
            maxLength={50_000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(false);
              }
            }}
            className="w-full resize-y rounded-md border border-line-3 bg-card px-2.5 py-2 font-mono text-[12.5px] leading-[1.55] text-ink outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <Button size={28} variant="primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button size={28} variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : body.trim() ? (
        <MarkdownView source={body} className="text-[13px]" />
      ) : (
        <button type="button" onClick={edit} className="text-left text-[12.5px] text-ink-3 rounded-md border border-dashed border-line-3 px-3 py-2.5 hover:text-ink-2">
          Add a description: the spec an agent builds from (Markdown).
        </button>
      )}
    </section>
  );
}

function Comments({
  card,
  agents,
  apply,
  onDirty,
}: {
  card: BoardCard;
  agents: Record<string, AgentSummary | undefined>;
  apply: (ops: BoardOp[]) => Promise<BoardOpResult[] | null>;
  onDirty: (dirty: boolean) => void;
}) {
  const [text, setText] = useState('');
  useEffect(() => onDirty(text.trim() !== ''), [text, onDirty]);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const res = await apply([{ op: 'add_comment', cardId: card.id, text: t }]);
    setBusy(false);
    if (res) setText('');
  };
  const who = (author: string, name: string | undefined) => {
    if (author === 'user') return 'You';
    const id = author.startsWith('agent:') ? author.slice(6) : author;
    return agents[id]?.title ?? name ?? 'An agent';
  };
  return (
    <section aria-label="Comments" className="flex flex-col gap-2">
      <h4 className="m-0 text-[11px] font-semibold text-ink-3 uppercase tracking-[0.04em]">Comments{card.comments.length ? ` (${card.comments.length})` : ''}</h4>
      <ol className="list-none m-0 p-0 flex flex-col gap-2.5">
        {card.comments.map((m) => (
          <li key={m.id} className="group flex flex-col gap-1 rounded-lg border border-line-2 bg-card px-3 py-2">
            <div className="flex items-center gap-2 text-[11.5px]">
              {m.author !== 'user' && <Icon name="agents" size={12} className="text-ink-3" />}
              <span className="font-semibold text-ink-2 truncate">{who(m.author, m.authorName)}</span>
              <span className="text-ink-3 shrink-0">{relativeTime(m.ts)}</span>
              <span className="flex-1" />
              <button
                type="button"
                aria-label={`Delete comment by ${who(m.author, m.authorName)}`}
                title="Delete comment"
                onClick={() => void apply([{ op: 'delete_comment', cardId: card.id, commentId: m.id }])}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 h-5 w-5 grid place-items-center rounded text-ink-3 hover:text-bad"
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
            <p className="m-0 text-[12.5px] text-ink leading-[1.5] whitespace-pre-wrap break-words">{m.text}</p>
          </li>
        ))}
      </ol>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Add a comment"
          rows={2}
          value={text}
          maxLength={5000}
          placeholder="Add a comment…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
          className="w-full resize-y rounded-md border border-line-3 bg-card px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent placeholder:text-ink-4"
        />
        <div>
          <Button size={28} type="submit" disabled={!text.trim() || busy}>
            Comment
          </Button>
        </div>
      </form>
    </section>
  );
}
