import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.js';
import { Icon, type IconName } from './Icon.js';
import { Kbd } from './Kbd.js';

export type ButtonVariant =
  /** Accent fill, dark text, 600. "Spawn agent", "Compact", Send. Alias: `accent`. */
  | 'primary'
  | 'accent'
  /** Transparent with `line-3` border. "Open", "Cancel", "Raw terminal". Alias: `outline`. */
  | 'secondary'
  | 'outline'
  /** No border; ink-3 text; hover raised. Icon actions, "See all". */
  | 'ghost'
  /** Amber fill (permission "Allow once", reply "Send" on needs-you cards). */
  | 'warn'
  /** Amber-bordered outline ("Always in oide", "Deny" on needs-you cards). */
  | 'warn-outline'
  /** Red outline ("Stop", "Stop subagent"). */
  | 'danger'
  /** Review-blue fill ("Review diff"). */
  | 'review'
  /** Review-blue outline ("Open PR" on review cards). */
  | 'review-outline';

export type ButtonSize = 28 | 32 | 36;

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent font-semibold border border-transparent hover:brightness-110',
  accent: 'bg-accent text-on-accent font-semibold border border-transparent hover:brightness-110',
  secondary: 'bg-transparent text-ink border border-line-3 hover:bg-raised',
  outline: 'bg-transparent text-ink border border-line-3 hover:bg-raised',
  ghost: 'bg-transparent text-ink-3 border border-transparent hover:bg-raised hover:text-ink',
  warn: 'bg-warn text-warn-bg font-semibold border border-transparent hover:brightness-110',
  'warn-outline': 'bg-transparent text-ink border border-warn-line hover:bg-warn-bg-2',
  danger: 'bg-transparent text-bad border border-bad-line hover:bg-bad-bg',
  review: 'bg-review text-on-accent font-semibold border border-transparent hover:brightness-110',
  'review-outline': 'bg-transparent text-ink border border-review-line hover:bg-review-bg',
};

const SIZE: Record<ButtonSize, string> = {
  28: 'h-7 px-2.5 text-[12px] rounded-sm gap-1.5',
  32: 'h-8 px-3 text-[12.5px] rounded-[7px] gap-1.5',
  36: 'h-9 px-3.5 text-[13px] rounded-md gap-2',
};

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconName;
  /** Shortcut hint rendered as a <Kbd> after the label, e.g. "Y". */
  kbd?: string;
  children?: ReactNode;
}

export type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement>;
export type LinkButtonProps = CommonProps & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 28, className?: string): string {
  return cn(
    'inline-flex items-center justify-center whitespace-nowrap no-underline box-border select-none',
    'disabled:opacity-50 disabled:pointer-events-none transition-[background-color,filter,border-color]',
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

function Inner({ icon, kbd, children, variant, size }: CommonProps) {
  const onFill = variant === 'primary' || variant === 'accent' || variant === 'warn' || variant === 'review';
  return (
    <>
      {icon && <Icon name={icon} size={size === 36 ? 18 : size === 32 ? 15 : 14} />}
      {children}
      {kbd && <Kbd tone={onFill ? 'on-fill' : 'default'}>{kbd}</Kbd>}
    </>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 28, icon, kbd, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
      <Inner icon={icon} kbd={kbd} variant={variant} size={size}>
        {children}
      </Inner>
    </button>
  );
});

/** A link styled as a button (the canvas uses <a> for navigation buttons). */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton(
  { variant = 'secondary', size = 28, icon, kbd, className, children, ...rest },
  ref,
) {
  return (
    <a ref={ref} className={buttonClass(variant, size, cn('hover:text-inherit', className))} {...rest}>
      <Inner icon={icon} kbd={kbd} variant={variant} size={size}>
        {children}
      </Inner>
    </a>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: icon-only buttons must be labelled. */
  'aria-label': string;
  size?: 28 | 32 | 40;
  iconSize?: number;
  variant?: 'ghost' | 'outline' | 'accent';
}

const ICON_VARIANT = {
  ghost: 'bg-transparent text-ink-3 hover:bg-raised hover:text-ink border border-transparent',
  outline: 'bg-transparent text-ink-2 border border-line-3 hover:bg-raised',
  accent: 'bg-accent text-on-accent border border-transparent hover:brightness-110',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, size = 28, iconSize, variant = 'ghost', className, type = 'button', ...rest },
  ref,
) {
  const radius = size === 40 ? 'rounded-lg' : size === 32 ? 'rounded-md' : 'rounded-sm';
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center shrink-0 disabled:opacity-50 disabled:pointer-events-none',
        ICON_VARIANT[variant],
        radius,
        className,
      )}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? (size === 40 ? 18 : 16)} />
    </button>
  );
});
