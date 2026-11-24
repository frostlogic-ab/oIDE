import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.js';

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label next to the switch. If omitted, pass `aria-label`. */
  label?: ReactNode;
}

/** Switch (role="switch"): 34×20 track, 14px knob; accent when on (Settings techniques). */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, onChange, label, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('inline-flex items-center gap-2.5 border-0 bg-transparent p-0 text-[13px] text-ink disabled:opacity-50', className)}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          'w-[34px] h-5 rounded-[10px] flex items-center px-[3px] box-border transition-colors shrink-0',
          checked ? 'bg-accent justify-end' : 'bg-line-3 justify-start',
        )}
      >
        <span className="w-3.5 h-3.5 rounded-full bg-ink" />
      </span>
      {label}
    </button>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Secondary text under the label. */
  description?: ReactNode;
  /** `pill`: 30px chip on `selected` (Spawn extension tools). */
  variant?: 'plain' | 'pill';
}

/** Native checkbox with `accent-color` and a real <label>. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onChange, label, description, variant = 'plain', className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex gap-2 text-ink cursor-pointer',
        description ? 'items-start' : 'items-center',
        variant === 'pill' && 'h-[30px] px-2.5 rounded-md bg-selected text-[12.5px] gap-1.5',
        className,
      )}
    >
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={cn('accent-accent', description && 'mt-0.5 w-4 h-4')}
        {...rest}
      />
      {description ? (
        <span className="flex flex-col gap-0.5">
          <span>{label}</span>
          <span className="text-[12px] text-ink-3 leading-[1.45]">{description}</span>
        </span>
      ) : (
        label
      )}
    </label>
  );
});
