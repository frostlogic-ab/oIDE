import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@oide/ui';

export interface CardOption<T extends string> {
  value: T;
  label: ReactNode;
  desc?: ReactNode;
  disabled?: boolean;
  /** Red treatment when selected (Bypass permissions). */
  danger?: boolean;
}

/**
 * Spawn's card choices (Mode, Models, How agents pick models): a radiogroup of cards with a
 * 1.5px border, accent when selected. Arrow keys move the selection (roving tabindex).
 */
export function CardRadioGroup<T extends string>({
  options,
  value,
  onChange,
  labelledBy,
  columns,
  size = 'md',
}: {
  options: ReadonlyArray<CardOption<T>>;
  value: T;
  onChange: (value: T) => void;
  labelledBy: string;
  columns?: number;
  size?: 'sm' | 'md';
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key) || !enabled.length) return;
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
  const selectedEnabled = options.some((o) => o.value === value && !o.disabled);
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        const focusable = on || (!selectedEnabled && o === enabled[0]);
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={o.disabled || undefined}
            tabIndex={focusable && !o.disabled ? 0 : -1}
            onClick={() => !o.disabled && onChange(o.value)}
            className={cn(
              'flex flex-col p-2.5 rounded-lg text-left text-ink border-[1.5px] box-border',
              size === 'md' ? 'gap-1 text-[12.5px]' : 'gap-[3px] text-[13px]',
              on ? (o.danger ? 'border-bad bg-[#241517]' : 'border-accent bg-selected-2') : 'border-line-3 bg-transparent hover:border-line-hover',
              o.disabled && 'opacity-45 cursor-not-allowed hover:border-line-3',
            )}
          >
            <span className="font-semibold">{o.label}</span>
            {o.desc && <span className="text-[11.5px] text-ink-3 leading-[1.35]">{o.desc}</span>}
          </button>
        );
      })}
    </div>
  );
}
