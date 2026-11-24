import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn.js';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  tabs: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  /** Accessible name of the tablist ("Inspector"). */
  label: string;
  /** Prefix for tab/panel ids; pair with `tabPanelProps(idPrefix, id)` on the panel. */
  idPrefix: string;
  /**
   * `underline`: 34px tabs with a 2px accent underline (Focus inspector, Add custom dialog).
   * `pill`: 32px bordered pills, selected = accent border on `selected-2` (Settings presets).
   */
  variant?: 'underline' | 'pill';
  className?: string;
}

export function tabId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

export function tabPanelProps(idPrefix: string, id: string) {
  return { role: 'tabpanel' as const, id: `${idPrefix}-panel-${id}`, 'aria-labelledby': tabId(idPrefix, id), tabIndex: 0 };
}

/** WAI-ARIA tabs with automatic activation and arrow-key navigation. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, variant = 'underline', className }: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = tabs.filter((t) => !t.disabled);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key) || !enabled.length) return;
    e.preventDefault();
    const idx = Math.max(0, enabled.findIndex((t) => t.id === value));
    const next =
      e.key === 'ArrowRight' ? (idx + 1) % enabled.length : e.key === 'ArrowLeft' ? (idx - 1 + enabled.length) % enabled.length : e.key === 'Home' ? 0 : enabled.length - 1;
    const tab = enabled[next]!;
    onChange(tab.id);
    refs.current[tabs.indexOf(tab)]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(variant === 'underline' ? 'flex overflow-x-auto' : 'flex gap-1.5 flex-wrap', className)}
    >
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={tabId(idPrefix, t.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={cn(
              'whitespace-nowrap disabled:opacity-50',
              variant === 'underline'
                ? cn(
                    'h-[34px] px-1.5 border-0 border-b-2 bg-transparent text-[12px]',
                    selected ? 'border-accent text-ink font-semibold' : 'border-transparent text-ink-3 hover:text-ink-2',
                  )
                : cn(
                    'h-8 px-3.5 rounded-md border text-[13px] text-ink flex items-center gap-2',
                    selected ? 'border-accent bg-selected-2' : 'border-line-3 bg-transparent hover:bg-raised',
                  ),
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
