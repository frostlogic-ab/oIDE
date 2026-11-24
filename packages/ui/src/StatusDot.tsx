import type { AgentStatus, SubagentStatus } from '@oide/protocol';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';
import { agentStatusMeta, subagentStatusMeta } from './status.js';

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  /** Agent status (or pass `color`). */
  status?: AgentStatus;
  subagentStatus?: SubagentStatus;
  color?: string;
  /** 6 (status bar, subagent chips), 7 (tiles, sidebar), 8 (header counts, focus title). */
  size?: 6 | 7 | 8;
}

export function StatusDot({ status, subagentStatus, color, size = 7, className, style, ...rest }: StatusDotProps) {
  const c =
    color ??
    (subagentStatus ? subagentStatusMeta(subagentStatus).color : status ? agentStatusMeta(status).color : 'var(--color-ink-4)');
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{ width: size, height: size, background: c, ...style }}
      {...rest}
    />
  );
}

export interface StatusLabelProps extends HTMLAttributes<HTMLSpanElement> {
  status: AgentStatus;
  /** Appended after the label, e.g. "14m" gives "Running · 14m". */
  detail?: ReactNode;
  /** Override the label text. */
  label?: string;
}

/** Agent status as coloured dot + text (tile header: 11px, status colour). */
export function StatusLabel({ status, detail, label, className, style, ...rest }: StatusLabelProps) {
  const meta = agentStatusMeta(status);
  return (
    <span
      className={cn('inline-flex items-center gap-[5px] text-[11px] whitespace-nowrap', className)}
      style={{ color: meta.color, ...style }}
      {...rest}
    >
      <StatusDot color={meta.color} size={7} />
      {label ?? meta.label}
      {detail != null && detail !== '' && <> · {detail}</>}
    </span>
  );
}
