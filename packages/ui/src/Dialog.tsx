import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { cn } from './cn.js';
import { IconButton } from './Button.js';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Heading text; becomes the dialog's accessible name. */
  title: ReactNode;
  /** Optional line under the title. */
  description?: ReactNode;
  children?: ReactNode;
  /** Footer actions (right-aligned). */
  footer?: ReactNode;
  /** 440 (confirm), 560, 720 (Spawn). */
  width?: number;
  /** `center` for confirms, `top` (64px from top) for large forms like Spawn. */
  position?: 'center' | 'top';
  /** Show the close (×) button in the header. Default true for `top`, false for `center`. */
  showClose?: boolean;
  /** Close when the scrim is clicked. Default true. */
  dismissOnScrim?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  /** Leading visual (e.g. the 44px context ring in the compact confirm). */
  icon?: ReactNode;
  className?: string;
  /** Accessible label override (when the title is not plain text). */
  'aria-label'?: string;
}

/**
 * Accessible modal: role="dialog" + aria-modal, labelled by its title, focus moves in on open and
 * is trapped (Tab / Shift+Tab cycle), Esc closes, focus returns to the opener on close.
 * Esc is `preventDefault`ed so the keymap service does not also handle it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 440,
  position = 'center',
  showClose,
  dismissOnScrim = true,
  initialFocus,
  icon,
  className,
  'aria-label': ariaLabel,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const close = showClose ?? position === 'top';

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const target = initialFocus?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current;
      target?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, initialFocus]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex justify-center p-4 box-border bg-scrim',
        position === 'center' ? 'items-center' : 'items-start pt-16',
      )}
      onMouseDown={(e) => {
        if (dismissOnScrim && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'flex flex-col max-w-full max-h-[calc(100vh-32px)] bg-card border border-line-3 shadow-dialog box-border outline-none',
          position === 'center' ? 'gap-3.5 p-5 rounded-2xl' : 'rounded-3xl overflow-hidden',
          className,
        )}
        style={{ width }}
      >
        {position === 'center' ? (
          <>
            <div className="flex items-center gap-3">
              {icon}
              <div className="flex flex-col gap-[3px] flex-1 min-w-0">
                <h2 id={titleId} className="m-0 text-[15px] font-semibold">
                  {title}
                </h2>
                {description && (
                  <span id={descId} className="text-[12.5px] text-ink-3">
                    {description}
                  </span>
                )}
              </div>
              {close && <IconButton icon="close" aria-label="Close" size={32} onClick={onClose} />}
            </div>
            {children}
            {footer && <div className="flex justify-end gap-2">{footer}</div>}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-5 py-4 border-b border-line">
              {icon}
              <h2 id={titleId} className="m-0 text-[16px] font-semibold flex-1">
                {title}
              </h2>
              {close && <IconButton icon="close" aria-label="Close" size={32} onClick={onClose} />}
            </div>
            {description && (
              <p id={descId} className="m-0 px-5 pt-3 text-[12.5px] text-ink-3">
                {description}
              </p>
            )}
            <div className="flex-1 min-h-0 overflow-auto">{children}</div>
            {footer && <div className="flex justify-end gap-2 px-5 py-4 border-t border-line">{footer}</div>}
          </>
        )}
      </div>
    </div>
  );
}
