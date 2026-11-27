import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';
import { Icon } from './Icon.js';
import type { MenuItem } from './Menu.js';

/** A context menu entry: an item, or a divider between groups. */
export type ContextMenuEntry = MenuItem | { id: string; separator: true };

export interface ContextMenuProps {
  /** Viewport point the menu opens at (the pointer, or a row's corner for the keyboard). */
  at: { x: number; y: number };
  items: ReadonlyArray<ContextMenuEntry>;
  /** Accessible name of the menu ("Actions for index.ts"). */
  label: string;
  /** Called when the menu closes (after a pick, Esc, Tab, a click outside, scroll or resize). */
  onClose: () => void;
}

const isSep = (e: ContextMenuEntry): e is { id: string; separator: true } => 'separator' in e;
const MARGIN = 4;

/**
 * Right-click menu at a point: role="menu" in `document.body`, kept inside the window, first item
 * focused; arrow keys / Home / End move, Enter picks, Esc or Tab closes. Focus returns to the element
 * that had it when the menu opened (a tree row), unless the pick moved focus elsewhere.
 */
export function ContextMenu({ at, items, label, onClose }: ContextMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.map((it, i) => (isSep(it) || it.disabled ? -1 : i)).filter((i) => i >= 0);
  const [active, setActive] = useState(enabled[0] ?? 0);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  if (!opener.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;

  // Keep the menu inside the window (open upwards / leftwards near the edges).
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(at.x, window.innerWidth - r.width - MARGIN));
    const top = at.y + r.height + MARGIN > window.innerHeight ? Math.max(MARGIN, at.y - r.height) : at.y;
    setPos({ left, top });
  }, [at.x, at.y, items.length]);

  useEffect(() => {
    itemRefs.current[active]?.focus();
  }, [active]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = () => closeRef.current();
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, []);

  const finish = (refocus: boolean) => {
    const el = opener.current;
    onClose();
    if (refocus && el && document.contains(el)) el.focus();
  };

  const move = (dir: 1 | -1) => {
    if (!enabled.length) return;
    const i = enabled.indexOf(active);
    setActive(enabled[(i + dir + enabled.length) % enabled.length]!);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') setActive(enabled[0] ?? 0);
    else if (e.key === 'End') setActive(enabled[enabled.length - 1] ?? 0);
    else if (e.key === 'Escape' || e.key === 'Tab') finish(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={list}
      role="menu"
      aria-label={label}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-[200px] py-1 rounded-md border border-line-3 bg-card shadow-dialog"
    >
      {items.map((it, i) =>
        isSep(it) ? (
          <div key={it.id} role="separator" className="my-1 h-px bg-line-2" />
        ) : (
          <button
            key={it.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="menuitem"
            title={it.title}
            tabIndex={i === active ? 0 : -1}
            disabled={it.disabled}
            onMouseEnter={() => !it.disabled && setActive(i)}
            onClick={() => {
              finish(true);
              it.onSelect();
            }}
            className={cn(
              'w-full flex items-center gap-2 h-7 px-3 border-0 text-left text-[12.5px] cursor-pointer disabled:opacity-50 disabled:cursor-default outline-none',
              i === active ? 'bg-selected' : 'bg-transparent',
              it.danger ? 'text-bad' : 'text-ink',
            )}
          >
            {it.icon ? <Icon name={it.icon} size={14} className={it.danger ? '' : 'text-ink-3'} /> : <span aria-hidden="true" className="w-[14px]" />}
            <span className="flex-1">{it.label}</span>
            {it.hint && <span className="text-ink-3 text-[11px] ml-4">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
