import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';
import { C } from './status.js';
import { Tooltip } from './Tooltip.js';

/**
 * Context ring: how full an agent's (or subagent's) context window is.
 * Thresholds default to the canvas (amber from 65%, red from 85%); screens pass the values from
 * Settings › Agents › Context (`contextWarnAt`, `contextSuggestCompactAt`).
 */
export interface ContextThresholds {
  /** Fraction (0–1) where the ring turns amber. */
  warnAt?: number;
  /** Fraction (0–1) where the ring turns red (and "suggest /compact" kicks in). */
  dangerAt?: number;
}

export const DEFAULT_CONTEXT_THRESHOLDS = { warnAt: 0.65, dangerAt: 0.85 } as const;

export type ContextLevel = 'ok' | 'warn' | 'danger';

export function clampFraction(used: number): number {
  if (!Number.isFinite(used) || used < 0) return 0;
  return used > 1 ? 1 : used;
}

export function contextLevel(used: number, t: ContextThresholds = {}): ContextLevel {
  const warnAt = t.warnAt ?? DEFAULT_CONTEXT_THRESHOLDS.warnAt;
  const dangerAt = t.dangerAt ?? DEFAULT_CONTEXT_THRESHOLDS.dangerAt;
  const f = clampFraction(used);
  if (f >= dangerAt) return 'danger';
  if (f >= warnAt) return 'warn';
  return 'ok';
}

export function contextColor(level: ContextLevel): string {
  return level === 'danger' ? C.bad : level === 'warn' ? C.warn : C.accent;
}

/** 0–100 integer, as shown next to the ring. */
export function contextPercent(used: number): number {
  return Math.round(clampFraction(used) * 100);
}

/** Fraction of the window used, from token counts (input + cache read + cache creation). */
export function contextFraction(contextUsed: number, contextWindow: number): number {
  return contextWindow > 0 ? clampFraction(contextUsed / contextWindow) : 0;
}

export interface ContextRingProps extends ContextThresholds {
  /** Fraction 0–1. */
  used: number;
  /** 14 (lists), 22 (tiles, headers) or 44 (compact dialog). */
  size?: number;
  strokeWidth?: number;
  /** Colour override (subagent rings on the canvas always use the accent). */
  color?: string;
  className?: string;
}

export function ContextRing({ used, size = 22, strokeWidth, color, className, ...t }: ContextRingProps) {
  const pct = contextPercent(used);
  const stroke = color ?? contextColor(contextLevel(used, t));
  const sw = strokeWidth ?? (size >= 40 ? 4 : 5);
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" className={cn('shrink-0', className)} data-level={contextLevel(used, t)}>
      <circle cx="18" cy="18" r="14" fill="none" stroke="var(--color-line-4)" strokeWidth={sw} />
      {pct > 0 && (
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke={stroke}
          strokeWidth={sw}
          pathLength={100}
          strokeDasharray={`${pct} 100`}
          strokeLinecap="round"
          transform="rotate(-90 18 18)"
        />
      )}
    </svg>
  );
}

export interface ContextRingButtonProps
  extends ContextThresholds,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  used: number;
  /** What the ring is for, used in the accessible label ("Build the window shell layout"). */
  subject?: string;
  /** `tile`: borderless 26px pill (Wall); `header`: bordered 30px pill with "Context N%" (Focus). */
  variant?: 'tile' | 'header';
  tooltip?: ReactNode;
  /** Classes for the word "Context" in the header variant (e.g. hide it when the header is narrow). */
  labelClassName?: string;
}

/** Clickable ring: opens the "Compact this session?" confirm. oIDE never compacts without it. */
export function ContextRingButton({
  used,
  subject,
  variant = 'tile',
  tooltip,
  labelClassName,
  warnAt,
  dangerAt,
  className,
  type = 'button',
  ...rest
}: ContextRingButtonProps) {
  const pct = contextPercent(used);
  const label = `Context ${pct}% full${subject ? ` for ${subject}` : ''}. Compact this session`;
  const button = (
    <button
      type={type}
      aria-label={label}
      className={cn(
        'flex items-center border rounded-full bg-transparent hover:bg-selected focus-visible:bg-selected',
        variant === 'tile'
          ? 'h-[26px] gap-[5px] pl-[3px] pr-1.5 border-transparent hover:border-line-3 text-ink-2 text-[11px]'
          : 'h-[30px] gap-1.5 pl-[5px] pr-2.5 border-line-3 text-ink text-[12px]',
        className,
      )}
      {...rest}
    >
      <ContextRing used={used} size={22} warnAt={warnAt} dangerAt={dangerAt} />
      {variant === 'tile' ? (
        <span className="font-mono">{pct}%</span>
      ) : (
        <span>
          <span className={labelClassName}>Context </span>
          <span className="font-mono">{pct}%</span>
        </span>
      )}
    </button>
  );
  return (
    <Tooltip content={tooltip ?? (variant === 'tile' ? `Context ${pct}% full · click to /compact` : 'Click to /compact this session')}>
      {button}
    </Tooltip>
  );
}

/** Small "ring + 81%" used in lists (Focus "Other agents", inspector cards). */
export function ContextMeter({ used, color, className, ...t }: { used: number; color?: string; className?: string } & ContextThresholds) {
  const pct = contextPercent(used);
  return (
    <span title={`Context ${pct}% full`} className={cn('inline-flex items-center gap-[3px] text-[10.5px] text-ink-3 font-normal', className)}>
      <ContextRing used={used} size={14} color={color} {...t} />
      <span className="font-mono">{pct}%</span>
    </span>
  );
}
