import { memo } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  children: ReactNode
}

const BASE_CLASS =
  'inline-flex h-8 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40'

const IDLE_CLASS =
  'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'

const ACTIVE_CLASS =
  'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]'

function Chip({
  active = false,
  type = 'button',
  className,
  children,
  ...rest
}: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={rest['aria-pressed'] ?? active}
      className={`${BASE_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export default memo(Chip)
