import type { SubagentStatus } from '@oide/protocol';
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.js';
import { Icon, type IconName } from './Icon.js';
import { modelFamily, modelLetter, subagentStatusMeta } from './status.js';
import { StatusDot } from './StatusDot.js';
import { Tooltip } from './Tooltip.js';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * `context`: 26px rounded chip on `selected` (Spawn goal context: artifact, file, URL).
   * `tag`: 3px 8px, radius 6, on `selected` (Agent tools list).
   */
  variant?: 'context' | 'tag';
  icon?: IconName;
  iconColor?: string;
  /** Renders a remove button with this accessible label. */
  onRemove?: () => void;
  removeLabel?: string;
}

export function Chip({ variant = 'context', icon, iconColor, onRemove, removeLabel = 'Remove', className, children, ...rest }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center bg-selected whitespace-nowrap',
        variant === 'context' ? 'h-[26px] gap-1.5 px-2 rounded-[13px] text-[12px] text-ink' : 'px-2 py-[3px] rounded-sm text-[12px] text-ink-2',
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={13} style={{ color: iconColor ?? 'var(--color-ink-3)' }} />}
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="ml-0.5 -mr-1 w-5 h-5 inline-flex items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-raised border-0 bg-transparent"
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

export interface FilterChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  /** `warn` colours the label amber ("Needs you · 2"). */
  tone?: 'default' | 'warn';
}

/** Wall filter pills: 28px, radius 14, toggled with aria-pressed. */
export const FilterChip = forwardRef<HTMLButtonElement, FilterChipProps>(function FilterChip(
  { selected, tone = 'default', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={cn(
        'h-7 px-2.5 rounded-[14px] border text-[12px] whitespace-nowrap',
        selected ? 'bg-selected border-line-3' : 'bg-transparent border-line-2 hover:border-line-3',
        tone === 'warn' ? 'text-warn' : selected ? 'text-ink' : 'text-ink-2',
        className,
      )}
      {...rest}
    />
  );
});

/** Just the model letter (mono 9.5px, ink-3), used inside chips and subagent tree rows. */
export function ModelLetter({ model, className }: { model?: string; className?: string }) {
  return (
    <span className={cn('font-mono text-[9.5px] text-ink-3', className)} aria-hidden="true">
      {modelLetter(model)}
    </span>
  );
}

export interface ModelLetterChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  name: string;
  model?: string;
  status: SubagentStatus;
  /** Tooltip content; defaults to `${name} · ${detailText}`. */
  detail?: ReactNode;
  /** Plain-text description, e.g. "Haiku, low effort · routed as simple · done · 2m". */
  detailText?: string;
}

/**
 * Subagent chip on Wall tiles: 22px pill with status dot, name and model letter (H/S/O).
 * Needs-permission subagents get the amber treatment. Hover/focus shows the detail tooltip.
 */
export function ModelLetterChip({ name, model, status, detail, detailText, className, type = 'button', ...rest }: ModelLetterChipProps) {
  const meta = subagentStatusMeta(status);
  const needs = status === 'needs-permission';
  const text = detailText ?? `${modelFamily(model)} · ${meta.label.toLowerCase()}`;
  return (
    <Tooltip content={detail ?? `${name} · ${text}`} placement="top-start">
      <button
        type={type}
        aria-label={`Subagent ${name} · ${text}`}
        className={cn(
          'h-[22px] inline-flex items-center gap-[5px] px-[7px] rounded-[11px] border text-[11px] whitespace-nowrap box-border',
          needs
            ? 'border-warn-line bg-warn-bg-2 text-warn'
            : 'border-line-4 bg-panel text-ink-2 hover:border-line-hover hover:text-ink',
          className,
        )}
        {...rest}
      >
        <StatusDot color={meta.color} size={6} />
        {name}
        <ModelLetter model={model} />
      </button>
    </Tooltip>
  );
}
