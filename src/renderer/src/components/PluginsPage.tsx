import { memo, useEffect, useState } from 'react'
import type { PluginComponentKind, PluginSummary } from '../types'
import { PluginIcon } from './pluginIcons'

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
          <span aria-hidden="true" className="h-3 animate-pulse rounded bg-[var(--active)]" style={{ width }} />
          <span aria-hidden="true" className="ml-auto h-4 w-10 animate-pulse rounded bg-[var(--active)]" />
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
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(plugin.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpenDetail(plugin.id)
      }}
      className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3 transition-colors hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
        <PluginIcon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-[var(--text)]">{plugin.name}</span>
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

  useEffect(() => {
    setDismissedError(false)
  }, [error])

  const showError = error !== null && !dismissedError

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6" data-testid="plugins-page">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">Plugins</h1>
        <button
          type="button"
          onClick={installFromDirectory}
          data-testid="plugins-install"
          className="h-8 shrink-0 rounded bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
        >
          Install from folder
        </button>
      </div>

      {showError && (
        <div
          role="alert"
          data-testid="plugins-error"
          className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500"
          />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button
            type="button"
            onClick={() => setDismissedError(true)}
            aria-label="Dismiss error"
            className="shrink-0 rounded border border-amber-300 bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning)] transition-colors hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1"
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
        ) : (
          <div className="space-y-2">
            {plugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                busy={busyId === plugin.id}
                toggleEnabled={toggleEnabled}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(PluginsPage)
