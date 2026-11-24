import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';
import { Icon, type IconName } from './Icon.js';
import type { StatusTone } from './status.js';

/** Uppercase section label: 11px, 600, letter-spacing 0.08em, ink-3. */
export function SectionLabel({
  className,
  as: Tag = 'span',
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: 'span' | 'h2' | 'h3' | 'div' }) {
  return <Tag className={cn('text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3 m-0', className)} {...rest} />;
}

const CARD_TONE: Record<StatusTone, string> = {
  default: 'bg-card border-line-2',
  muted: 'bg-card border-line-2',
  needs: 'bg-warn-bg border-warn-line',
  review: 'bg-review-bg border-review-line',
  error: 'bg-bad-bg border-bad-line',
};

export interface CardProps extends HTMLAttributes<HTMLElement> {
  tone?: StatusTone;
  /** 10 (panels, artifact cards) or 12 (agent tiles, project cards). */
  radius?: 10 | 12;
  as?: 'div' | 'article' | 'section' | 'li';
  interactive?: boolean;
}

export function Card({ tone = 'default', radius = 12, as: Tag = 'div', interactive, className, ...rest }: CardProps) {
  return (
    <Tag
      className={cn(
        'border overflow-hidden',
        CARD_TONE[tone],
        radius === 12 ? 'rounded-xl' : 'rounded-lg',
        interactive && 'hover:border-line-hover',
        className,
      )}
      {...rest}
    />
  );
}

export type BadgeTone = 'neutral' | 'warn' | 'ok' | 'bad' | 'review' | 'accent' | 'violet';

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'border-line-4 text-ink-3',
  warn: 'border-warn-line text-warn bg-warn-bg',
  ok: 'border-ok-line text-ok bg-ok-bg-2',
  bad: 'border-bad-line text-bad bg-bad-bg',
  review: 'border-review-line text-review bg-review-bg',
  accent: 'border-accent text-accent',
  violet: 'border-violet-bg text-violet',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: IconName;
}

/** Small pill: "not reviewed", "Bypass", "read only", "asks first", "edited". */
export function Badge({ tone = 'neutral', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 h-5 px-[7px] rounded-[10px] border text-[11px] whitespace-nowrap leading-none',
        BADGE_TONE[tone],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

export interface DiffStatProps extends HTMLAttributes<HTMLSpanElement> {
  additions: number;
  deletions: number;
  /** When set, prefixes "N files · ". */
  files?: number;
  mono?: boolean;
}

/** "+214 −37" in ok/bad colours (U+2212 minus, as on the canvas). */
export function DiffStat({ additions, deletions, files, mono, className, ...rest }: DiffStatProps) {
  return (
    <span className={cn(mono && 'font-mono', className)} {...rest}>
      {files != null && (
        <>
          {files} {files === 1 ? 'file' : 'files'} ·{' '}
        </>
      )}
      <span className="text-ok">+{additions}</span> <span className="text-bad">−{deletions}</span>
    </span>
  );
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action, className, ...rest }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center gap-2 px-6 py-10 text-ink-3', className)} {...rest}>
      {icon && (
        <span className="flex items-center justify-center w-10 h-10 rounded-lg bg-card border border-line-2 text-ink-3 mb-1">
          <Icon name={icon} size={18} />
        </span>
      )}
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {description && <div className="text-[12.5px] leading-[1.5] max-w-[420px]">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: number;
  label?: string;
}

export function Spinner({ size = 16, label = 'Loading', className, ...rest }: SpinnerProps) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex', className)} {...rest}>
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="animate-spin">
        <circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-line-4)" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}
