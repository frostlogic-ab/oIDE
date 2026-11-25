import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { filterSlashItems, slashItems, type SlashItem } from '../lib/slash';

/** Rows moved by PageUp / PageDown. */
const PAGE = 8;

export interface SlashMenuState {
  open: boolean;
  /** Matching items in display order. */
  items: SlashItem[];
  /** How many commands the agent has in all. */
  total: number;
  active: number;
  setActive(i: number): void;
  listId: string;
  optionId(i: number): string;
  /** Handles the menu's keys; true when the key was used (the caller should do nothing else with it). */
  onKeyDown(e: KeyboardEvent<HTMLElement>): boolean;
  pick(item: SlashItem): void;
  /** Props for the text input: combobox semantics wired to the list. */
  inputProps: {
    role: 'combobox';
    'aria-expanded': boolean;
    'aria-controls': string | undefined;
    'aria-autocomplete': 'list';
    'aria-activedescendant': string | undefined;
  };
}

/**
 * State for the `/` menu over a text input. Opens while the whole text is "/" plus a word (no space);
 * Esc closes it until the text changes. Picking calls `onPick` (the caller inserts `/<name> `).
 */
export function useSlashMenu({ text, commands, onPick }: { text: string; commands: readonly string[]; onPick(item: SlashItem): void }): SlashMenuState {
  const listId = useId();
  const all = useMemo(() => slashItems(commands), [commands]);
  const query = /^\/\S*$/.test(text) ? text : null;
  const items = useMemo(() => (query !== null ? filterSlashItems(all, query) : []), [all, query]);
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const open = query !== null && dismissedFor !== text && items.length > 0;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (dismissedFor !== null && dismissedFor !== text) setDismissedFor(null);
  }, [text, dismissedFor]);

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const pick = (item: SlashItem) => {
    setDismissedFor(text);
    onPick(item);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): boolean => {
    if (!open) return false;
    const n = items.length;
    const move = (i: number) => {
      e.preventDefault();
      setActive(i);
      return true;
    };
    switch (e.key) {
      case 'ArrowDown':
        return move((active + 1) % n);
      case 'ArrowUp':
        return move((active - 1 + n) % n);
      case 'PageDown':
        return move(Math.min(n - 1, active + PAGE));
      case 'PageUp':
        return move(Math.max(0, active - PAGE));
      case 'Home':
        return move(0);
      case 'End':
        return move(n - 1);
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setDismissedFor(text);
        return true;
      case 'Enter':
      case 'Tab': {
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
        const item = items[Math.min(active, n - 1)];
        if (!item) return false;
        e.preventDefault();
        pick(item);
        return true;
      }
      default:
        return false;
    }
  };

  return {
    open,
    items,
    total: all.length,
    active: Math.min(active, Math.max(0, items.length - 1)),
    setActive,
    listId,
    optionId,
    onKeyDown,
    pick,
    inputProps: {
      role: 'combobox',
      'aria-expanded': open,
      'aria-controls': open ? listId : undefined,
      'aria-autocomplete': 'list',
      'aria-activedescendant': open && items.length ? optionId(Math.min(active, items.length - 1)) : undefined,
    },
  };
}

/**
 * The `/` popup (Focus composer). One fixed-height row per command: the name in mono, truncated
 * with the full command in the row's tooltip, the description right-aligned and truncated. Built-in
 * CLI commands first, then skills, plugins and one group per MCP server. Capped at 320 px; the active
 * row is kept in view. Mouse: hover moves the highlight, click picks.
 */
export function SlashMenu({ menu, className }: { menu: SlashMenuState; className?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const { items, active } = menu;

  useEffect(() => {
    if (!menu.open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
    // The first row of a group brings its group header into view too.
    const header = el?.previousElementSibling;
    if (header?.getAttribute('role') === 'presentation') (header as HTMLElement).scrollIntoView?.({ block: 'nearest' });
  }, [active, menu.open]);

  if (!menu.open) return null;

  // Consecutive items of a group render under one header.
  const groups: Array<{ key: string; label: string; rows: Array<{ item: SlashItem; index: number }> }> = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last && last.key === item.group) last.rows.push({ item, index });
    else groups.push({ key: item.group, label: item.groupLabel, rows: [{ item, index }] });
  });
  const count = items.length === menu.total ? `${menu.total} ${menu.total === 1 ? 'command' : 'commands'}` : `${items.length} of ${menu.total}`;

  return (
    <div className={`absolute bottom-[calc(100%+6px)] left-0 right-0 z-30 flex flex-col overflow-hidden rounded-[10px] border border-line-3 bg-card shadow-dialog ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-3 h-7 shrink-0 px-3 border-b border-line-2 text-[11px] text-ink-3">
        <span className="font-semibold tracking-[0.08em] uppercase">Commands</span>
        <span aria-live="polite">{count}</span>
      </div>
      <div ref={listRef} id={menu.listId} role="listbox" aria-label="Commands" className="max-h-[264px] overflow-y-auto overscroll-contain py-1">
        {groups.map((g) => (
          <div key={g.key} role="group" aria-labelledby={`${menu.listId}-${g.key}`}>
            <div id={`${menu.listId}-${g.key}`} role="presentation" className="h-6 flex items-center px-3 text-[10.5px] font-semibold tracking-[0.08em] uppercase text-ink-4 truncate">
              {g.label}
            </div>
            {g.rows.map(({ item, index }) => (
              <div
                key={item.name}
                id={menu.optionId(index)}
                data-index={index}
                role="option"
                aria-selected={index === active}
                title={item.description ? `/${item.name} · ${item.description}` : `/${item.name}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  menu.pick(item);
                }}
                onMouseMove={() => index !== active && menu.setActive(index)}
                className={`flex items-center gap-3 h-7 px-3 cursor-pointer whitespace-nowrap overflow-hidden ${index === active ? 'bg-selected' : ''}`}
              >
                <span className="min-w-0 shrink truncate font-mono text-[12px] text-ink">{item.label}</span>
                {item.description && <span className="ml-auto min-w-0 max-w-[60%] shrink-[2] truncate text-right text-[12px] text-ink-3">{item.description}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 h-[26px] shrink-0 px-3 border-t border-line-2 text-[11px] text-ink-4" aria-hidden="true">
        <span>↑ ↓ move</span>
        <span>Enter or Tab insert</span>
        <span>Esc close</span>
      </div>
    </div>
  );
}
