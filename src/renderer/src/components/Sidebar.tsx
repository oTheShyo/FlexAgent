import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSearchHit, SessionSummary } from '../types'
import { codexApi } from '../api'
import {
  countArchivedSessions,
  displaySessionTitle,
  setSessionMetaArchived,
  setSessionMetaTitle,
  useSessionMeta
} from '../lib/sessionMeta'
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
  /** Picks a directory and opens a chat in it (Projects "+" affordance). */
  onAddProject?: () => void
  /**
   * Scratch workspace path. Chats sitting there have no project yet, so they
   * are excluded from the Projects grouping.
   */
  scratchCwd?: string | null
  onDelete?: (sessionId: string) => void
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

interface ProjectRowData {
  /** Normalised comparison key; the filter holds this, not the raw path. */
  key: string
  /** Representative absolute path (first spelling seen for this directory). */
  cwd: string
  label: string
  chats: number
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
  onAddProject,
  scratchCwd = null,
  onDelete,
  loading = false,
  onOpenPlugins,
  pluginsActive = false,
  onOpenSkills,
  skillsActive = false,
  onOpenMemory,
  memoryActive = false,
  onOpenSettings
}: SidebarProps) {
  const meta = useSessionMeta()
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [projectsOpen, setProjectsOpen] = useState(true)
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

  const toggleProject = useCallback((key: string): void => {
    setProjectFilter((current) => (current === key ? null : key))
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

  const projects = useMemo<ProjectRowData[]>(() => {
    const scratchKey = scratchCwd === null ? null : pathKey(scratchCwd)
    const byKey = new Map<string, ProjectRowData>()
    for (const session of sessions) {
      if (session.cwd.length === 0) continue
      const key = pathKey(session.cwd)
      // Scratch chats belong to no project, so they are not a project row.
      if (key === scratchKey) continue
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, {
          key,
          cwd: session.cwd,
          label: pathBasename(session.cwd),
          chats: 1
        })
      } else {
        existing.chats += 1
      }
    }
    return [...byKey.values()].sort(
      (a, b) => b.chats - a.chats || a.label.localeCompare(b.label)
    )
  }, [sessions, scratchCwd])

  const archivedCount = useMemo(() => countArchivedSessions(sessions, meta), [sessions, meta])

  const activeProject = useMemo<ProjectRowData | null>(
    () => projects.find((project) => project.key === projectFilter) ?? null,
    [projects, projectFilter]
  )

  // A project can disappear when its last chat is deleted; drop the stale filter.
  useEffect(() => {
    if (projectFilter === null) return
    if (!projects.some((project) => project.key === projectFilter)) setProjectFilter(null)
  }, [projects, projectFilter])

  const visibleSessions = useMemo<SessionRowData[]>(() => {
    const rows: SessionRowData[] = []
    for (const session of sessions) {
      const title = displaySessionTitle(session, meta)
      const archived = meta[session.id]?.archived === true
      // Pin the active row so archiving the open session never hides it (no createSession side effect).
      const inView = showArchived ? archived : !archived || session.id === activeSessionId
      if (!inView) continue
      // The archived bucket is its own place, so a project filter only narrows the chats view.
      if (!showArchived && projectFilter !== null && pathKey(session.cwd) !== projectFilter) continue
      if (!matchesQuery(title, normalizedQuery)) continue
      rows.push({ session, title, archived })
    }
    return rows
  }, [sessions, meta, normalizedQuery, showArchived, projectFilter, activeSessionId])

  const emptyMessage =
    sessions.length === 0
      ? 'No chats yet'
      : visibleSessions.length > 0
        ? null
        : showArchived
          ? 'No archived chats'
          : normalizedQuery.length > 0
            ? 'No matching chats'
            : activeProject !== null
              ? `No chats in ${activeProject.label}`
              : 'No matching chats'

  const archiveToggleLabel = showArchived ? 'Show chats' : 'Archived'

  const listHeading = showArchived ? 'Archived' : (activeProject?.label ?? 'Chats')

  const newChatLabel =
    activeProject === null ? 'New chat' : `New chat in ${activeProject.label}`

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-sidebar)]">
      <div className="flex items-center gap-2 px-4 pb-4 pt-4">
        <img src="/logo.png" alt="" className="h-6 w-6 rounded-md object-cover" />
        <span className="text-sm font-semibold tracking-tight text-[var(--text)]">FlexAgent</span>
      </div>

      <nav className="space-y-1 px-2 pb-4" aria-label="Primary">
        <NavRow
          icon={<NewChatIcon />}
          label={newChatLabel}
          primary
          onClick={() => onNewChat(activeProject?.cwd)}
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

      {projects.length > 0 && (
        <>
          <div className="mx-4 border-t border-[var(--border)]" />
          <div className="px-2 pt-3" data-testid="projects">
            <div className="flex items-center gap-1 px-2 pb-1">
              <button
                type="button"
                onClick={() => setProjectsOpen((value) => !value)}
                aria-expanded={projectsOpen}
                aria-controls="sidebar-projects"
                className="flex min-w-0 flex-1 items-center gap-1 rounded text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                data-testid="projects-toggle"
              >
                <svg
                  className={`h-3 w-3 shrink-0 transition-transform ${projectsOpen ? '' : '-rotate-90'}`}
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
                Projects
                <span className="font-normal">({projects.length})</span>
              </button>
              {onAddProject !== undefined && (
                <IconButton
                  label="Open a folder as a project"
                  variant="ghost"
                  onClick={onAddProject}
                  data-testid="project-add"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </IconButton>
              )}
            </div>

            {projectsOpen && (
              <ul id="sidebar-projects" className="max-h-44 space-y-0.5 overflow-y-auto">
                {projects.map((project) => {
                  const isSelected = project.key === projectFilter
                  return (
                    <li key={project.key}>
                      <button
                        type="button"
                        onClick={() => toggleProject(project.key)}
                        aria-pressed={isSelected}
                        title={project.cwd}
                        data-testid="project-row"
                        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${
                          isSelected
                            ? 'bg-[var(--active)] font-medium text-[var(--text)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
                        }`}
                      >
                        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-subtle)]" />
                        <span className="min-w-0 flex-1 truncate">{project.label}</span>
                        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                          {project.chats}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>
      )}

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
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <span className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]">
            <span className="truncate" data-testid="session-list-heading">
              {listHeading}
            </span>
            {!showArchived && activeProject !== null && (
              <button
                type="button"
                onClick={() => setProjectFilter(null)}
                aria-label="Clear project filter"
                title="Clear project filter"
                data-testid="project-clear"
                className="shrink-0 rounded px-1 text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                ✕
              </button>
            )}
          </span>
          <button
            type="button"
            aria-pressed={showArchived}
            aria-label={archiveToggleLabel}
            onClick={() => setShowArchived((value) => !value)}
            className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
              showArchived
                ? 'border-[var(--border-strong)] bg-[var(--active)] text-[var(--text)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
            }`}
            data-testid="session-archive-toggle"
          >
            Archived
            {archivedCount > 0 && <span className="font-normal">· {archivedCount}</span>}
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
              const isConfirmingDelete = confirmDeleteId === session.id
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
                      className="right-1 top-full mt-0.5 w-44"
                    >
                      {isConfirmingDelete ? (
                        <>
                          <p className="px-2.5 py-1.5 text-[11px] leading-4 text-[var(--text-muted)]">
                            Delete this chat? The transcript is removed for good.
                          </p>
                          <MenuItem onClick={cancelDelete} data-testid="session-delete-cancel">
                            Cancel
                          </MenuItem>
                          <MenuItem
                            onClick={() => confirmDelete(session.id)}
                            className="gap-1.5 !text-[var(--danger-text)] hover:!bg-[var(--danger-bg)]"
                            data-testid="session-delete-confirm"
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                            Delete
                          </MenuItem>
                        </>
                      ) : (
                        <>
                          <MenuItem onClick={() => startRename(session.id, title)}>
                            Rename
                          </MenuItem>
                          <MenuItem onClick={() => toggleArchive(session.id, archived)}>
                            {archived ? 'Unarchive' : 'Archive'}
                          </MenuItem>
                          {onDelete !== undefined && (
                            <MenuItem
                              onClick={() => requestDelete(session.id)}
                              data-testid="session-delete"
                            >
                              Delete…
                            </MenuItem>
                          )}
                        </>
                      )}
                    </MenuPanel>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {historyHits !== null && historyHits.length > 0 && (
          <div className="mt-4 border-t border-[var(--border)] pt-3" data-testid="history-search">
            <div className="px-2 pb-1.5 text-[11px] font-medium text-[var(--text-muted)]">
              History matches
            </div>
            <ul className="space-y-1">
              {historyHits.map((hit) => (
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
