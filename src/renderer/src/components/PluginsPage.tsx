import { memo, useEffect, useMemo, useState } from 'react'
import type { PluginComponentKind, PluginSummary, PluginSourceKind } from '../types'
import { PluginIcon } from './pluginIcons'
import { Button, Chip } from './ui'
import { useMarketplace } from '../hooks/useMarketplace'
import MarketplacePanel from './MarketplacePanel'

export interface PluginsPageProps {
  plugins: PluginSummary[]
  loading: boolean
  error: string | null
  busyId: string | null
  installFromDirectory: () => void
  toggleEnabled: (id: string, enabled: boolean) => void
  onOpenDetail: (id: string) => void
}

const BADGE_ORDER: PluginComponentKind[] = ['skill', 'extension', 'command', 'hook', 'mcp']

const KIND_LABEL: Record<PluginComponentKind, string> = {
  extension: 'Extensions',
  skill: 'Skills',
  command: 'Commands',
  hook: 'Hooks',
  mcp: 'MCP'
}

const SOURCE_SECTION_ORDER: PluginSourceKind[] = ['bundled', 'local', 'marketplace']

const SOURCE_SECTION_LABEL: Record<PluginSourceKind, string> = {
  bundled: 'Bundled',
  local: 'Local',
  marketplace: 'Marketplace'
}

type StatusFilter = 'all' | 'enabled' | 'disabled'

type PluginsView = 'installed' | 'marketplace'

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'enabled', label: 'Enabled' },
  { key: 'disabled', label: 'Disabled' }
]

export function kindHeading(kind: PluginComponentKind): string {
  return KIND_LABEL[kind]
}

function countLabel(kind: PluginComponentKind, count: number): string {
  if (kind === 'mcp') return 'MCP'
  return count === 1 ? kind : `${kind}s`
}

export function componentCountBadges(counts: PluginSummary['componentCounts']): string[] {
  const badges: string[] = []
  for (const kind of BADGE_ORDER) {
    const count = counts[kind]
    if (count === undefined || count <= 0) continue
    badges.push(`${count} ${countLabel(kind, count)}`)
  }
  return badges
}

function PluginListSkeleton() {
  const widths = ['72%', '55%', '64%'] as const
  return (
    <ul
      role="status"
      aria-busy="true"
      aria-label="Loading plugins"
      data-testid="skeleton-plugin-list"
      className="space-y-2"
    >
      {widths.map((width) => (
        <li
          key={width}
          className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
        >
          <span aria-hidden="true" className="h-8 w-8 animate-pulse rounded-lg bg-[var(--active)]" />
          <span aria-hidden="true" className="h-3 animate-pulse rounded-md bg-[var(--active)]" style={{ width }} />
          <span aria-hidden="true" className="ml-auto h-4 w-10 animate-pulse rounded-md bg-[var(--active)]" />
        </li>
      ))}
    </ul>
  )
}

function ToggleSwitch({
  checked,
  disabled,
  label,
  testId,
  onClick
}: {
  checked: boolean
  disabled?: boolean
  label: string
  testId: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`relative h-4.5 w-8 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 ${
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)]'
          : 'border-[var(--border-strong)] bg-[var(--surface-sunken)]'
      }`}
      style={{ height: 18, width: 32 }}
      data-testid={testId}
    >
      <span
        aria-hidden="true"
        className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-[var(--surface)] shadow-sm transition-all ${
          checked ? 'left-[16px]' : 'left-[2px]'
        }`}
      />
    </button>
  )
}

function PluginRow({
  plugin,
  busy,
  toggleEnabled,
  onOpenDetail
}: {
  plugin: PluginSummary
  busy: boolean
  toggleEnabled: (id: string, enabled: boolean) => void
  onOpenDetail: (id: string) => void
}) {
  const badges = componentCountBadges(plugin.componentCounts)
  return (
    <div
      data-testid={`plugin-row-${plugin.id}`}
      onClick={() => onOpenDetail(plugin.id)}
      className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3 transition-colors hover:bg-[var(--hover)]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
        <PluginIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onOpenDetail(plugin.id)
            }}
            className="truncate rounded-sm text-left text-sm font-medium text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            {plugin.name}
          </button>
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">v{plugin.version}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
            {plugin.source.label}
          </span>
          {badges.length > 0 && (
            <span className="rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
              {badges.join(' · ')}
            </span>
          )}
        </div>
      </div>
      {busy && (
        <span className="shrink-0 text-[11px] text-[var(--text-muted)]" role="status">
          Reloading…
        </span>
      )}
      <ToggleSwitch
        checked={plugin.enabled}
        disabled={busy}
        label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
        testId={`plugin-toggle-${plugin.id}`}
        onClick={() => toggleEnabled(plugin.id, !plugin.enabled)}
      />
    </div>
  )
}

function PluginsPage({
  plugins,
  loading,
  error,
  busyId,
  installFromDirectory,
  toggleEnabled,
  onOpenDetail
}: PluginsPageProps) {
  const [dismissedError, setDismissedError] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [view, setView] = useState<PluginsView>('installed')
  const [showUrlForm, setShowUrlForm] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const marketplace = useMarketplace()

  const submitUrl = async (): Promise<void> => {
    const trimmed = urlInput.trim()
    if (trimmed.length === 0 || marketplace.busy) return
    const installed = await marketplace.install({ kind: 'url', url: trimmed })
    if (installed) setUrlInput('')
  }

  useEffect(() => {
    setDismissedError(false)
  }, [error])

  const showError = error !== null && !dismissedError

  const normalizedQuery = query.trim().toLowerCase()

  const filtered = useMemo(() => {
    return plugins.filter((plugin) => {
      if (statusFilter === 'enabled' && !plugin.enabled) return false
      if (statusFilter === 'disabled' && plugin.enabled) return false
      if (normalizedQuery.length === 0) return true
      const haystack =
        `${plugin.name} ${plugin.description ?? ''} ${plugin.source.label}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [plugins, statusFilter, normalizedQuery])

  const sections = useMemo(() => {
    return SOURCE_SECTION_ORDER.map((kind) => ({
      kind,
      label: SOURCE_SECTION_LABEL[kind],
      items: filtered.filter((plugin) => plugin.source.kind === kind)
    })).filter((section) => section.items.length > 0)
  }, [filtered])

  const searchEmpty = !loading && plugins.length > 0 && filtered.length === 0

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6" data-testid="plugins-page">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">Plugins</h1>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setShowUrlForm((open) => !open)}
            aria-expanded={showUrlForm}
            data-testid="plugins-install-url"
          >
            Install from URL
          </Button>
          <Button
            variant="primary"
            onClick={installFromDirectory}
            data-testid="plugins-install"
          >
            Install from folder
          </Button>
        </div>
      </div>

      {showUrlForm && (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submitUrl()
          }}
        >
          <input
            type="text"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder="https://example.com/plugin.zip"
            aria-label="Plugin URL"
            autoComplete="off"
            spellCheck={false}
            disabled={marketplace.busy}
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60"
            data-testid="plugins-url-input"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={marketplace.busy || urlInput.trim().length === 0}
            data-testid="plugins-url-submit"
            className="shrink-0"
          >
            Install
          </Button>
        </form>
      )}

      <div className="mt-3 flex items-center gap-1.5" role="group" aria-label="Plugins view">
        <Chip
          active={view === 'installed'}
          onClick={() => setView('installed')}
          aria-pressed={view === 'installed'}
          data-testid="marketplace-view-installed"
          className="h-7 px-2.5 text-[11px]"
        >
          Installed
        </Chip>
        <Chip
          active={view === 'marketplace'}
          onClick={() => setView('marketplace')}
          aria-pressed={view === 'marketplace'}
          data-testid="marketplace-view-marketplace"
          className="h-7 px-2.5 text-[11px]"
        >
          Marketplace
        </Chip>
      </div>

      {view === 'marketplace' ? (
        <div className="mt-4">
          <MarketplacePanel marketplace={marketplace} />
        </div>
      ) : (
        <>
      {!loading && plugins.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[var(--text-subtle)]"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search plugins"
              aria-label="Search plugins"
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] pl-8 pr-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              data-testid="plugins-search"
            />
          </div>
          <div className="flex items-center gap-1.5" role="group" aria-label="Filter by state">
            {STATUS_FILTERS.map((filter) => (
              <Chip
                key={filter.key}
                active={statusFilter === filter.key}
                onClick={() => setStatusFilter(filter.key)}
                aria-pressed={statusFilter === filter.key}
                data-testid={`plugins-filter-${filter.key}`}
                className="h-7 px-2.5 text-[11px]"
              >
                {filter.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {showError && (
        <div
          role="alert"
          data-testid="plugins-error"
          className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--warning)]"
          />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button
            type="button"
            onClick={() => setDismissedError(true)}
            aria-label="Dismiss error"
            className="shrink-0 rounded-md border border-[var(--warning-border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning)] transition-colors hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="mt-4">
        {loading ? (
          <PluginListSkeleton />
        ) : plugins.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-6 py-16 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] shadow-[var(--shadow-sm)]">
              <PluginIcon className="h-5 w-5" />
            </div>
            <h2 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">
              No plugins yet
            </h2>
            <p className="mt-1 max-w-xs text-sm leading-5 text-[var(--text-muted)]">
              Install a plugin from a folder to extend FlexAgent.
            </p>
          </div>
        ) : searchEmpty ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-6 py-12 text-center">
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text)]">
              No matching plugins
            </h2>
            <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
              Try a different keyword or state filter.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {sections.map((section) => (
              <section key={section.kind} aria-label={section.label}>
                <h2 className="flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                  {section.label}
                  <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">
                    {section.items.length}
                  </span>
                </h2>
                <div className="mt-2 space-y-2">
                  {section.items.map((plugin) => (
                    <PluginRow
                      key={plugin.id}
                      plugin={plugin}
                      busy={busyId === plugin.id}
                      toggleEnabled={toggleEnabled}
                      onOpenDetail={onOpenDetail}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}

export default memo(PluginsPage)
