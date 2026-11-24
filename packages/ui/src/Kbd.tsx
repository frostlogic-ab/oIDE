import type { HTMLAttributes } from 'react';
import { cn } from './cn.js';

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** `on-fill` for shortcuts drawn on amber/accent buttons (e.g. "Allow once  Y"). */
  tone?: 'default' | 'on-fill' | 'warn';
}

/** Keyboard shortcut hint: mono 10.5px, 1px border, radius 4 (canvas `.kbd`). */
export function Kbd({ tone = 'default', className, ...rest }: KbdProps) {
  return (
    <kbd
      className={cn(
        'font-mono text-[10.5px] leading-[1.4] px-[5px] py-px rounded-[4px] border font-normal',
        tone === 'default' && 'border-line-3 text-ink-3',
        tone === 'on-fill' && 'border-warn-kbd text-current',
        tone === 'warn' && 'border-warn-line text-warn',
        className,
      )}
      {...rest}
    />
  );
}
