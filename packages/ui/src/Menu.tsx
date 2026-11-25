import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';
import { Icon, type IconName } from './Icon.js';

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  icon?: IconName;
  disabled?: boolean;
  danger?: boolean;
  /** Shortcut hint shown on the right. */
  hint?: ReactNode;
  /** Set on every item of a pick-one menu: the item becomes `menuitemradio` and the checked one shows a tick. */
  checked?: boolean;
  /** Longer explanation on hover (why an item is disabled, for example). */
  title?: string;
}

export interface MenuProps {
  /** Trigger content. */
  trigger: ReactNode;
  /** Accessible label for the trigger (required when the trigger is icon-only). */
  label?: string;
  items: ReadonlyArray<MenuItem>;
  align?: 'start' | 'end';
  triggerClassName?: string;
  className?: string;
  /**
   * Render the list in `document.body` at a fixed position under the trigger, for triggers inside
   * a box that clips (`overflow: hidden`). It closes on scroll and resize instead of drifting.
   */
  portal?: boolean;
}

/** Dropdown menu button: role="menu", arrow keys / Home / End, Enter selects, Esc closes. */
export function Menu({ trigger, label, items, align = 'start', triggerClassName, className, portal = false }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || list.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    if (!portal) return () => document.removeEventListener('mousedown', onDown);
    // A fixed list would drift away from its trigger: close instead (scrolls inside the list are fine).
    const onMove = (e: Event) => {
      if (e.type === 'scroll' && list.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, portal]);

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const enabledIdx = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const move = (dir: 1 | -1) => {
    if (!enabledIdx.length) return;
    const pos = enabledIdx.indexOf(active);
    const next = enabledIdx[(pos + dir + enabledIdx.length) % enabledIdx.length]!;
    setActive(next);
  };

  const openMenu = (focusLast = false) => {
    if (portal && btn.current) {
      const r = btn.current.getBoundingClientRect();
      setPos(align === 'end' ? { top: r.bottom + 4, right: window.innerWidth - r.right } : { top: r.bottom + 4, left: r.left });
    }
    setActive(focusLast ? (enabledIdx[enabledIdx.length - 1] ?? 0) : (enabledIdx[0] ?? 0));
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') setActive(enabledIdx[0] ?? 0);
    else if (e.key === 'End') setActive(enabledIdx[enabledIdx.length - 1] ?? 0);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const popup = (
    <div
      ref={list}
      id={menuId}
      role="menu"
      aria-label={label}
      onKeyDown={onMenuKey}
      style={portal ? pos : undefined}
      className={cn(
        'z-40 min-w-[180px] py-1 rounded-md border border-line-3 bg-card shadow-dialog',
        portal ? 'fixed' : cn('absolute top-[calc(100%+4px)]', align === 'end' ? 'right-0' : 'left-0'),
      )}
    >
      {items.map((it, i) => (
        <button
          key={it.id}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          type="button"
          role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={it.checked}
          title={it.title}
          tabIndex={i === active ? 0 : -1}
          disabled={it.disabled}
          onMouseEnter={() => !it.disabled && setActive(i)}
          onClick={() => {
            close();
            it.onSelect();
          }}
          className={cn(
            'w-full flex items-center gap-2 h-8 px-3 border-0 text-left text-[12.5px] bg-transparent disabled:opacity-50',
            i === active ? 'bg-selected' : '',
            it.danger ? 'text-bad' : 'text-ink',
          )}
        >
          {it.checked !== undefined ? (
            <Icon name="check" size={14} className={it.checked ? 'text-accent' : 'invisible'} />
          ) : (
            it.icon && <Icon name={it.icon} size={14} className="text-ink-3" />
          )}
          <span className="flex-1">{it.label}</span>
          {it.hint && <span className="text-ink-3 text-[11px]">{it.hint}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={wrap} className={cn('relative inline-flex', className)}>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu(e.key === 'ArrowUp');
          }
        }}
        className={cn(
          'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm border border-line-3 bg-transparent text-ink text-[12px] hover:bg-raised',
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open && (portal ? createPortal(popup, document.body) : popup)}
    </div>
  );
}
