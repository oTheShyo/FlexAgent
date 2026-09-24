import { memo } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'

export interface MenuPanelProps extends HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode
}

const PANEL_CLASS =
  'absolute z-30 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)]'

function MenuPanel({ className, children, ...rest }: MenuPanelProps) {
  return (
    <div
      role="menu"
      className={`${PANEL_CLASS}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </div>
  )
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  disabled?: boolean
  children?: React.ReactNode
}

const ITEM_CLASS =
  'flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]'

const ITEM_DISABLED_CLASS = 'cursor-not-allowed text-[var(--text-subtle)] opacity-60'

function MenuItem({
  disabled = false,
  type = 'button',
  className,
  children,
  ...rest
}: MenuItemProps) {
  return (
    <button
      type={type}
      role="menuitem"
      disabled={disabled}
      className={`${ITEM_CLASS}${disabled ? ` ${ITEM_DISABLED_CLASS}` : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export const MemoizedMenuPanel = memo(MenuPanel)
export const MemoizedMenuItem = memo(MenuItem)
export { MemoizedMenuPanel as MenuPanel, MemoizedMenuItem as MenuItem }
