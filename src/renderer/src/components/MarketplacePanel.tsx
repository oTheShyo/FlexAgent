import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import type { MarketplaceProgressEvent, MarketplaceProgressPhase, MarketplaceSearchResult } from '../types'
import type { UseMarketplaceResult } from '../hooks/useMarketplace'
import { installKeyOf } from '../hooks/useMarketplace'
import { Button } from './ui'

export interface MarketplacePanelProps {
  marketplace: UseMarketplaceResult
}

const PROGRESS_PHASES: MarketplaceProgressPhase[] = ['resolve', 'download', 'extract', 'install', 'done']

function SpinnerIcon() {
  return (
    <svg
      className="h-3 w-3 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
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

function ProgressSteps({ progress }: { progress: MarketplaceProgressEvent }) {
  const failed = progress.phase === 'error'
  const currentIndex = PROGRESS_PHASES.indexOf(progress.phase)
  return (
    <div
      data-testid="marketplace-progress"
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2.5 rounded-lg border px-3 py-1.5 ${
        failed
          ? 'border-[var(--danger-border)] bg-[var(--danger-bg)]'
          : 'border-[var(--border)] bg-[var(--surface-sunken)]'
      }`}
    >
      <span
        data-testid="marketplace-phase"
        className={`shrink-0 font-mono text-[11px] font-medium ${
          failed ? 'text-[var(--danger-text)]' : 'text-[var(--text-secondary)]'
        }`}
      >
        {progress.phase}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1" aria-hidden="true">
        {PROGRESS_PHASES.map((phase, index) => {
          const completed = !failed && currentIndex > index
          const current = !failed && currentIndex === index
          return (
            <span key={phase} className="flex min-w-0 flex-1 items-center gap-1">
              {index > 0 && (
                <span
                  className={`h-px min-w-1 flex-1 ${
                    completed || current ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                  }`}
                />
              )}
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  failed
                    ? 'bg-[var(--border-strong)]'
                    : completed
                      ? 'bg-[var(--accent)]'
                      : current
                        ? 'animate-pulse bg-[var(--accent)]'
                        : 'bg-[var(--border)]'
                }`}
              />
            </span>
          )
        })}
      </div>
      {progress.source !== undefined && (
        <span className="max-w-40 shrink-0 truncate text-[10px] text-[var(--text-muted)]">
          {progress.source}
        </span>
      )}
    </div>
  )
}

function MarketplaceRow({
  result,
  busy,
  activeKey,
  onInstall
}: {
  result: MarketplaceSearchResult
  busy: boolean
  activeKey: string | null
  onInstall: (source: { kind: 'entry'; marketplace: string; name: string }, overwrite?: boolean) => void
}) {
  const entrySource = { kind: 'entry' as const, marketplace: result.marketplace, name: result.name }
  const installing = busy && activeKey === installKeyOf(entrySource)
  const tags = result.tags ?? []

  let action: ReactNode
  if (result.updateAvailable === true) {
    action = (
      <Button
        variant="primary"
        size="sm"
        disabled={busy}
        aria-busy={installing}
        onClick={() => onInstall(entrySource, true)}
        data-testid={`marketplace-update-${result.name}`}
        className="shrink-0"
      >
        {installing && <SpinnerIcon />}
        {installing ? 'Updating…' : 'Update'}
      </Button>
    )
  } else if (result.installed) {
    action = (
      <span
        data-testid={`marketplace-installed-${result.name}`}
        className="inline-flex h-7 shrink-0 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 text-[11px] font-medium text-[var(--text-muted)]"
      >
        Installed
      </span>
    )
  } else {
    action = (
      <Button
        variant="primary"
        size="sm"
        disabled={busy}
        aria-busy={installing}
        onClick={() => onInstall(entrySource)}
        data-testid={`marketplace-install-${result.name}`}
        className="shrink-0"
      >
        {installing && <SpinnerIcon />}
        {installing ? 'Installing…' : 'Install'}
      </Button>
    )
  }

  return (
    <div
      data-testid={`marketplace-row-${result.name}`}
      className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-[var(--text)]">{result.name}</span>
          {result.version !== undefined && (
            <span className="shrink-0 text-[11px] text-[var(--text-muted)]">v{result.version}</span>
          )}
          <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
            {result.marketplace}
          </span>
        </div>
        {result.description !== undefined && (
          <p className="mt-0.5 text-xs leading-4 text-[var(--text-muted)]">{result.description}</p>
        )}
        {tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      {action}
    </div>
  )
}

function MarketplacePanel({ marketplace }: MarketplacePanelProps) {
  const {
    marketplaces,
    results,
    query,
    setQuery,
    busy,
    error,
    progress,
    activeKey,
    addSource,
    install
  } = marketplace
  const [source, setSource] = useState('')
  const trimmedSource = source.trim()

  const handleAdd = async (): Promise<void> => {
    if (trimmedSource.length === 0 || busy) return
    const added = await addSource(trimmedSource)
    if (added) setSource('')
  }

  const handleInstall = (
    source_: { kind: 'entry'; marketplace: string; name: string },
    overwrite?: boolean
  ): void => {
    void install(source_, overwrite)
  }

  return (
    <div data-testid="marketplace-panel">
      {error !== null && (
        <div
          role="alert"
          data-testid="marketplace-error"
          className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger-text)]"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--danger)]"
          />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      <section aria-label="Add marketplace">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void handleAdd()
            }}
            placeholder="Marketplace source URL or path"
            aria-label="Marketplace source"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60"
            data-testid="marketplace-add-input"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || trimmedSource.length === 0}
            onClick={() => void handleAdd()}
            data-testid="marketplace-add"
            className="shrink-0"
          >
            Add
          </Button>
        </div>
        {marketplaces.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {marketplaces.map((marketplaceInfo) => (
              <span
                key={marketplaceInfo.id}
                data-testid="marketplace-source-chip"
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]"
              >
                <span className="text-[var(--text-secondary)]">{marketplaceInfo.id}</span>
                <span className="text-[var(--text-subtle)]">{marketplaceInfo.pluginCount}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <div className="mt-3">
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[var(--text-subtle)]"
          >
            <SearchIcon />
          </span>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search marketplace plugins"
            aria-label="Search marketplace plugins"
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] pl-8 pr-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            data-testid="marketplace-search"
          />
        </div>
      </div>

      {progress !== null && (
        <div className="mt-3">
          <ProgressSteps progress={progress} />
        </div>
      )}

      <div className="mt-3">
        {marketplaces.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-6 py-10 text-center">
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text)]">
              No marketplaces yet
            </h2>
            <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
              Add a marketplace source above to browse and install plugins.
            </p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-6 py-10 text-center">
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text)]">
              No matching plugins
            </h2>
            <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
              Try a different search keyword.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {results.map((result) => (
              <MarketplaceRow
                key={`${result.marketplace}/${result.name}`}
                result={result}
                busy={busy}
                activeKey={activeKey}
                onInstall={handleInstall}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(MarketplacePanel)
