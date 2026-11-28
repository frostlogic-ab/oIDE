import { buttonClass, cn, Icon, IconButton, type ButtonVariant, type IconName } from '@oide/ui';
import { useUi, type ToastLevel } from '../../stores/ui';

/**
 * How each level looks: a status icon in the level's colour and a border tinted to match, the same
 * pairs the status cards use (ok / warn / bad lines). Errors and warnings name their level for
 * screen readers, so the level is never told by colour alone.
 */
const LEVEL: Readonly<
  Record<ToastLevel, { icon: IconName; tone: string; border: string; label?: string; action: ButtonVariant }>
> = {
  info: { icon: 'info', tone: 'text-accent', border: 'border-line-3', action: 'primary' },
  success: { icon: 'check', tone: 'text-ok', border: 'border-ok-line', action: 'primary' },
  warning: { icon: 'warning', tone: 'text-warn', border: 'border-warn-line', label: 'Warning', action: 'warn' },
  error: { icon: 'alert-circle', tone: 'text-bad', border: 'border-bad-line', label: 'Error', action: 'secondary' },
};

/**
 * Toasts: dark raised cards in the app's own palette (ADR 0022; the canvas drew a light pill).
 * Bottom-left, just right of the rail and above the status bar, so they never sit over a screen's
 * action column (Review's Merge / Open pull request, tile buttons, the Focus composer). At most 3
 * (stores/ui.ts `MAX_TOASTS`); info and success leave after 5 s, warnings after 10 s, errors stay
 * until dismissed. Hover or focus holds a toast. The region is polite; errors announce assertively
 * (`role="alert"`).
 */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  const hold = useUi((s) => s.holdToast);
  const release = useUi((s) => s.releaseToast);
  return (
    <div
      className="fixed left-[calc(var(--spacing-rail)+16px)] bottom-[calc(var(--spacing-status)+12px)] z-40 flex flex-col items-start gap-2 pointer-events-none"
      aria-live="polite"
      aria-label="Notifications"
      role="region"
      data-testid="toasts"
    >
      {toasts.map((t) => {
        const look = LEVEL[t.level];
        return (
          <div
            key={t.id}
            role={t.level === 'error' ? 'alert' : 'status'}
            data-level={t.level}
            onMouseEnter={() => hold(t.id)}
            onMouseLeave={() => release(t.id)}
            onFocus={() => hold(t.id)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release(t.id);
            }}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 min-w-[280px] max-w-[480px] py-2 pr-2 pl-3',
              'rounded-lg border bg-raised text-ink text-[12.5px] shadow-toast motion-safe:animate-toast-in',
              look.border,
            )}
          >
            <span className={cn('h-7 flex items-center shrink-0', look.tone)}>
              <Icon name={look.icon} size={16} title={look.label} />
            </span>
            <span className="flex-1 min-w-0 py-[5.5px] leading-[17px] break-words">
              {t.message}
              {(t.count ?? 1) > 1 && (
                <span className="ml-1.5 px-1 rounded-xs bg-line-2 font-mono text-[11px] text-ink-3 align-[1px]">×{t.count}</span>
              )}
            </span>
            {(t.action || t.secondary) && (
              <span className="flex items-center gap-1.5 shrink-0">
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      t.action?.run();
                      dismiss(t.id);
                    }}
                    className={buttonClass(look.action)}
                  >
                    {t.action.label}
                  </button>
                )}
                {t.secondary && (
                  <button
                    type="button"
                    onClick={() => {
                      t.secondary?.run();
                      dismiss(t.id);
                    }}
                    className={buttonClass('secondary')}
                  >
                    {t.secondary.label}
                  </button>
                )}
              </span>
            )}
            {!t.secondary && (
              <IconButton icon="close" iconSize={14} aria-label={`Dismiss: ${t.message}`} title="Dismiss" onClick={() => dismiss(t.id)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
