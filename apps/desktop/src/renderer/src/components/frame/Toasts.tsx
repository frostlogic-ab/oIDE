import { cn } from '@oide/ui';
import { useUi } from '../../stores/ui';

/**
 * Toasts (canvas: light #E6E8EB pill, dark text). Bottom-left, just right of the rail and above the
 * status bar, so they never sit over a screen's action column (Review's Merge / Open pull request,
 * tile buttons, the Focus composer). At most 3 (stores/ui.ts `MAX_TOASTS`); info and success leave
 * after 5 s, warnings after 10 s, errors stay until dismissed. Hover or focus holds a toast.
 * The region is polite; errors announce assertively (`role="alert"`).
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
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.level === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => hold(t.id)}
          onMouseLeave={() => release(t.id)}
          onFocus={() => hold(t.id)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release(t.id);
          }}
          className={cn(
            'pointer-events-auto flex items-center gap-3 py-2.5 pr-3 pl-3.5 max-w-[480px] rounded-lg bg-toast text-on-accent text-[12.5px] shadow-toast',
            t.level === 'error' && 'border-l-4 border-bad',
            t.level === 'warning' && 'border-l-4 border-warn',
            t.level === 'success' && 'border-l-4 border-ok',
          )}
        >
          <span className="flex-1">
            {t.message}
            {(t.count ?? 1) > 1 && <span className="ml-1.5 font-mono text-[11px] opacity-70">×{t.count}</span>}
          </span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.run();
                dismiss(t.id);
              }}
              className="h-[26px] px-2 rounded-sm border border-on-accent bg-transparent text-on-accent text-[12px] font-semibold"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label={`Dismiss: ${t.message}`}
            className="h-[26px] px-2 rounded-sm border border-ink-3 bg-transparent text-on-accent text-[12px]"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
