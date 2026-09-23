import { memo } from 'react'
import type { ReactNode } from 'react'
import { WavyProgress } from './WavyProgress'

export interface TopBarProps {
  title?: string
  terminalActive?: boolean
  reviewActive?: boolean
  running?: boolean
  onToggleTerminal: () => void
  onToggleReview: () => void
  onStop?: () => void
}

function TerminalIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 17 6-5-6-5" />
      <path d="M12 19h8" />
    </svg>
  )
}

function ReviewIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M10 13h4" />
      <path d="M10 17h4" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />
    </svg>
  )
}

function ToolbarButton({
  icon,
  label,
  active,
  onClick
}: {
  icon: ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 ${
        active
          ? 'border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text)]'
          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function TopBar({
  title = 'New chat',
  terminalActive = false,
  reviewActive = false,
  running = false,
  onToggleTerminal,
  onToggleReview,
  onStop
}: TopBarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-sm font-semibold tracking-tight text-[var(--text)]">{title}</h1>
        {running && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
            Running
          </span>
        )}
        {running && (
          <span className="shrink-0">
            <WavyProgress width={72} height={10} label="Run in progress" />
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {running && onStop && (
          <button
            type="button"
            onClick={onStop}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
            aria-label="Stop run"
          >
            <StopIcon />
            <span>Stop</span>
          </button>
        )}
        <ToolbarButton
          icon={<TerminalIcon />}
          label="Terminal"
          active={terminalActive}
          onClick={onToggleTerminal}
        />
        <ToolbarButton
          icon={<ReviewIcon />}
          label="Review"
          active={reviewActive}
          onClick={onToggleReview}
        />
      </div>
    </header>
  )
}

export default memo(TopBar)
