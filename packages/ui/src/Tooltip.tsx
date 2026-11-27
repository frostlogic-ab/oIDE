import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';

export type TooltipPlacement = 'top' | 'top-start' | 'top-end' | 'bottom' | 'bottom-start' | 'bottom-end';

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element (button, link). Receives `aria-describedby`. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: TooltipPlacement;
  className?: string;
  /**
   * Render the bubble in `document.body` at fixed coordinates, so a scrolling or clipping
   * ancestor (`overflow: auto`) cannot cut it off. Off by default: the pure-CSS bubble is cheaper.
   */
  portal?: boolean;
}

const PLACEMENT: Record<TooltipPlacement, string> = {
  top: 'bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2',
  'top-start': 'bottom-[calc(100%+6px)] left-0',
  'top-end': 'bottom-[calc(100%+6px)] right-0',
  bottom: 'top-[calc(100%+6px)] left-1/2 -translate-x-1/2',
  'bottom-start': 'top-[calc(100%+6px)] left-0',
  'bottom-end': 'top-[calc(100%+6px)] right-0',
};

const BUBBLE = 'pointer-events-none whitespace-nowrap px-2.5 py-[7px] rounded-[7px] bg-toast text-on-accent text-[12px] font-medium shadow-tip';
const GAP = 6;

/** Fixed-position style for a portalled bubble next to `rect`, in viewport coordinates. */
export function tooltipPosition(
  rect: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'>,
  placement: TooltipPlacement,
  viewportWidth: number,
): CSSProperties {
  const above = placement.startsWith('top');
  const style: CSSProperties = above ? { top: rect.top - GAP } : { top: rect.bottom + GAP };
  const shiftY = above ? '-100%' : '0';
  if (placement.endsWith('-start')) return { ...style, left: rect.left, transform: `translateY(${shiftY})` };
  if (placement.endsWith('-end')) return { ...style, right: viewportWidth - rect.right, transform: `translateY(${shiftY})` };
  return { ...style, left: rect.left + rect.width / 2, transform: `translate(-50%, ${shiftY})` };
}

/**
 * Canvas tooltip (`.tip`): light #E6E8EB bubble, dark 12px/500 text, shown on hover and on
 * keyboard focus of the trigger. Pure CSS, no portal, unless `portal` is set; either way the
 * trigger keeps its own semantics.
 */
export function Tooltip({ content, children, placement = 'top', className, portal = false }: TooltipProps) {
  const id = useId();
  const trigger = isValidElement(children) ? cloneElement(children, { 'aria-describedby': id }) : children;
  if (portal) {
    return (
      <PortalTooltip id={id} content={content} placement={placement} className={className}>
        {trigger}
      </PortalTooltip>
    );
  }
  return (
    <span className="relative inline-flex group/tip">
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cn(
          'absolute z-30 hidden group-hover/tip:block group-focus-within/tip:block',
          BUBBLE,
          PLACEMENT[placement],
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}

interface PortalTooltipProps {
  id: string;
  content: ReactNode;
  placement: TooltipPlacement;
  className?: string;
  children: ReactNode;
}

function PortalTooltip({ id, content, placement, className, children }: PortalTooltipProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  // Hover and focus each hold the bubble open; it closes when neither does.
  const holds = useRef({ hover: false, focus: false });
  const show = (why: 'hover' | 'focus') => {
    holds.current[why] = true;
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setStyle(tooltipPosition(rect, placement, window.innerWidth));
  };
  const release = (why: 'hover' | 'focus') => {
    holds.current[why] = false;
    if (!holds.current.hover && !holds.current.focus) setStyle(null);
  };
  const hide = () => setStyle(null);

  // The bubble is pinned to where the trigger was: any scroll (the list, the Wall) hides it.
  useEffect(() => {
    if (!style) return;
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('resize', hide);
    };
  }, [style]);

  return (
    <span
      ref={anchor}
      className="relative inline-flex"
      onPointerEnter={() => show('hover')}
      onPointerLeave={() => release('hover')}
      onFocus={() => show('focus')}
      onBlur={() => release('focus')}
    >
      {children}
      {/* Always mounted so `aria-describedby` resolves; hidden until hover or focus. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <span id={id} role="tooltip" style={style ?? undefined} className={cn('fixed z-50', BUBBLE, !style && 'hidden', className)}>
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}
