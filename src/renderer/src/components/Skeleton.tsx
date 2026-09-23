const SESSION_ROW_WIDTHS = ['72%', '55%', '64%', '48%', '60%', '52%'] as const

const CHAT_GROUPS = [
  { labelWidth: '18%', lines: ['62%', '84%', '46%'], tool: true },
  { labelWidth: '22%', lines: ['54%', '76%'], tool: false },
  { labelWidth: '16%', lines: ['68%', '40%'], tool: true }
] as const

function pulse(className: string, style?: React.CSSProperties): React.ReactNode {
  return (
    <span
      aria-hidden="true"
      className={`animate-pulse rounded bg-[var(--active)] ${className}`}
      style={style}
    />
  )
}

export function SessionListSkeleton() {
  return (
    <ul
      role="status"
      aria-busy="true"
      aria-label="Loading chats"
      data-testid="skeleton-session-list"
      className="space-y-1"
    >
      {SESSION_ROW_WIDTHS.map((width) => (
        <li key={width} className="flex items-center gap-1.5 rounded-md px-2 py-2">
          {pulse('h-3.5 w-3.5 shrink-0')}
          {pulse('h-3 flex-1', { maxWidth: width })}
          {pulse('ml-auto h-3 w-7 shrink-0')}
        </li>
      ))}
    </ul>
  )
}

export function ChatSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading conversation"
      data-testid="skeleton-chat"
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6"
    >
      {CHAT_GROUPS.map((group, index) => (
        <div key={index} className="space-y-2">
          {pulse('block h-3', { width: group.labelWidth })}
          {group.lines.map((width) => (
            <div key={width} className="space-y-1.5">
              {pulse('block h-3', { width })}
              {pulse('block h-3', { width: `calc(${width} * 0.7)` })}
            </div>
          ))}
          {group.tool && (
            <div
              aria-hidden="true"
              className="h-12 w-2/3 animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface-raised)]"
            />
          )}
        </div>
      ))}
    </div>
  )
}
