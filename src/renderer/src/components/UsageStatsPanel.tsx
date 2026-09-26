import { useMemo, type ReactNode } from 'react'
import type { GlobalUsageBucket, GlobalUsageStats } from '../types'
import { useUsageStats } from '../hooks/useUsageStats'
import { ChatSkeleton } from './Skeleton'

/**
 * Settings › Usage (issue 09).
 *
 * The point of this panel is attribution, not totals: "the app spent N tokens"
 * is trivia, while "the permission classifier and the memory pass cost 18% of
 * them" is the number that decides whether those features stay on. Hence
 * callSource gets its own table rather than being a footnote under models.
 */

const CALL_SOURCE_LABEL: Record<string, string> = {
  chat: 'Chat turns',
  compaction: 'Compaction',
  permission_classifier: 'Bash classifier',
  memory_dedupe: 'Memory dedupe',
  memory_extract: 'Memory extraction',
  role_task: 'Sub-agents',
  unknown: 'Unattributed'
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function Table({
  title,
  note,
  rows,
  labelOf
}: {
  title: string
  note?: string
  rows: GlobalUsageBucket[]
  labelOf?: (key: string) => string
}): ReactNode {
  if (rows.length === 0) return null
  const max = Math.max(...rows.map((row) => row.total), 1)
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
      <h3 className="text-xs font-medium text-[var(--text-secondary)]">{title}</h3>
      {note !== undefined && (
        <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-muted)]">{note}</p>
      )}
      <div className="mt-2">
        {rows.map((row) => (
          <div key={row.key} className="py-1.5">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-[var(--text)]" title={row.key}>
                {labelOf?.(row.key) ?? row.key}
              </span>
              <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                {formatTokens(row.total)} · {formatNumber(row.calls)} calls
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${Math.round((row.total / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function EmptyState(): ReactNode {
  return (
    <section
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5"
      data-testid="usage-empty"
    >
      <h3 className="text-xs font-medium text-[var(--text-secondary)]">Nothing recorded yet</h3>
      <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
        Usage is aggregated offline from the event log this app already writes — there is no
        separate counter to enable. Send a message and the first rows appear here.
      </p>
    </section>
  )
}

function TotalsCard({ stats }: { stats: GlobalUsageStats }): ReactNode {
  const days = stats.byDay.length
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
      <h3 className="text-xs font-medium text-[var(--text-secondary)]">Totals</h3>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {[
          ['Tokens', formatTokens(stats.totals.total)],
          ['Calls', formatNumber(stats.totals.calls)],
          ['Tool calls', formatNumber(stats.toolCalls)],
          ['Sessions', formatNumber(stats.sessions)]
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-[11px] leading-4 text-[var(--text-muted)]">{label}</div>
            <div className="text-sm tabular-nums text-[var(--text)]">{value}</div>
          </div>
        ))}
      </div>
      {days > 0 && (
        <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]">
          Across {days} day{days === 1 ? '' : 's'} of recorded activity.
          {stats.totals.failed > 0 ? ` ${stats.totals.failed} call(s) failed.` : ''}
        </p>
      )}
    </section>
  )
}

export function UsageStatsPanel(): ReactNode {
  const { stats, loading, error, refresh } = useUsageStats()

  const body = useMemo<ReactNode>(() => {
    if (loading && stats === null) return <ChatSkeleton />
    if (error !== null) {
      return (
        <section className="rounded-xl border border-[var(--danger-border,var(--border))] bg-[var(--surface)] px-4 py-3.5">
          <p className="text-xs text-[var(--text)]">{error}</p>
          <button
            type="button"
            onClick={refresh}
            className="mt-2 text-[11px] text-[var(--accent)] hover:underline"
          >
            Try again
          </button>
        </section>
      )
    }
    if (stats === null || !stats.hasData) return <EmptyState />
    return (
      <>
        <TotalsCard stats={stats} />
        <Table
          title="By call source"
          note="What each feature cost. Auxiliary calls — classifier, memory, sub-agents — are here so switching one on has a visible price."
          rows={stats.byCallSource}
          labelOf={(key) => CALL_SOURCE_LABEL[key] ?? key}
        />
        <Table title="By model" rows={stats.byModel} />
        {stats.toolCallsByTool.length > 0 && (
          <Table
            title="Busiest tools"
            rows={stats.toolCallsByTool.map((row) => ({
              key: row.name,
              calls: row.count,
              total: row.count,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              failed: 0
            }))}
          />
        )}
        <Table title="By day" rows={stats.byDay} />
      </>
    )
  }, [stats, loading, error, refresh])

  return (
    <div className="flex flex-col gap-3" data-testid="usage-stats-panel">
      {body}
      {stats !== null && stats.hasData && (
        <button
          type="button"
          onClick={refresh}
          className="self-start text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
          data-testid="usage-refresh"
        >
          Refresh
        </button>
      )}
    </div>
  )
}

export default UsageStatsPanel
