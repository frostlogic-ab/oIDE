import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn.js';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the radiogroup, e.g. "Project scope". */
  label: string;
  /**
   * `header`: card background, 9px radius (project scope switcher in the header).
   * `inset`: chrome background, 8px radius (Settings "Default focus", Provider).
   */
  variant?: 'header' | 'inset';
  size?: 26 | 28;
  className?: string;
}

/** A radiogroup of pill buttons. Arrow keys move the selection (roving tabindex). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = 'header',
  size = 26,
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.filter((o) => !o.disabled);

  const onKeyDown = (e: KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key) || !enabled.length) return;
    e.preventDefault();
    const idx = Math.max(0, enabled.findIndex((o) => o.value === value));
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (idx + 1) % enabled.length
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (idx - 1 + enabled.length) % enabled.length
          : e.key === 'Home'
            ? 0
            : enabled.length - 1;
    const opt = enabled[next]!;
    onChange(opt.value);
    refs.current[options.indexOf(opt)]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex items-center p-[3px] border border-line-2',
        variant === 'header' ? 'gap-0.5 rounded-[9px] bg-card' : 'gap-1 rounded-md bg-chrome',
        className,
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'border-0 rounded-sm whitespace-nowrap disabled:opacity-50',
              size === 26 ? 'h-[26px] px-2.5 text-[12px]' : 'h-7 px-3 text-[12.5px]',
              selected ? 'bg-selected text-ink' : 'bg-transparent text-ink-3 hover:text-ink-2',
              selected && variant === 'inset' && 'font-semibold',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
