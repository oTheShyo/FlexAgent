import { memo } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type IconButtonVariant = 'secondary' | 'ghost'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  variant?: IconButtonVariant
  active?: boolean
  children: ReactNode
}

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  secondary:
    'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
}

const ACTIVE_CLASS = 'border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text)]'

const SHARED_CLASS =
  'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40'

function IconButton({
  label,
  variant = 'secondary',
  active = false,
  type = 'button',
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`${SHARED_CLASS} ${active ? ACTIVE_CLASS : VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export default memo(IconButton)
