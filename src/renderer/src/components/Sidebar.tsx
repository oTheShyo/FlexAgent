import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '../types'
import {
  displaySessionTitle,
  setSessionMetaArchived,
  setSessionMetaTitle,
  useSessionMeta
} from '../lib/sessionMeta'
import { formatWhen } from '../lib/formatWhen'
import { SessionListSkeleton } from './Skeleton'
import { IconButton, MenuPanel, MenuItem } from './ui'
import {
  ChatDotIcon,
  MoreIcon,
  NewChatIcon,
  PluginsIcon,
  ScheduledIcon,
  SearchIcon,
  SettingsIcon
} from './icons'

export interface SidebarProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onNewChat: () => void
  onSelect: (sessionId: string) => void
  loading?: boolean
  onOpenPlugins?: () => void
  pluginsActive?: boolean
  onOpenSettings?: () => void
}

function NavRow({
  icon,
  label,
  active = false,
  primary = false,
  disabled = false,
  title,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  primary?: boolean
  disabled?: boolean
  title?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${
        disabled
          ? 'cursor-not-allowed text-[var(--text-subtle)] opacity-60'
          : primary
            ? 'border border-[var(--border-strong)] bg-[var(--surface)] font-medium text-[var(--text)] shadow-[var(--shadow-sm)] hover:bg-[var(--hover)]'
            : active
              ? 'bg-[var(--active)] font-medium text-[var(--text)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

interface SessionRowData {
  session: SessionSummary
  title: string
  archived: boolean
}

function matchesQuery(title: string, query: string): boolean {
  if (query.length === 0) return true
  return title.toLowerCase().includes(query)
}

function Sidebar({
  sessions,
  activeSessionId,
  onNewChat,
  onSelect,
  loading = false,
  onOpenPlugins,
  pluginsActive = false,
  onOpenSettings
}: SidebarProps) {
  const meta = useSessionMeta()
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameCancelledRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const startRename = useCallback((sessionId: string, currentTitle: string): void => {
    setMenuId(null)
    setRenamingId(sessionId)
    setRenameDraft(currentTitle)
    renameCancelledRef.current = false
  }, [])

  const commitRename = useCallback((): void => {
    const target = renamingId
    if (target === null) return
    const trimmed = renameDraft.trim()
    if (trimmed.length > 0) setSessionMetaTitle(target, trimmed)
    setRenamingId(null)
  }, [renamingId, renameDraft])

  const handleRenameKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Enter') {
        event.preventDefault()
        commitRename()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        renameCancelledRef.current = true
        setRenamingId(null)
      }
    },
    [commitRename]
  )

  const handleRenameBlur = useCallback((): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      return
    }
    commitRename()
  }, [commitRename])

  const toggleArchive = useCallback((sessionId: string, archived: boolean): void => {
    setSessionMetaArchived(sessionId, !archived)
    setMenuId(null)
  }, [])

  const openMenu = useCallback((sessionId: string): void => {
    setMenuId((current) => (current === sessionId ? null : sessionId))
  }, [])

  useEffect(() => {
    if (menuId === null) return
    const menuRoot = document.querySelector(
      `[data-session-menu-root="${CSS.escape(menuId)}"]`
    )
    const firstItem = menuRoot?.querySelector<HTMLButtonElement>('[role="menu"] button')
    firstItem?.focus()

    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const root = target.closest('[data-session-menu-root]')
      if (!root || root.getAttribute('data-session-menu-root') !== menuId) {
        setMenuId(null)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.isComposing) return
      event.stopPropagation()
      setMenuId(null)
      const rowRoot = document.querySelector(
        `[data-session-menu-root="${CSS.escape(menuId)}"]`
      )
      rowRoot
        ?.querySelector<HTMLButtonElement>('[data-testid="session-row-menu"]')
        ?.focus()
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuId])

  useEffect(() => {
    if (renamingId === null) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingId])

  const normalizedQuery = query.trim().toLowerCase()

  const visibleSessions = useMemo<SessionRowData[]>(() => {
    const rows: SessionRowData[] = []
    for (const session of sessions) {
      const title = displaySessionTitle(session, meta)
      const archived = meta[session.id]?.archived === true
      // Pin the active row so archiving the open session never hides it (no createSession side effect).
      const inView = showArchived ? archived : !archived || session.id === activeSessionId
      if (!inView) continue
      if (!matchesQuery(title, normalizedQuery)) continue
      rows.push({ session, title, archived })
    }
    return rows
  }, [sessions, meta, normalizedQuery, showArchived, activeSessionId])

  const emptyMessage =
    sessions.length === 0
      ? 'No chats yet'
      : visibleSessions.length > 0
        ? null
        : showArchived
          ? 'No archived chats'
          : 'No matching chats'

  const archiveToggleLabel = showArchived ? 'Show chats' : 'Archived'

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-sidebar)]">
      <div className="flex items-center gap-2 px-4 pb-4 pt-4">
        <img src="/logo.png" alt="" className="h-6 w-6 rounded-md object-cover" />
        <span className="text-sm font-semibold tracking-tight text-[var(--text)]">FlexAgent</span>
      </div>

      <nav className="space-y-1 px-2 pb-4" aria-label="Primary">
        <NavRow icon={<NewChatIcon />} label="New chat" primary onClick={onNewChat} />
        <NavRow
          icon={<PluginsIcon />}
          label="Plugins"
          active={pluginsActive}
          onClick={onOpenPlugins}
        />
        <NavRow icon={<ScheduledIcon />} label="Scheduled" disabled title="Coming soon" />
      </nav>

      <div className="mx-4 border-t border-[var(--border)]" />

      <div className="px-2 pt-3">
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[var(--text-subtle)]">
            <SearchIcon className="h-3.5 w-3.5" />
          </span>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] pl-7 pr-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            data-testid="session-search"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <span className="text-[11px] font-medium text-[var(--text-muted)]">
            {showArchived ? 'Archived' : 'Chats'}
          </span>
          <button
            type="button"
            aria-pressed={showArchived}
            aria-label={archiveToggleLabel}
            onClick={() => setShowArchived((value) => !value)}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
              showArchived
                ? 'border-[var(--border-strong)] bg-[var(--active)] text-[var(--text)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
            }`}
            data-testid="session-archive-toggle"
          >
            Archived
          </button>
        </div>

        {loading ? (
          <SessionListSkeleton />
        ) : emptyMessage !== null ? (
          <p className="px-2 py-1 text-xs text-[var(--text-muted)]">{emptyMessage}</p>
        ) : (
          <ul className="space-y-1">
            {visibleSessions.map(({ session, title, archived }) => {
              const isActive = session.id === activeSessionId
              const running = session.runState === 'running'
              const isRenaming = renamingId === session.id
              const isMenuOpen = menuId === session.id
              return (
                <li key={session.id} className="group relative" data-session-menu-root={session.id}>
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onBlur={handleRenameBlur}
                      aria-label="Rename session"
                      spellCheck={false}
                      className="h-9 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      data-testid="session-rename-input"
                    />
                  ) : (
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => onSelect(session.id)}
                        aria-current={isActive ? 'true' : undefined}
                        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${
                          isActive
                            ? 'bg-[var(--active)] font-medium text-[var(--text)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
                        }`}
                      >
                        <ChatDotIcon />
                        <span className="min-w-0 flex-1 truncate">{title}</span>
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            running ? 'bg-[var(--warning)]' : 'bg-[var(--status-idle)]'
                          }`}
                          title={running ? 'Running' : 'Idle'}
                          aria-label={running ? 'Running' : 'Idle'}
                        />
                        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                          {formatWhen(session.updatedAt)}
                        </span>
                      </button>
                      <IconButton
                        label={`Session actions: ${title}`}
                        variant="ghost"
                        aria-haspopup="menu"
                        aria-expanded={isMenuOpen}
                        onClick={() => openMenu(session.id)}
                        className={
                          isMenuOpen
                            ? 'opacity-100'
                            : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                        }
                        data-testid="session-row-menu"
                      >
                        <MoreIcon />
                      </IconButton>
                    </div>
                  )}

                  {isMenuOpen && (
                    <MenuPanel
                      aria-label={`Actions for ${title}`}
                      className="right-1 top-full mt-0.5 w-36"
                    >
                      <MenuItem onClick={() => startRename(session.id, title)}>
                        Rename
                      </MenuItem>
                      <MenuItem onClick={() => toggleArchive(session.id, archived)}>
                        {archived ? 'Unarchive' : 'Archive'}
                      </MenuItem>
                    </MenuPanel>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-[var(--border)] px-2 py-2">
        <NavRow
          icon={<SettingsIcon />}
          label="Settings"
          onClick={onOpenSettings}
        />
      </div>
    </aside>
  )
}

export default memo(Sidebar)
