import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { SessionSummary } from '../types'
import { displaySessionTitle, useSessionMeta } from '../lib/sessionMeta'
import { SHORTCUTS } from '../lib/shortcuts'
import { PluginIcon } from './pluginIcons'

export interface CommandPaletteProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onNewChat: () => void
  onOpenSession: (sessionId: string) => void
  onToggleTerminal: () => void
  onOpenPlugins: () => void
  onClose: () => void
}

interface PaletteCommand {
  id: string
  label: string
  hint: string
  shortcut?: string
  run: () => void
}

function formatWhen(ts: number): string {
  const diff = Date.now() - ts
  const hourMs = 3_600_000
  const dayMs = 24 * hourMs
  if (diff < hourMs) return `${Math.max(1, Math.floor(diff / 60_000))}m`
  if (diff < dayMs) return `${Math.floor(diff / hourMs)}h`
  if (diff < 2 * dayMs) return 'Yesterday'
  if (diff < 7 * dayMs) return `${Math.floor(diff / dayMs)}d`
  return new Date(ts).toLocaleDateString()
}

function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return 0
  const t = text.toLowerCase()
  const exact = t.indexOf(q)
  if (exact >= 0) return exact
  let ti = 0
  let gaps = 0
  let lastHit = -1
  for (const ch of q) {
    const hit = t.indexOf(ch, ti)
    if (hit === -1) return null
    if (lastHit >= 0) gaps += hit - lastHit - 1
    lastHit = hit
    ti = hit + 1
  }
  return 1000 + gaps
}

function SearchIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-[var(--text-subtle)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function NewChatIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </svg>
  )
}

function ChatDotIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.6a8.4 8.4 0 0 1-8.5 8.4 8.7 8.7 0 0 1-3.8-.9L3 20.5l1.4-4.6A8.4 8.4 0 1 1 21 11.6z" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
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

function SettingsIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.29 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.27.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </svg>
  )
}

function CommandPalette({
  sessions,
  activeSessionId,
  onNewChat,
  onOpenSession,
  onToggleTerminal,
  onOpenPlugins,
  onClose
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showSettingsNotice, setShowSettingsNotice] = useState(false)
  const sessionMeta = useSessionMeta()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const runNewChat = useCallback((): void => {
    onNewChat()
    onClose()
  }, [onNewChat, onClose])

  const runToggleTerminal = useCallback((): void => {
    onToggleTerminal()
    onClose()
  }, [onToggleTerminal, onClose])

  const runPlugins = useCallback((): void => {
    onOpenPlugins()
    onClose()
  }, [onOpenPlugins, onClose])

  const runSettings = useCallback((): void => {
    setShowSettingsNotice(true)
  }, [])

  const commands = useMemo<PaletteCommand[]>(() => {
    const base: PaletteCommand[] = [
      {
        id: 'new-chat',
        label: 'New chat',
        hint: 'Action',
        shortcut: SHORTCUTS.newChat.keys,
        run: runNewChat
      },
      {
        id: 'toggle-terminal',
        label: 'Toggle terminal',
        hint: 'Action',
        shortcut: SHORTCUTS.toggleTerminal.keys,
        run: runToggleTerminal
      },
      { id: 'plugins', label: 'Manage plugins', hint: 'Action', run: runPlugins },
      { id: 'settings', label: 'Settings', hint: 'Action', run: runSettings }
    ]
    const sessionCommands: PaletteCommand[] = sessions.map((session) => ({
      id: `session-${session.id}`,
      label: displaySessionTitle(session, sessionMeta),
      hint:
        session.id === activeSessionId
          ? `Current · ${formatWhen(session.updatedAt)}`
          : session.runState === 'running'
            ? `Running · ${formatWhen(session.updatedAt)}`
            : formatWhen(session.updatedAt),
      run: () => {
        onOpenSession(session.id)
        onClose()
      }
    }))
    return [...base, ...sessionCommands]
  }, [sessions, sessionMeta, activeSessionId, runNewChat, runToggleTerminal, runPlugins, runSettings, onOpenSession, onClose])

  const filtered = useMemo(() => {
    const scored: { command: PaletteCommand; score: number }[] = []
    for (const command of commands) {
      const score = fuzzyScore(query, command.label)
      if (score !== null) scored.push({ command, score })
    }
    scored.sort((a, b) => a.score - b.score)
    return scored.map((entry) => entry.command)
  }, [commands, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(filtered.length > 0 ? filtered.length - 1 : 0)
    }
  }, [filtered.length, selectedIndex])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (filtered.length === 0) return
    const list = listRef.current
    const option = list?.children[selectedIndex]
    if (option instanceof HTMLElement) {
      option.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex, filtered.length])

  const runCommand = useCallback(
    (command: PaletteCommand): void => {
      command.run()
    },
    []
  )

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((index) =>
          filtered.length === 0 ? 0 : (index + 1) % filtered.length
        )
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((index) =>
          filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length
        )
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const command = filtered[selectedIndex]
        if (command) runCommand(command)
      }
    },
    [filtered, selectedIndex, runCommand]
  )

  const handleBackdropClick = useCallback((): void => {
    onClose()
  }, [onClose])

  const handlePanelClick = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
  }, [])

  const closeSettingsNotice = useCallback((): void => {
    setShowSettingsNotice(false)
    onClose()
  }, [onClose])

  const activeDescendantId =
    filtered.length > 0 && selectedIndex < filtered.length
      ? `command-palette-option-${filtered[selectedIndex].id}`
      : undefined

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div className="absolute inset-0 bg-zinc-950/30" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        onClick={handlePanelClick}
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
      >
        {showSettingsNotice ? (
          <div className="p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                <SettingsIcon />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text)]">Settings</h2>
                <p className="text-xs text-[var(--text-muted)]">Settings coming soon.</p>
              </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">
              The settings panel is not available in this build yet. No preferences are
              stored at this time.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={closeSettingsNotice}
                className="h-8 rounded bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-3">
              <SearchIcon />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Type a command or search chats…"
                aria-label="Type a command or search chats"
                aria-controls="command-palette-list"
                aria-activedescendant={activeDescendantId}
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                autoComplete="off"
                spellCheck={false}
                className="h-11 w-full bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none"
                data-testid="command-palette-input"
              />
              <kbd className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                Esc
              </kbd>
            </div>

            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[var(--text-muted)]" role="status">
                No matching commands
              </p>
            ) : (
              <ul
                id="command-palette-list"
                ref={listRef}
                role="listbox"
                aria-label="Commands"
                className="max-h-72 overflow-y-auto p-1.5"
              >
                {filtered.map((command, index) => {
                  const isSelected = index === selectedIndex
                  const isActiveSession =
                    command.id.startsWith('session-') &&
                    command.id === `session-${activeSessionId}`
                  return (
                    <li key={command.id} role="presentation">
                      <div
                        id={`command-palette-option-${command.id}`}
                        role="option"
                        aria-selected={isSelected}
                        onMouseMove={() => setSelectedIndex(index)}
                        onClick={() => runCommand(command)}
                        className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm ${
                          isSelected
                            ? 'bg-[var(--active)] font-medium text-[var(--text)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--hover)]'
                        }`}
                      >
                        {command.id === 'new-chat' ? (
                          <NewChatIcon />
                        ) : command.id === 'toggle-terminal' ? (
                          <TerminalIcon />
                        ) : command.id === 'plugins' ? (
                          <PluginIcon />
                        ) : command.id === 'settings' ? (
                          <SettingsIcon />
                        ) : (
                          <ChatDotIcon />
                        )}
                        <span
                          className={`min-w-0 flex-1 truncate ${
                            isActiveSession ? 'text-[var(--text)]' : ''
                          }`}
                        >
                          {command.label}
                          {isActiveSession && (
                            <span className="ml-1.5 text-[11px] font-normal text-[var(--text-muted)]">
                              (current)
                            </span>
                          )}
                        </span>
                        {command.shortcut !== undefined && (
                          <kbd className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                            {command.shortcut}
                          </kbd>
                        )}
                        <span className="shrink-0 text-[11px] font-normal text-[var(--text-muted)]">
                          {command.hint}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
              <span>
                <kbd className="font-mono">↑↓</kbd> to navigate · <kbd className="font-mono">↵</kbd>{' '}
                to run
              </span>
              <span>{SHORTCUTS.togglePalette.keys}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default memo(CommandPalette)
