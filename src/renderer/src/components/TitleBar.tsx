import { memo, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { IconButton } from './ui'
import { MenuItem, MenuPanel } from './ui/Menu'
import { CloseIcon } from './icons'
import type { WebEditKind, WindowControlsApi } from '../types'

// Injected at build time by electron.vite.config.ts from package.json.
declare const __APP_VERSION__: string

export interface TitleBarProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  onNewChat: () => void
  onOpenSettings: () => void
  onToggleTerminal: () => void
}

const NO_DRAG = '[-webkit-app-region:no-drag]'

const WIN_BUTTON_BASE =
  'flex h-9 w-[46px] items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]'

const WIN_BUTTON_HOVER = 'text-[var(--text-secondary)] hover:bg-[var(--hover)]'

const NAV_BUTTON_CLASS = 'disabled:opacity-40 disabled:cursor-not-allowed'

const MENU_TRIGGER_CLASS =
  'h-full px-3 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]'

interface TitleMenuProps {
  label: string
  testId: string
  children: ReactNode
}

function TitleMenu({ label, testId, children }: TitleMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const handlePanelClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('button') !== null) setOpen(false)
  }

  return (
    <div className="relative h-full" ref={wrapRef}>
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`${MENU_TRIGGER_CLASS} ${
          open
            ? 'bg-[var(--hover)] text-[var(--text)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
        }`}
      >
        {label}
      </button>
      {open && (
        <MenuPanel className="right-0 top-full mt-1 w-56" aria-label={label} onClick={handlePanelClick}>
          {children}
        </MenuPanel>
      )}
    </div>
  )
}

function MenuSeparator() {
  return <div className="my-1 border-t border-[var(--border)]" role="separator" />
}

interface MenuRowProps {
  label: string
  shortcut?: string
  onSelect: () => void
}

function MenuRow({ label, shortcut, onSelect }: MenuRowProps) {
  return (
    <MenuItem onClick={onSelect} className="justify-between gap-6">
      <span>{label}</span>
      {shortcut !== undefined && (
        <span className="font-mono text-[10px] font-normal text-[var(--text-muted)]">{shortcut}</span>
      )}
    </MenuItem>
  )
}

function TitleBar({
  sidebarOpen,
  onToggleSidebar,
  canBack,
  canForward,
  onBack,
  onForward,
  onNewChat,
  onOpenSettings,
  onToggleTerminal
}: TitleBarProps) {
  const controls: WindowControlsApi | null = window.electron?.windowControls ?? null
  const [maximized, setMaximized] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  useEffect(() => controls?.onMaximizedChange(setMaximized), [controls])

  useEffect(() => {
    if (!aboutOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAboutOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [aboutOpen])

  const edit = (kind: WebEditKind): void => {
    void controls?.edit(kind)
  }

  const handleMaximizeToggle = (): void => {
    void controls?.maximizeToggle().then(setMaximized)
  }

  const handleAboutBackdropClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('[role="dialog"]') === null) setAboutOpen(false)
  }

  return (
    <div
      data-testid="titlebar"
      className="flex h-9 w-full shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface-sunken)] [-webkit-app-region:drag]"
    >
      <div className={`flex h-full items-center gap-1 px-2 ${NO_DRAG}`}>
        <IconButton
          label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          variant="ghost"
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
          data-testid="sidebar-toggle"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </IconButton>

        <IconButton
          label="Back"
          variant="ghost"
          disabled={!canBack}
          onClick={onBack}
          data-testid="titlebar-back"
          className={NAV_BUTTON_CLASS}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m12 19-7-7 7-7" />
            <path d="M19 12H5" />
          </svg>
        </IconButton>
        <IconButton
          label="Forward"
          variant="ghost"
          disabled={!canForward}
          onClick={onForward}
          data-testid="titlebar-forward"
          className={NAV_BUTTON_CLASS}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 5 7 7-7 7" />
            <path d="M5 12h14" />
          </svg>
        </IconButton>

        <div className="flex h-full items-center">
          <TitleMenu label="File" testId="menu-file">
            <MenuRow label="New chat" onSelect={onNewChat} />
            <MenuRow label="Settings" onSelect={onOpenSettings} />
            <MenuSeparator />
            <MenuRow label="Quit" onSelect={() => void controls?.quit()} />
          </TitleMenu>

          <TitleMenu label="Edit" testId="menu-edit">
            <MenuRow label="Undo" onSelect={() => edit('undo')} />
            <MenuRow label="Cut" onSelect={() => edit('cut')} />
            <MenuRow label="Copy" onSelect={() => edit('copy')} />
            <MenuRow label="Paste" onSelect={() => edit('paste')} />
            <MenuRow label="Select All" onSelect={() => edit('selectAll')} />
          </TitleMenu>

          <TitleMenu label="View" testId="menu-view">
            <MenuRow
              label="Reload"
              shortcut="Ctrl+R"
              onSelect={() => void controls?.reload()}
            />
            <MenuRow label="Toggle Sidebar" onSelect={onToggleSidebar} />
            <MenuRow label="Toggle Terminal" onSelect={onToggleTerminal} />
            <MenuSeparator />
            <MenuRow label="Zoom In" shortcut="Ctrl+=" onSelect={() => void controls?.zoomIn()} />
            <MenuRow label="Zoom Out" shortcut="Ctrl+-" onSelect={() => void controls?.zoomOut()} />
            <MenuRow label="Reset Zoom" onSelect={() => void controls?.zoomReset()} />
          </TitleMenu>

          <TitleMenu label="Help" testId="menu-help">
            <MenuRow label="About FlexAgent" onSelect={() => setAboutOpen(true)} />
          </TitleMenu>
        </div>
      </div>

      <div className={`flex h-full items-stretch ${NO_DRAG}`}>
        <button
          type="button"
          data-testid="win-min"
          title="Minimize"
          aria-label="Minimize"
          onClick={() => void controls?.minimize()}
          className={`${WIN_BUTTON_BASE} ${WIN_BUTTON_HOVER}`}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4.5 12h15" />
          </svg>
        </button>
        <button
          type="button"
          data-testid="win-max"
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={handleMaximizeToggle}
          className={`${WIN_BUTTON_BASE} ${WIN_BUTTON_HOVER}`}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {maximized ? (
              <>
                <path d="M15 15h5V4H9v5" />
                <path d="M4 9h11v11H4z" />
              </>
            ) : (
              <rect x="4.5" y="4.5" width="15" height="15" />
            )}
          </svg>
        </button>
        <button
          type="button"
          data-testid="win-close"
          title="Close"
          aria-label="Close"
          onClick={() => void controls?.close()}
          className={`${WIN_BUTTON_BASE} text-[var(--text-secondary)] hover:bg-[var(--danger)] hover:text-[var(--accent-contrast)]`}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {aboutOpen && (
        <div
          className={`fixed inset-0 z-[80] flex items-center justify-center p-4 ${NO_DRAG}`}
          role="presentation"
          onClick={handleAboutBackdropClick}
        >
          <div className="fx-overlay absolute inset-0 bg-[var(--overlay)]" aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="About FlexAgent"
            data-testid="about-dialog"
            className="fx-rise relative w-full max-w-xs rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-overlay)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text)]">FlexAgent</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                  Your flexible desktop agent.
                </p>
                <p className="mt-1 font-mono text-[11px] text-[var(--text-muted)]" data-testid="about-version">
                  Version {__APP_VERSION__}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                autoFocus
                onClick={() => setAboutOpen(false)}
                className="shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(TitleBar)
