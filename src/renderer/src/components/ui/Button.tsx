import { memo } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]',
  secondary:
    'border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]',
  danger:
    'border border-[var(--border)] text-[var(--danger-text)] hover:bg-[var(--danger-bg)]'
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-8',
  md: 'h-9'
}

const SHARED_CLASS =
  'rounded-md px-3 text-xs font-medium transition-colors active:translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40'

function Button({
  variant = 'secondary',
  size = 'sm',
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${SHARED_CLASS} ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export default memo(Button)
