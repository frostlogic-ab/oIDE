import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
}

/** Dropdown menu button: role="menu", arrow keys / Home / End, Enter selects, Esc closes. */
export function Menu({ trigger, label, items, align = 'start', triggerClassName, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

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
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className={cn(
            'absolute top-[calc(100%+4px)] z-40 min-w-[180px] py-1 rounded-md border border-line-3 bg-card shadow-dialog',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((it, i) => (
            <button
              key={it.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
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
              {it.icon && <Icon name={it.icon} size={14} className="text-ink-3" />}
              <span className="flex-1">{it.label}</span>
              {it.hint && <span className="text-ink-3 text-[11px]">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
