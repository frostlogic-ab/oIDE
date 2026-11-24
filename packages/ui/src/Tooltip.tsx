import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from './cn.js';

export type TooltipPlacement = 'top' | 'top-start' | 'top-end' | 'bottom' | 'bottom-start' | 'bottom-end';

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element (button, link). Receives `aria-describedby`. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: TooltipPlacement;
  className?: string;
}

const PLACEMENT: Record<TooltipPlacement, string> = {
  top: 'bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2',
  'top-start': 'bottom-[calc(100%+6px)] left-0',
  'top-end': 'bottom-[calc(100%+6px)] right-0',
  bottom: 'top-[calc(100%+6px)] left-1/2 -translate-x-1/2',
  'bottom-start': 'top-[calc(100%+6px)] left-0',
  'bottom-end': 'top-[calc(100%+6px)] right-0',
};

/**
 * Canvas tooltip (`.tip`): light #E6E8EB bubble, dark 12px/500 text, shown on hover and on
 * keyboard focus of the trigger. Pure CSS, no portal; the trigger keeps its own semantics.
 */
export function Tooltip({ content, children, placement = 'top', className }: TooltipProps) {
  const id = useId();
  const trigger = isValidElement(children) ? cloneElement(children, { 'aria-describedby': id }) : children;
  return (
    <span className="relative inline-flex group/tip">
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-30 hidden whitespace-nowrap px-2.5 py-[7px] rounded-[7px]',
          'bg-toast text-on-accent text-[12px] font-medium shadow-tip',
          'group-hover/tip:block group-focus-within/tip:block',
          PLACEMENT[placement],
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
