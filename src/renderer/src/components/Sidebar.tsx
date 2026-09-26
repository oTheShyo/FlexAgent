import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSearchHit, SessionSummary } from '../types'
import { codexApi } from '../api'
import { formatWhen } from '../lib/formatWhen'
import { pathBasename, pathKey } from '../lib/paths'
import { SessionListSkeleton } from './Skeleton'
import { IconButton, MenuPanel, MenuItem } from './ui'
import {
  ChatDotIcon,
  FolderIcon,
  MemoryIcon,
  MoreIcon,
  NewChatIcon,
  PluginsIcon,
  ScheduledIcon,
  SearchIcon,
  SettingsIcon,
  SkillsIcon,
  TrashIcon
} from './icons'

export interface SidebarProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  /** `cwd` opens a chat in that directory; omitted starts a scratch chat. */
  onNewChat: (cwd?: string) => void
  onSelect: (sessionId: string) => void
  /** Reserved folder-open affordance; no longer rendered in the sidebar. */
  onAddProject?: () => void
  /**
   * Scratch workspace path. Chats sitting there belong to no workspace yet, so
   * they are grouped under the flat "Chats" subgroup instead of a folder.
   */
  scratchCwd?: string | null
  onDelete?: (sessionId: string) => void
  /**
   * Persisted rename. Async on the caller's side (registry write + list
   * refresh), so the row keeps showing the old title until the refresh lands —
   * never an optimistic title that a failed write would leave behind.
   */
  onRenameSession?: (sessionId: string, title: string) => void
  /** Persisted archive toggle (true = archive, false = restore). */
  onSetArchived?: (sessionId: string, archived: boolean) => void
  loading?: boolean
  onOpenPlugins?: () => void
  pluginsActive?: boolean
  onOpenSkills?: () => void
  skillsActive?: boolean
  onOpenMemory?: () => void
  memoryActive?: boolean
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

interface WorkspaceGroupData {
  /** Normalised comparison key; expansion state is keyed on this, not the raw path. */
  key: string
  /** Representative absolute path (first spelling seen for this directory). */
  cwd: string
  label: string
  rows: SessionRowData[]
}

/** `expandedGroups` sentinel key for the workspace-less "Chats" section. */
const CHATS_GROUP_KEY = '__chats__'

function matchesQuery(title: string, query: string): boolean {
  if (query.length === 0) return true
  return title.toLowerCase().includes(query)
}

interface SessionRowProps {
  session: SessionSummary
  title: string
  archived: boolean
  active: boolean
  renaming: boolean
  renameDraft: string
  renameInputRef: React.RefObject<HTMLInputElement | null>
  menuOpen: boolean
  confirmingDelete: boolean
  canDelete: boolean
  onRenameDraftChange: (value: string) => void
  onRenameKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onRenameBlur: () => void
  onSelect: (sessionId: string) => void
  onOpenMenu: (sessionId: string) => void
  onStartRename: (sessionId: string, title: string) => void
  onToggleArchive: (sessionId: string, archived: boolean) => void
  onRequestDelete: (sessionId: string) => void
  onCancelDelete: () => void
  onConfirmDelete: (sessionId: string) => void
}

function SessionRow({
  session,
  title,
  archived,
  active,
  renaming,
  renameDraft,
  renameInputRef,
  menuOpen,
  confirmingDelete,
  canDelete,
  onRenameDraftChange,
  onRenameKeyDown,
  onRenameBlur,
  onSelect,
  onOpenMenu,
  onStartRename,
  onToggleArchive,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete
}: SessionRowProps) {
  const running = session.runState === 'running'
  return (
    <li className="group relative" data-session-menu-root={session.id}>
      {renaming ? (
        <input
          ref={renameInputRef}
          type="text"
          value={renameDraft}
          onChange={(event) => onRenameDraftChange(event.target.value)}
          onKeyDown={onRenameKeyDown}
          onBlur={onRenameBlur}
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
            aria-current={active ? 'true' : undefined}
            className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${
              active
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
            aria-expanded={menuOpen}
            onClick={() => onOpenMenu(session.id)}
            className={
              menuOpen
                ? 'opacity-100'
                : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
            }
            data-testid="session-row-menu"
          >
            <MoreIcon />
          </IconButton>
        </div>
      )}

      {menuOpen && (
        <MenuPanel aria-label={`Actions for ${title}`} className="right-1 top-full mt-0.5 w-44">
          {confirmingDelete ? (
            <>
              <p className="px-2.5 py-1.5 text-[11px] leading-4 text-[var(--text-muted)]">
                Delete this chat? The transcript is removed for good.
              </p>
              <MenuItem onClick={onCancelDelete} data-testid="session-delete-cancel">
                Cancel
              </MenuItem>
              <MenuItem
                onClick={() => onConfirmDelete(session.id)}
                className="gap-1.5 !text-[var(--danger-text)] hover:!bg-[var(--danger-bg)]"
                data-testid="session-delete-confirm"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                Delete
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem onClick={() => onStartRename(session.id, title)}>Rename</MenuItem>
              <MenuItem onClick={() => onToggleArchive(session.id, archived)}>
                {archived ? 'Unarchive' : 'Archive'}
              </MenuItem>
              {canDelete && (
                <MenuItem onClick={() => onRequestDelete(session.id)} data-testid="session-delete">
                  Delete…
                </MenuItem>
              )}
            </>
          )}
        </MenuPanel>
      )}
    </li>
  )
}

function Sidebar({
  sessions,
  activeSessionId,
  onNewChat,
  onSelect,
  scratchCwd = null,
  onDelete,
  onRenameSession,
  onSetArchived,
  loading = false,
  onOpenPlugins,
  pluginsActive = false,
  onOpenSkills,
  skillsActive = false,
  onOpenMemory,
  memoryActive = false,
  onOpenSettings
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
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
    if (trimmed.length > 0) onRenameSession?.(target, trimmed)
    setRenamingId(null)
  }, [renamingId, renameDraft, onRenameSession])

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

  const toggleArchive = useCallback(
    (sessionId: string, archived: boolean): void => {
      onSetArchived?.(sessionId, !archived)
      setMenuId(null)
    },
    [onSetArchived]
  )

  const requestDelete = useCallback((sessionId: string): void => {
    setConfirmDeleteId(sessionId)
  }, [])

  const cancelDelete = useCallback((): void => {
    setConfirmDeleteId(null)
  }, [])

  const confirmDelete = useCallback(
    (sessionId: string): void => {
      setConfirmDeleteId(null)
      setMenuId(null)
      onDelete?.(sessionId)
    },
    [onDelete]
  )

  const openMenu = useCallback((sessionId: string): void => {
    setMenuId((current) => (current === sessionId ? null : sessionId))
  }, [])

  const toggleGroup = useCallback((key: string): void => {
    setExpandedGroups((current) => ({ ...current, [key]: !(current[key] ?? true) }))
  }, [])

  useEffect(() => {
    if (menuId === null) setConfirmDeleteId(null)
  }, [menuId])

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
  }, [menuId, confirmDeleteId])

  useEffect(() => {
    if (renamingId === null) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingId])

  const normalizedQuery = query.trim().toLowerCase()

  // Cross-session history search (contract v1.7): the title filter above only
  // narrows chat rows; this also greps stored transcripts. Debounced so every
  // keystroke does not hit the main-process scan.
  const [historyHits, setHistoryHits] = useState<SessionSearchHit[] | null>(null)
  useEffect(() => {
    if (normalizedQuery.length === 0) {
      setHistoryHits(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void codexApi
        .searchSessions(query.trim())
        .then((hits) => {
          if (!cancelled) setHistoryHits(hits)
        })
        .catch(() => {
          if (!cancelled) setHistoryHits([])
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [normalizedQuery, query])

  const archivedCount = useMemo(
    () => sessions.filter((session) => session.archived === true).length,
    [sessions]
  )

  const visibleSessions = useMemo<SessionRowData[]>(() => {
    const rows: SessionRowData[] = []
    for (const session of sessions) {
      const title = session.title
      const archived = session.archived === true
      // Pin the active row so archiving the open session never hides it (no createSession side effect).
      const inView = showArchived ? archived : !archived || session.id === activeSessionId
      if (!inView) continue
      if (!matchesQuery(title, normalizedQuery)) continue
      rows.push({ session, title, archived })
    }
    return rows
  }, [sessions, normalizedQuery, showArchived, activeSessionId])

  // sessionSearch.ts also matches titles, so a title-matched chat would render
  // twice (row above + History match) without this filter; hidden rows such as
  // archived ones are kept so search can still reach them.
  const historyOnlyHits = useMemo<SessionSearchHit[] | null>(() => {
    if (historyHits === null) return null
    const shownIds = new Set(visibleSessions.map((row) => row.session.id))
    return historyHits.filter((hit) => !shownIds.has(hit.sessionId))
  }, [historyHits, visibleSessions])

  const chatsRows = useMemo<SessionRowData[]>(
    () =>
      visibleSessions.filter(({ session }) => {
        if (session.cwd.length === 0) return true
        return scratchCwd !== null && pathKey(session.cwd) === pathKey(scratchCwd)
      }),
    [visibleSessions, scratchCwd]
  )

  const workspaceGroups = useMemo<WorkspaceGroupData[]>(() => {
    const byKey = new Map<string, WorkspaceGroupData>()
    for (const row of visibleSessions) {
      if (row.session.cwd.length === 0) continue
      const key = pathKey(row.session.cwd)
      if (scratchCwd !== null && key === pathKey(scratchCwd)) continue
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, {
          key,
          cwd: row.session.cwd,
          label: pathBasename(row.session.cwd),
          rows: [row]
        })
      } else {
        existing.rows.push(row)
      }
    }
    return [...byKey.values()].sort(
      (a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label)
    )
  }, [visibleSessions, scratchCwd])

  // The open chat must never sit behind a collapsed folder.
  useEffect(() => {
    if (activeSessionId === null) return
    const key = chatsRows.some((row) => row.session.id === activeSessionId)
      ? CHATS_GROUP_KEY
      : workspaceGroups.find((entry) =>
          entry.rows.some((row) => row.session.id === activeSessionId)
        )?.key
    if (key === undefined) return
    setExpandedGroups((current) =>
      current[key] === false ? { ...current, [key]: true } : current
    )
  }, [workspaceGroups, chatsRows, activeSessionId])

  const emptyMessage =
    sessions.length === 0
      ? 'No chats yet'
      : visibleSessions.length > 0
        ? null
        : showArchived
          ? 'No archived chats'
          : normalizedQuery.length > 0
            ? 'No matching chats'
            : 'No chats yet'

  const archiveToggleLabel = showArchived ? 'Show chats' : 'Archived'

  const chatsExpanded = expandedGroups[CHATS_GROUP_KEY] ?? true

  const renderSessionRow = ({ session, title, archived }: SessionRowData): React.ReactNode => (
    <SessionRow
      key={session.id}
      session={session}
      title={title}
      archived={archived}
      active={session.id === activeSessionId}
      renaming={renamingId === session.id}
      renameDraft={renameDraft}
      renameInputRef={renameInputRef}
      menuOpen={menuId === session.id}
      confirmingDelete={confirmDeleteId === session.id}
      canDelete={onDelete !== undefined}
      onRenameDraftChange={setRenameDraft}
      onRenameKeyDown={handleRenameKeyDown}
      onRenameBlur={handleRenameBlur}
      onSelect={onSelect}
      onOpenMenu={openMenu}
      onStartRename={startRename}
      onToggleArchive={toggleArchive}
      onRequestDelete={requestDelete}
      onCancelDelete={cancelDelete}
      onConfirmDelete={confirmDelete}
    />
  )

  return (
      <aside className="fx-fade flex h-full w-64 shrink-0 flex-col bg-[var(--surface-sidebar)]">
      <div className="flex items-center px-4 pb-4 pt-4">
        <span className="text-sm font-semibold tracking-tight text-[var(--text)]">FlexAgent</span>
      </div>

      <nav className="space-y-1 px-2 pb-4" aria-label="Primary">
        <NavRow
          icon={<NewChatIcon />}
          label="New chat"
          primary
          onClick={() => onNewChat()}
        />
        <NavRow
          icon={<PluginsIcon />}
          label="Plugins"
          active={pluginsActive}
          onClick={onOpenPlugins}
        />
        <NavRow
          icon={<SkillsIcon />}
          label="Skills"
          active={skillsActive}
          onClick={onOpenSkills}
        />
        <NavRow
          icon={<MemoryIcon />}
          label="Memory"
          active={memoryActive}
          onClick={onOpenMemory}
        />
        <NavRow icon={<ScheduledIcon />} label="Scheduled" disabled title="Coming soon" />
      </nav>

      <div className="mx-4 mt-3 border-t border-[var(--border)]" />

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
        <div className="flex items-center justify-start gap-2 px-2 pb-2">
          <button
            type="button"
            aria-pressed={showArchived}
            aria-label={archiveToggleLabel}
            onClick={() => setShowArchived((value) => !value)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-[var(--shadow-sm)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
              showArchived
                ? 'border-transparent bg-[var(--accent)] text-[var(--accent-contrast)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
            }`}
            data-testid="session-archive-toggle"
          >
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
              <rect width="20" height="5" x="2" y="3" rx="1" />
              <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
              <path d="M10 12h4" />
            </svg>
            Archived
            {archivedCount > 0 && (
              <span
                className={`rounded-full px-1.5 text-[10px] leading-4 ${
                  showArchived
                    ? 'bg-[color-mix(in_srgb,var(--accent-contrast)_25%,transparent)] text-[var(--accent-contrast)]'
                    : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'
                }`}
              >
                {archivedCount}
              </span>
            )}
          </button>
        </div>

        {loading ? (
          <SessionListSkeleton />
        ) : emptyMessage !== null ? (
          <p className="px-2 py-1 text-xs text-[var(--text-muted)]">{emptyMessage}</p>
        ) : (
          <>
            <ul className="space-y-1">
              {chatsRows.length > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => toggleGroup(CHATS_GROUP_KEY)}
                    aria-expanded={chatsExpanded}
                    data-testid="session-list-heading"
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
                  >
                    <svg
                      className={`h-3 w-3 shrink-0 transition-transform ${chatsExpanded ? '' : '-rotate-90'}`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                    <ChatDotIcon />
                    <span className="min-w-0 flex-1 truncate font-medium">Chats</span>
                    <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                      {chatsRows.length}
                    </span>
                  </button>
                  {chatsExpanded && (
                    <ul className="fx-fade mt-0.5 space-y-1 border-l border-[var(--border)] pl-5">
                      {chatsRows.map((row) => renderSessionRow(row))}
                    </ul>
                  )}
                </li>
              )}
              {workspaceGroups.map((group) => {
                const expanded = expandedGroups[group.key] ?? true
                return (
                  <li key={group.key}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={expanded}
                      title={group.cwd}
                      data-testid="project-row"
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
                    >
                      <svg
                        className={`h-3 w-3 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                      <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-subtle)]" />
                      <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                      <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                        {group.rows.length}
                      </span>
                    </button>
                    {expanded && (
                      <ul className="fx-fade mt-0.5 space-y-1 border-l border-[var(--border)] pl-5">
                        {group.rows.map((row) => renderSessionRow(row))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {historyOnlyHits !== null && historyOnlyHits.length > 0 && (
          <div className="mt-4 border-t border-[var(--border)] pt-3" data-testid="history-search">
            <div className="px-2 pb-1.5 text-[11px] font-medium text-[var(--text-muted)]">
              History matches
            </div>
            <ul className="space-y-1">
              {historyOnlyHits.map((hit) => (
                <li key={hit.sessionId}>
                  <button
                    type="button"
                    onClick={() => onSelect(hit.sessionId)}
                    title={hit.snippet}
                    className="w-full rounded-md px-2 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] hover:bg-[var(--hover)]"
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
                      <ChatDotIcon className="h-3 w-3" />
                      <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                      <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                        {formatWhen(hit.updatedAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] leading-4 text-[var(--text-muted)]">
                      {hit.snippet}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
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
