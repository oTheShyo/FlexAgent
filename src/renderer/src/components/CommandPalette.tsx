import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { SessionSummary } from '../types'
import { displaySessionTitle, useSessionMeta } from '../lib/sessionMeta'
import { formatWhen } from '../lib/formatWhen'
import { pathBasename } from '../lib/paths'
import { SHORTCUTS } from '../lib/shortcuts'
import { readTheme, writeTheme } from '../lib/theme'
import type { ThemePreference } from '../lib/theme'
import { PluginIcon } from './pluginIcons'
import ModelsSettings from './ModelsSettings'
import { useCustomModels } from '../hooks/useCustomModels'
import {
  ChatDotIcon,
  NewChatIcon,
  SearchIcon,
  SettingsIcon,
  TerminalIcon
} from './icons'
import { Button } from './ui'

export interface CommandPaletteProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onNewChat: () => void
  onOpenSession: (sessionId: string) => void
  onToggleTerminal: () => void
  onOpenPlugins: () => void
  onClose: () => void
  openSettings?: boolean
  /** After a models.json write, so the composer re-reads the model list. */
  onModelsChanged?: () => void
}

interface PaletteCommand {
  id: string
  label: string
  hint: string
  shortcut?: string
  run: () => void
}

/** Static, so it is read once instead of on every palette render. */
const SHORTCUT_ROWS: { keys: string; description: string }[] = Object.values(SHORTCUTS)

function SettingRow({
  label,
  title,
  children
}: {
  label: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3 py-1 text-xs">
      <span className="w-20 shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" title={title}>
        {children}
      </span>
    </div>
  )
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

function CommandPalette({
  sessions,
  activeSessionId,
  onNewChat,
  onOpenSession,
  onToggleTerminal,
  onOpenPlugins,
  onClose,
  openSettings = false,
  onModelsChanged
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showSettingsNotice, setShowSettingsNotice] = useState(openSettings)
  const [themePref, setThemePref] = useState<ThemePreference>(() => readTheme())
  const sessionMeta = useSessionMeta()
  const customModels = useCustomModels(onModelsChanged)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  // Unlike the planned-but-unwired preferences, these are read straight from
  // the live runtime so the panel never claims a capability that is absent.
  const bridgeLabel =
    window.electron?.codex !== undefined ? 'Electron IPC · kernel' : 'In-browser mock'
  const platformLabel = navigator.platform.length > 0 ? navigator.platform : 'unknown'
  const activeCwd = sessions.find((session) => session.id === activeSessionId)?.cwd ?? null

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

  const handleThemeSelect = useCallback((pref: ThemePreference): void => {
    setThemePref(pref)
    writeTheme(pref)
  }, [])

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
      <div className="absolute inset-0 bg-[var(--overlay)]" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        onClick={handlePanelClick}
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
      >
        {showSettingsNotice ? (
          <div className="max-h-[70vh] overflow-y-auto p-4" data-testid="settings-panel">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                <SettingsIcon />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text)]">Settings</h2>
                <p className="text-xs text-[var(--text-muted)]">Preferences</p>
              </div>
            </div>
            <div className="mt-4">
              <p className="text-xs font-medium text-[var(--text-secondary)]">Appearance</p>
              <p className="mt-3 text-xs text-[var(--text-muted)]">Theme</p>
              <div
                role="radiogroup"
                aria-label="Theme"
                className="mt-1.5 grid grid-cols-3 gap-1.5"
              >
                {(
                  [
                    { value: 'light', label: 'Light', hint: null },
                    { value: 'dark', label: 'Dark', hint: null },
                    { value: 'system', label: 'System', hint: 'Match OS' }
                  ] as const
                ).map((option) => {
                  const isSelected = themePref === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      data-testid={`theme-${option.value}`}
                      onClick={() => handleThemeSelect(option.value)}
                      className={`rounded-md border px-2 py-2 text-center text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                        isSelected
                          ? 'border-[var(--border-strong)] bg-[var(--active)] font-medium text-[var(--text)]'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
                      }`}
                    >
                      <span className="block">{option.label}</span>
                      {option.hint !== null && (
                        <span className="mt-0.5 block text-[10px] font-normal text-[var(--text-muted)]">
                          {option.hint}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            <ModelsSettings controller={customModels} />
            <div className="mt-5">
              <p className="text-xs font-medium text-[var(--text-secondary)]">Shortcuts</p>
              <ul className="mt-2 space-y-1" data-testid="settings-shortcuts">
                {SHORTCUT_ROWS.map((row) => (
                  <li
                    key={`${row.keys}:${row.description}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1.5"
                  >
                    <span className="min-w-0 truncate text-xs text-[var(--text-secondary)]">
                      {row.description}
                    </span>
                    <kbd className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                      {row.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-5">
              <p className="text-xs font-medium text-[var(--text-secondary)]">Environment</p>
              <div
                className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-1.5"
                data-testid="settings-environment"
              >
                <SettingRow label="Bridge">{bridgeLabel}</SettingRow>
                <SettingRow label="Platform">{platformLabel}</SettingRow>
                <SettingRow label="Chats">{sessions.length}</SettingRow>
                <SettingRow label="Project" title={activeCwd ?? undefined}>
                  {activeCwd === null ? 'No session open' : pathBasename(activeCwd)}
                </SettingRow>
              </div>
              <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]">
                Theme, chat renames and archives are stored on this device only. Transcripts,
                titles and sessions belong to the kernel.
              </p>
            </div>

            <div className="mt-4 flex justify-end">
              <Button type="button" variant="primary" onClick={closeSettingsNotice}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-3">
              <SearchIcon className="h-4 w-4 shrink-0 text-[var(--text-subtle)]" />
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
