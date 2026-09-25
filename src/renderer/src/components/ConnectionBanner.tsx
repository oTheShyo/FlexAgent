import { memo } from 'react'

export interface ConnectionBannerProps {
  message: string
  onRetry: () => void
}

function ConnectionBanner({ message, onRetry }: ConnectionBannerProps) {
  return (
    <div
      role="status"
      data-testid="connection-banner"
      className="fx-fade flex shrink-0 items-center gap-2 border-b border-[var(--warning-border)] bg-[var(--warning-bg)] px-4 py-1.5 text-xs text-[var(--warning-text)]"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--warning)]"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{message}</span>
      <button
        type="button"
        data-testid="connection-retry"
        onClick={onRetry}
        className="ml-auto shrink-0 rounded-md border border-[var(--warning-border)] bg-[var(--surface)] px-2 py-0.5 text-xs font-medium text-[var(--warning)] transition-colors hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1"
      >
        Retry now
      </button>
    </div>
  )
}

export default memo(ConnectionBanner)
