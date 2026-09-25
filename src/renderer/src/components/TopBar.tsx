import { memo } from 'react'
import type { ReactNode } from 'react'
import { LoadingIndicator } from './LoadingIndicator'
import { Button } from './ui'
import { ReviewIcon, StopIcon, TerminalIcon } from './icons'

export interface TopBarProps {
  title?: string
  terminalActive?: boolean
  reviewActive?: boolean
  reviewCount?: number
  running?: boolean
  sessionControls?: boolean
  onToggleTerminal: () => void
  onToggleReview: () => void
  onStop?: () => void
}

function ToolbarButton({
  icon,
  label,
  active,
  count,
  onClick
}: {
  icon: ReactNode
  label: string
  active: boolean
  count?: number
  onClick: () => void
}) {
  return (
    <Button
      variant="secondary"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5${
        active
          ? ' !border-[var(--border-strong)] !bg-[var(--surface-raised)] !text-[var(--text)]'
          : ''
      }`}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span className="fx-fade inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold leading-none text-[var(--accent-contrast)]">
          {count}
        </span>
      )}
    </Button>
  )
}

function TopBar({
  title = 'New chat',
  terminalActive = false,
  reviewActive = false,
  reviewCount = 0,
  running = false,
  sessionControls = true,
  onToggleTerminal,
  onToggleReview,
  onStop
}: TopBarProps) {
  const showRunState = sessionControls && running
  const reviewPendingCount = sessionControls && !reviewActive ? reviewCount : 0

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-sm font-semibold tracking-tight text-[var(--text)]">{title}</h1>
        {showRunState && (
          <span className="fx-fade flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning-text)]">
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--warning)]"
              aria-hidden="true"
            />
            Running
          </span>
        )}
        {showRunState && (
          <span className="fx-fade shrink-0">
            <LoadingIndicator size={18} color="var(--text-subtle)" label="Run in progress" />
          </span>
        )}
      </div>
      {sessionControls && (
        <div className="fx-fade flex items-center gap-1.5">
          {running && onStop && (
            <Button
              variant="danger"
              onClick={onStop}
              aria-label="Stop run"
              className="fx-fade flex items-center gap-1.5"
            >
              <StopIcon className="h-3 w-3 shrink-0" />
              <span>Stop</span>
            </Button>
          )}
          <ToolbarButton
            icon={<TerminalIcon className="h-3.5 w-3.5 shrink-0" />}
            label="Terminal"
            active={terminalActive}
            onClick={onToggleTerminal}
          />
          <ToolbarButton
            icon={<ReviewIcon className="h-3.5 w-3.5 shrink-0" />}
            label="Review"
            active={reviewActive}
            count={reviewPendingCount}
            onClick={onToggleReview}
          />
        </div>
      )}
    </header>
  )
}

export default memo(TopBar)
