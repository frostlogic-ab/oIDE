/**
 * Settings building blocks, copied from Settings.dc.html: `.row`, `.rl`, `.rt`, `.rd`, `.sec`, `.inp`.
 */
import { useId, type ReactNode } from 'react';
import { cn } from '@oide/ui';
import type { Settings } from '@oide/protocol';
import { ipcErrorMessage } from '../../lib/bridge';
import { useSettings } from '../../stores/settings';
import { toast } from '../../stores/ui';

/** `.inp`: 34px, radius 8, line-3 border, card fill. */
export const inp = 'h-[34px] px-2.5 rounded-md border border-line-3 bg-card text-ink text-[13px] outline-none focus:border-accent box-border min-w-0 placeholder:text-ink-4 disabled:opacity-50';
export const inpInvalid = '!border-bad';
/** Small outline button (h30/32 in the design). */
export const outlineBtn =
  'inline-flex items-center justify-center h-[30px] px-3 rounded-[7px] border border-line-3 bg-transparent text-ink text-[12.5px] hover:bg-raised disabled:opacity-50 whitespace-nowrap';

export function H1({ children }: { children: ReactNode }) {
  return <h1 className="m-0 mb-1.5 text-[20px] font-semibold">{children}</h1>;
}

export function Rd({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <span id={id} className={cn('text-[12.5px] text-ink-3 leading-[1.45]', className)}>
      {children}
    </span>
  );
}

export function Sec({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('m-0 mt-[22px] text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3', className)}>{children}</h2>;
}

/**
 * One settings row: title + description on the left, the control on the right. `control` receives
 * the ids to wire `aria-labelledby` / `aria-describedby`.
 */
export function Row({
  title,
  desc,
  children,
  error,
}: {
  title: ReactNode;
  desc?: ReactNode;
  error?: ReactNode;
  children: (ids: { titleId: string; descId?: string; errorId?: string }) => ReactNode;
}) {
  const base = useId();
  const titleId = `${base}-t`;
  const descId = desc ? `${base}-d` : undefined;
  const errorId = error ? `${base}-e` : undefined;
  return (
    <div className="flex items-center gap-4 py-3.5 border-b border-line-6 flex-wrap">
      <div className="flex-1 min-w-[260px] flex flex-col gap-[3px]">
        <span id={titleId} className="font-semibold">
          {title}
        </span>
        {desc && <Rd id={descId}>{desc}</Rd>}
        {error && (
          <span id={errorId} role="alert" className="text-[12px] text-bad">
            {error}
          </span>
        )}
      </div>
      {children({ titleId, descId, errorId })}
    </div>
  );
}

/** `aria-describedby` from optional ids. */
export const describedBy = (...ids: Array<string | undefined>) => ids.filter(Boolean).join(' ') || undefined;

/** Save a deep-merge patch through the settings store; errors become toasts. */
export async function savePatch(patch: Record<string, unknown>): Promise<Settings | null> {
  try {
    return await useSettings.getState().update(patch);
  } catch (err) {
    toast(`Could not save: ${ipcErrorMessage(err)}`, 'error');
    return null;
  }
}

/** Pills radiogroup like the design's model pills (accent-free, selected = `selected`). */
export function Pills<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 26,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | undefined;
  onChange: (v: T) => void;
  size?: 26 | 28;
}) {
  const move = (dir: 1 | -1) => {
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    const next = options[(i + dir + options.length) % options.length]!;
    onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex flex-wrap gap-1 p-[3px] rounded-md bg-chrome border border-line-2"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (value === undefined && o === options[0]) ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'border-0 rounded-sm px-3 whitespace-nowrap',
              size === 26 ? 'h-[26px] text-[12px]' : 'h-7 text-[12.5px]',
              on ? 'bg-selected text-ink font-semibold' : 'bg-transparent text-ink-3 hover:text-ink-2',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
