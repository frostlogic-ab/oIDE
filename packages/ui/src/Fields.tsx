import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn.js';

/**
 * Form fields from the canvas (`.inp`): 34px, radius 8, `line-3` border, card or chrome fill,
 * accent border on focus. Every field has a real <label> (visible, or visually hidden with
 * `hideLabel`).
 */

type FieldSize = 28 | 34 | 36;
type Surface = 'card' | 'chrome';

const SIZE: Record<FieldSize, string> = {
  28: 'h-7 px-2.5 text-[12px] rounded-sm',
  34: 'h-[34px] px-2.5 text-[13px] rounded-md',
  36: 'h-9 px-2.5 text-[13px] rounded-md',
};

export function fieldClass(size: FieldSize = 34, surface: Surface = 'card', invalid = false, className?: string): string {
  return cn(
    'border text-ink placeholder:text-ink-4 outline-none min-w-0 box-border',
    'focus:border-accent focus-visible:outline-none disabled:opacity-50',
    invalid ? 'border-bad-line' : 'border-line-3',
    surface === 'card' ? 'bg-card' : 'bg-chrome',
    SIZE[size],
    className,
  );
}

interface LabelledProps {
  label: ReactNode;
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** Classes for the wrapper. */
  containerClassName?: string;
}

function FieldShell({
  id,
  label,
  hideLabel,
  hint,
  error,
  containerClassName,
  children,
}: LabelledProps & { id: string; children: ReactNode }) {
  return (
    <div className={cn('flex flex-col gap-2', containerClassName)}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-[12px] font-semibold text-ink-2'}>
        {label}
      </label>
      {children}
      {error ? (
        <span id={`${id}-err`} className="text-[12px] text-bad">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className="text-[12px] text-ink-3 leading-[1.45]">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  return error ? `${id}-err` : hint ? `${id}-hint` : undefined;
}

export type TextFieldProps = LabelledProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: FieldSize; surface?: Surface; mono?: boolean };

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hideLabel, hint, error, containerClassName, size = 34, surface = 'card', mono, className, id, type = 'text', ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <FieldShell id={inputId} label={label} hideLabel={hideLabel} hint={hint} error={error} containerClassName={containerClassName}>
      <input
        ref={ref}
        id={inputId}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        className={fieldClass(size, surface, Boolean(error), cn(mono && 'font-mono', className))}
        {...rest}
      />
    </FieldShell>
  );
});

export type TextAreaProps = LabelledProps & TextareaHTMLAttributes<HTMLTextAreaElement> & { surface?: Surface; mono?: boolean };

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hideLabel, hint, error, containerClassName, surface = 'chrome', mono, className, id, rows = 3, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <FieldShell id={inputId} label={label} hideLabel={hideLabel} hint={hint} error={error} containerClassName={containerClassName}>
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        className={cn(
          'resize-none px-3 py-2.5 rounded-lg border text-ink text-[14px] leading-[1.5] outline-none placeholder:text-ink-4',
          'focus:border-accent focus-visible:outline-none',
          error ? 'border-bad-line' : 'border-line-3',
          surface === 'card' ? 'bg-card' : 'bg-chrome',
          mono && 'font-mono text-[12.5px]',
          className,
        )}
        {...rest}
      />
    </FieldShell>
  );
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectProps = LabelledProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
    options: ReadonlyArray<SelectOption>;
    size?: FieldSize;
    surface?: Surface;
  };

/** Native <select> (keyboard and screen-reader behaviour for free). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hideLabel, hint, error, containerClassName, options, size = 34, surface = 'card', className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <FieldShell id={inputId} label={label} hideLabel={hideLabel} hint={hint} error={error} containerClassName={containerClassName}>
      <select
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        className={fieldClass(size, surface, Boolean(error), cn('pr-2', className))}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
});
