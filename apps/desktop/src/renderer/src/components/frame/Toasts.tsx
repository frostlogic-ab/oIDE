import { cn } from '@oide/ui';
import { useUi } from '../../stores/ui';

/** Bottom-right toasts (canvas: light #E6E8EB pill, dark text). Errors announce assertively. */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="fixed right-5 bottom-10 z-40 flex flex-col items-end gap-2 pointer-events-none" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.level === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex items-center gap-3 py-2.5 pr-3 pl-3.5 max-w-[480px] rounded-lg bg-toast text-on-accent text-[12.5px] shadow-toast',
            t.level === 'error' && 'border-l-4 border-bad',
            t.level === 'warning' && 'border-l-4 border-warn',
            t.level === 'success' && 'border-l-4 border-ok',
          )}
        >
          <span className="flex-1">{t.message}</span>
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
            className="h-[26px] px-2 rounded-sm border border-ink-3 bg-transparent text-on-accent text-[12px]"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
