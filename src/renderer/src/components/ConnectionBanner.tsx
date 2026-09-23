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
      className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{message}</span>
      <button
        type="button"
        data-testid="connection-retry"
        onClick={onRetry}
        className="ml-auto shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-1"
      >
        Retry now
      </button>
    </div>
  )
}

export default memo(ConnectionBanner)
