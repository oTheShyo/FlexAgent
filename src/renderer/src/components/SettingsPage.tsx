import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ReactNode } from 'react'
import type { SessionSummary } from '../types'
import { SHORTCUTS } from '../lib/shortcuts'
import { readTheme, writeTheme } from '../lib/theme'
import type { ThemePreference } from '../lib/theme'
import { THEMES } from '../lib/themes'
import type { ThemeOption } from '../lib/themes'
import { pathBasename } from '../lib/paths'
import { useCustomModels } from '../hooks/useCustomModels'
import ModelsSettings from './ModelsSettings'
import {
  CloseIcon,
  InfoIcon,
  KeyboardIcon,
  ModelIcon,
  PaletteIcon,
  SettingsIcon
} from './icons'
import type { IconProps } from './icons'
import { IconButton } from './ui'

export type SettingsSectionId = 'general' | 'appearance' | 'shortcuts' | 'models' | 'about'

interface SettingsNavEntry {
  id: SettingsSectionId
  label: string
  Icon: (props: IconProps) => ReactNode
}

/**
 * Two levels, mirroring the shape of the preferences window this app is
 * modelled on: a few ungrouped entries first, then named groups. Only
 * sections that have something real behind them appear — a palette, a live
 * models.json, a keymap the app actually honours.
 */
const NAV_GROUPS: { title?: string; entries: SettingsNavEntry[] }[] = [
  {
    entries: [
      { id: 'general', label: 'General', Icon: SettingsIcon },
      { id: 'appearance', label: 'Appearance', Icon: PaletteIcon },
      { id: 'shortcuts', label: 'Shortcuts', Icon: KeyboardIcon }
    ]
  },
  {
    title: 'Models',
    entries: [{ id: 'models', label: 'Custom models', Icon: ModelIcon }]
  },
  {
    title: 'About',
    entries: [{ id: 'about', label: 'Storage', Icon: InfoIcon }]
  }
]

const SECTION_TITLE: Record<SettingsSectionId, string> = {
  general: 'General',
  appearance: 'Appearance',
  shortcuts: 'Shortcuts',
  models: 'Custom models',
  about: 'Storage'
}

/** Short lead-in per section; omitted where the section explains itself. */
const SECTION_BLURB: Partial<Record<SettingsSectionId, string>> = {
  general: 'How this window is talking to the kernel right now.',
  appearance: 'Pick a palette — everything else in the app follows it.',
  shortcuts: 'What the app listens for, and nothing it does not.',
  about: 'What lives on this device, and what belongs to the kernel.'
}

/** Static, so the keymap is read once instead of on every render. */
const SHORTCUT_ROWS: { keys: string; description: string }[] = Object.values(SHORTCUTS)

function Card({
  title,
  testId,
  children
}: {
  title: string
  testId?: string
  children: ReactNode
}) {
  return (
    <section
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5"
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
    >
      <h3 className="text-xs font-medium text-[var(--text-secondary)]">{title}</h3>
      <div className="mt-1">{children}</div>
    </section>
  )
}

function Row({
  label,
  title,
  children
}: {
  label: string
  title?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] py-2.5 last:border-b-0">
      <span className="shrink-0 text-xs text-[var(--text-secondary)]">{label}</span>
      <span className="min-w-0 truncate text-right text-xs text-[var(--text)]" title={title}>
        {children}
      </span>
    </div>
  )
}

function ThemeCard({
  option,
  selected,
  onSelect
}: {
  option: ThemeOption
  selected: boolean
  onSelect: (id: ThemePreference) => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={`theme-${option.id}`}
      onClick={() => onSelect(option.id)}
      className={`group rounded-lg border p-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
        selected
          ? 'border-[var(--border-strong)] bg-[var(--active)]'
          : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]'
      }`}
    >
      <div className="relative aspect-[16/10] overflow-hidden rounded-md border border-[var(--border)]">
        {option.preview.kind === 'image' ? (
          <img
            src={option.preview.src}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div
            className="h-full w-full"
            style={{ backgroundColor: option.preview.bg }}
            aria-hidden="true"
          >
            <div
              className="flex h-full w-full flex-col gap-1 p-1.5"
              style={{ backgroundColor: option.preview.bg }}
            >
              <div
                className="h-1.5 w-1/3 rounded-sm"
                style={{ backgroundColor: option.preview.accent ?? '#888' }}
              />
              <div className="flex min-h-0 flex-1 gap-1">
                <div
                  className="w-1/4 rounded-sm opacity-80"
                  style={{ backgroundColor: option.preview.panel ?? '#ddd' }}
                />
                <div
                  className="flex-1 rounded-sm opacity-70"
                  style={{ backgroundColor: option.preview.panel ?? '#ddd' }}
                />
              </div>
            </div>
          </div>
        )}
        {selected && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-md ring-2 ring-inset ring-[var(--accent)]"
          />
        )}
      </div>
      <span
        className={`mt-1.5 block truncate text-center text-[11px] leading-4 ${
          selected ? 'font-medium text-[var(--text)]' : 'text-[var(--text-secondary)]'
        }`}
      >
        {option.label}
      </span>
    </button>
  )
}

function NavItem({
  entry,
  active,
  onSelect
}: {
  entry: SettingsNavEntry
  active: boolean
  onSelect: (id: SettingsSectionId) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      aria-current={active ? 'page' : undefined}
      data-testid={`settings-nav-${entry.id}`}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
        active
          ? 'bg-[var(--active)] font-medium text-[var(--text)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
      }`}
    >
      <entry.Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate">{entry.label}</span>
    </button>
  )
}

export interface SettingsPageProps {
  sessions: SessionSummary[]
  /** Workspace of the open session, if any — shown under General. */
  activeCwd: string | null
  onClose: () => void
  /** After a models.json write, so the composer re-reads the model list. */
  onModelsChanged?: () => void
}

function noteClass(): string {
  return 'text-[11px] leading-4 text-[var(--text-muted)]'
}

/**
 * Full-window settings, with its own navigation rail.
 *
 * The model controller is owned here rather than inside the Models section so
 * that switching sections does not re-read models.json; the write still goes
 * through the kernel-supplied path (see hooks/useCustomModels).
 */
function SettingsPage({ sessions, activeCwd, onClose, onModelsChanged }: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSectionId>('general')
  const [themePref, setThemePref] = useState<ThemePreference>(() => readTheme())
  const customModels = useCustomModels(onModelsChanged)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  // Read from the live runtime so the panel never claims a capability that is
  // absent, and so these values match what the app is actually running on.
  const bridgeLabel =
    window.electron?.codex !== undefined ? 'Electron IPC · kernel' : 'In-browser mock'
  const platformLabel = navigator.platform.length > 0 ? navigator.platform : 'unknown'

  const handleThemeSelect = useCallback((pref: ThemePreference): void => {
    setThemePref(pref)
    writeTheme(pref)
  }, [])

  const handlePanelClick = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
  }, [])

  const body = useMemo<ReactNode>(() => {
    switch (section) {
      case 'general':
        return (
          <>
            <Card title="This device" testId="settings-environment">
              <Row label="Bridge">{bridgeLabel}</Row>
              <Row label="Platform">{platformLabel}</Row>
              <Row label="Chats">{sessions.length}</Row>
              <Row label="Project" title={activeCwd ?? undefined}>
                {activeCwd === null ? 'No session open' : pathBasename(activeCwd)}
              </Row>
            </Card>
            <p className={noteClass()}>
              Every value above is read from the running window — none of it is stored in a
              preferences file of its own.
            </p>
          </>
        )

      case 'appearance':
        return (
          <>
            <Card title="Theme">
              <div
                role="radiogroup"
                aria-label="Theme"
                className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3"
              >
                {THEMES.map((option) => (
                  <ThemeCard
                    key={option.id}
                    option={option}
                    selected={themePref === option.id}
                    onSelect={handleThemeSelect}
                  />
                ))}
              </div>
            </Card>
            <p className={noteClass()}>
              Applied immediately and remembered on this device. The two photographic themes also
              restyle the window chrome, not just the content area.
            </p>
          </>
        )

      case 'shortcuts':
        return (
          <>
            <Card title="Keyboard shortcuts">
              <ul className="mt-1.5 space-y-1" data-testid="settings-shortcuts">
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
            </Card>
            <p className={noteClass()}>
              Read-only. Rebinding would need a keymap editor and conflict handling, so nothing here
              pretends to be editable.
            </p>
          </>
        )

      case 'models':
        return (
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
            <ModelsSettings controller={customModels} />
          </section>
        )

      case 'about':
        return (
          <>
            <Card title="Kernel">
              <Row label="Models file" title={customModels.path ?? undefined}>
                <code className="font-mono text-[11px]">{customModels.path ?? 'reading…'}</code>
              </Row>
              <Row label="Sessions & transcripts">Belong to the kernel</Row>
            </Card>
            <Card title="This device">
              <Row label="Theme">Applied locally</Row>
              <Row label="Chat names & archives">Local overlay — not synced</Row>
            </Card>
            <p className={noteClass()}>
              Clearing this device&apos;s local storage drops the theme preference and any renamed
              or archived chats, but leaves sessions, transcripts and custom models untouched —
              those are the kernel&apos;s files, not the window&apos;s.
            </p>
          </>
        )
    }
  }, [
    section,
    activeCwd,
    bridgeLabel,
    customModels,
    handleThemeSelect,
    platformLabel,
    sessions.length,
    themePref
  ])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-6"
      role="presentation"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-[var(--overlay)]" aria-hidden="true" />
      {/* A bounded window, not the whole viewport: settings is something you
          open next to your work and close again. */}
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-panel"
        onClick={handlePanelClick}
        className="relative flex h-[min(660px,86vh)] w-[min(960px,92vw)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-lg)] outline-none"
      >
        <nav
          aria-label="Settings sections"
          data-testid="settings-nav"
          className="flex w-56 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-sidebar)]"
        >
          <div className="flex items-center gap-2.5 px-3.5 py-3.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]">
              <SettingsIcon className="h-3.5 w-3.5" />
            </span>
            <h2 className="text-sm font-semibold text-[var(--text)]">Settings</h2>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {NAV_GROUPS.map((group, groupIndex) => (
              <div
                key={group.title ?? `group-${groupIndex}`}
                className={groupIndex > 0 ? 'mt-4' : undefined}
              >
                {group.title !== undefined && (
                  <p className="px-2.5 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
                    {group.title}
                  </p>
                )}
                <ul className="space-y-0.5">
                  {group.entries.map((entry) => (
                    <li key={entry.id}>
                      <NavItem entry={entry} active={section === entry.id} onSelect={setSection} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <div className="relative min-w-0 flex-1 bg-[var(--content-bg)]" data-testid="settings-content">
          {/* The scroll container is a child so the close button stays put. */}
          <div className="h-full overflow-y-auto">
            <div className="max-w-4xl px-8 pb-12 pt-8">
              <h1 className="text-base font-semibold text-[var(--text)]">{SECTION_TITLE[section]}</h1>
              {SECTION_BLURB[section] !== undefined && (
                <p className="mt-1 text-xs text-[var(--text-muted)]">{SECTION_BLURB[section]}</p>
              )}
              <div className="mt-5 space-y-3">{body}</div>
            </div>
          </div>

          <IconButton
            label="Close settings"
            variant="ghost"
            onClick={onClose}
            data-testid="settings-close"
            className="absolute right-3 top-3 z-10"
          >
            <CloseIcon className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

export default memo(SettingsPage)
