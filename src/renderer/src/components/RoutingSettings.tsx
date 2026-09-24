import { memo, useCallback, useMemo } from 'react'
import type { ReactElement } from 'react'
import type { ModelFacts, ModelOption, ModelRole, UsageBucket } from '../types'
import { MODEL_ROLE_HINTS, MODEL_ROLE_LABELS, MODEL_ROLES } from '../types'
import type { UseModelRoutingResult } from '../hooks/useModelRouting'
import type { UseSessionUsageResult } from '../hooks/useSessionUsage'
import { Button } from './ui'

/** No width class here: `w-full` would win over a per-field width and silently
 * squash whatever sits beside the control. */
const controlClass =
  'h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60'

const KERNEL_DEFAULT = ''

function modelKey(model: ModelOption): string {
  return `${model.provider}\u0000${model.id}`
}

function modelLabel(model: ModelOption): string {
  return model.label ?? model.id
}

/** Compact token counts — a context window is read, not summed. */
function formatTokens(value: number | undefined): string {
  if (value === undefined || value === 0) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`
  return String(value)
}

/**
 * Catalogue prices are USD per million tokens. Rendered as the catalogue states
 * them, including `$0.00` — calling that "free" would be asserting a fact about
 * the provider rather than reporting what the kernel knows.
 */
function formatRate(value: number | undefined): string {
  if (value === undefined) return '—'
  return `$${value.toFixed(2)}`
}

/** Session totals can be fractions of a cent; do not render those as $0.00. */
function formatUsd(value: number): string {
  if (value <= 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

/** Article §7's purposes, said in words rather than in code. */
const PURPOSE_LABEL: Record<string, string> = {
  chat: 'Main conversation',
  compaction: 'Context compaction',
  'tool-results': 'Tool results',
  summarize: 'Summarising'
}

function purposeLabel(key: string): string {
  return PURPOSE_LABEL[key] ?? key
}

/**
 * One row per purpose: pick the model, or leave it to the kernel.
 *
 * The select shows only what the kernel can actually resolve right now — a
 * dropdown listing models with no credentials would be a control that fails on
 * use.
 */
function RoleControl({
  role,
  state,
  facts,
  busy,
  onBind
}: {
  role: ModelRole
  state: { source: 'binding' | 'kernel'; model: ModelOption | null; error?: string }
  facts: ModelFacts[]
  busy: boolean
  onBind: (role: ModelRole, model: ModelOption | null) => void
}): ReactElement {
  const grouped = useMemo(() => {
    const byProvider = new Map<string, ModelFacts[]>()
    for (const fact of facts) {
      const bucket = byProvider.get(fact.provider)
      if (bucket === undefined) byProvider.set(fact.provider, [fact])
      else bucket.push(fact)
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [facts])

  const selected =
    state.source === 'binding' && state.model !== null ? modelKey(state.model) : KERNEL_DEFAULT

  const handleChange = useCallback(
    (value: string) => {
      if (value === KERNEL_DEFAULT) {
        onBind(role, null)
        return
      }
      const fact = facts.find((candidate) => modelKey(candidate) === value)
      if (fact === undefined) return
      onBind(role, {
        provider: fact.provider,
        id: fact.id,
        ...(fact.label !== undefined ? { label: fact.label } : {})
      })
    },
    [facts, onBind, role]
  )

  return (
    <div className="border-b border-[var(--border)] py-2.5 last:border-b-0" data-testid={`routing-role-${role}`}>
      <div className="flex items-center justify-between gap-4">
        <p className="min-w-0 truncate text-xs text-[var(--text)]">{MODEL_ROLE_LABELS[role]}</p>
        <select
          value={selected}
          disabled={busy || facts.length === 0}
          onChange={(event) => handleChange(event.target.value)}
          aria-label={`${MODEL_ROLE_LABELS[role]} model`}
          aria-describedby={`routing-hint-${role}`}
          data-testid={`routing-select-${role}`}
          className={`${controlClass} w-52 shrink-0 xl:w-60`}
        >
          <option value={KERNEL_DEFAULT}>Kernel default</option>
          {grouped.map(([provider, entries]) => (
            <optgroup key={provider} label={provider}>
              {entries.map((fact) => (
                <option key={`${provider}\u0000${fact.id}`} value={modelKey(fact)}>
                  {fact.label ?? fact.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <p id={`routing-hint-${role}`} className="mt-1 text-[10px] leading-3.5 text-[var(--text-muted)]">
        {MODEL_ROLE_HINTS[role]}
      </p>

      <p className="mt-0.5 text-[10px] leading-3.5 text-[var(--text-muted)]">
        {state.error !== undefined ? (
          <span className="text-[var(--danger-text)]" data-testid={`routing-error-${role}`}>
            {state.error}
          </span>
        ) : state.source === 'kernel' ? (
          <>
            Kernel default
            {state.model !== null ? (
              <>
                {' → '}
                <span className="text-[var(--text-secondary)]">{modelLabel(state.model)}</span>
              </>
            ) : (
              ' — unset or unresolvable'
            )}
          </>
        ) : state.model !== null ? (
          <>
            {'Bound to '}
            <span className="text-[var(--text-secondary)]">{modelLabel(state.model)}</span>
          </>
        ) : (
          'Bound, but the model no longer resolves'
        )}
      </p>
    </div>
  )
}

function UsageTable({
  title,
  buckets,
  testId,
  labelOf
}: {
  title: string
  buckets: UsageBucket[]
  testId: string
  labelOf: (key: string) => string
}) {
  return (
    <div data-testid={testId}>
      <p className="text-[11px] font-medium text-[var(--text-secondary)]">{title}</p>
      {buckets.length === 0 ? (
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">No calls recorded yet.</p>
      ) : (
        <table className="mt-1.5 w-full table-fixed border-collapse text-[11px]">
          <thead>
            <tr className="text-[var(--text-muted)]">
              <th className="w-2/5 border-b border-[var(--border)] pb-1 text-left font-normal">
                {title.includes('model') ? 'Model' : 'Purpose'}
              </th>
              <th className="border-b border-[var(--border)] pb-1 text-right font-normal">Calls</th>
              <th className="border-b border-[var(--border)] pb-1 text-right font-normal">In</th>
              <th className="border-b border-[var(--border)] pb-1 text-right font-normal">Out</th>
              <th className="border-b border-[var(--border)] pb-1 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.key} className="text-[var(--text-secondary)]">
                <td className="truncate border-b border-[var(--border)] py-1 pr-2 text-[var(--text)]" title={bucket.key}>
                  {labelOf(bucket.key)}
                </td>
                <td className="border-b border-[var(--border)] py-1 text-right tabular-nums">
                  {bucket.calls}
                </td>
                <td className="border-b border-[var(--border)] py-1 text-right tabular-nums">
                  {formatTokens(bucket.input)}
                </td>
                <td className="border-b border-[var(--border)] py-1 text-right tabular-nums">
                  {formatTokens(bucket.output)}
                </td>
                <td className="border-b border-[var(--border)] py-1 text-right tabular-nums">
                  {formatUsd(bucket.cost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export interface RoutingSettingsProps {
  controller: UseModelRoutingResult
  usage: UseSessionUsageResult
  /** The open chat's ledger is per-session; nothing is open when null. */
  hasSession: boolean
}

function RoutingSettings({ controller, usage, hasSession }: RoutingSettingsProps) {
  const { roles, facts, path, loading, saving, error, bind } = controller

  const stateOf = useCallback(
    (role: ModelRole) =>
      roles.find((candidate) => candidate.role === role) ?? {
        role,
        source: 'kernel' as const,
        model: null
      },
    [roles]
  )

  const report = usage.report

  return (
    <div data-testid="settings-routing" className="space-y-3">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
        <h3 className="text-xs font-medium text-[var(--text-secondary)]">Purposes</h3>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
          Bindings live in{' '}
          <code className="break-all font-mono text-[10px] text-[var(--text-secondary)]">
            {path ?? '…/routing.json'}
          </code>
          . Roles the app never spends a call on are not listed — a control with nothing behind it
          would just be decoration.
        </p>

        {loading ? (
          <p className="mt-3 text-[11px] text-[var(--text-muted)]">Reading routing.json…</p>
        ) : (
          <div className="mt-2">
            {MODEL_ROLES.map((role) => (
              <RoleControl
                key={role}
                role={role}
                state={stateOf(role)}
                facts={facts}
                busy={saving}
                onBind={(target, model) => void bind(target, model)}
              />
            ))}
          </div>
        )}

        {error !== null && (
          <p role="alert" className="mt-2 text-[11px] leading-4 text-[var(--danger-text)]" data-testid="routing-error">
            {error}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
        <h3 className="text-xs font-medium text-[var(--text-secondary)]">Available models</h3>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
          Read from the kernel&apos;s catalogue. The context window decides how soon a conversation
          starts compacting; a long one costs less per turn in summaries.
        </p>
        {facts.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[11px] leading-4 text-[var(--text-muted)]">
            {loading
              ? 'Reading the model catalogue…'
              : 'The kernel has no usable models. Add one under Custom models, or check its credentials.'}
          </p>
        ) : (
          <table className="mt-2 w-full table-fixed border-collapse text-[11px]" data-testid="routing-facts">
            <thead>
              <tr className="text-[var(--text-muted)]">
                <th className="w-2/5 border-b border-[var(--border)] pb-1 text-left font-normal">Model</th>
                <th className="border-b border-[var(--border)] pb-1 text-right font-normal">Context</th>
                <th className="border-b border-[var(--border)] pb-1 text-right font-normal">Max out</th>
                <th className="border-b border-[var(--border)] pb-1 text-right font-normal">$/M in</th>
                <th className="border-b border-[var(--border)] pb-1 text-right font-normal">$/M out</th>
                <th className="border-b border-[var(--border)] pb-1 text-right font-normal">Flags</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((fact) => (
                <tr key={modelKey(fact)} className="text-[var(--text-secondary)]">
                  <td
                    className="truncate border-b border-[var(--border)] py-1 pr-2 text-[var(--text)]"
                    title={`${fact.provider}/${fact.id}`}
                  >
                    {fact.label ?? fact.id}
                    <span className="ml-1 text-[10px] text-[var(--text-muted)]">{fact.provider}</span>
                  </td>
                  <td className="border-b border-[var(--border)] py-1 text-right tabular-nums">
                    {formatTokens(fact.contextWindow)}
                  </td>
                  <td className="border-b border-[var(--border)] py-1 text-right tabular-nums">
                    {formatTokens(fact.maxTokens)}
                  </td>
                  <td className="border-b border-[var(--border)] py-1 text-right tabular-nums">
                    {formatRate(fact.costIn)}
                  </td>
                  <td className="border-b border-[var(--border)] py-1 text-right tabular-nums">
                    {formatRate(fact.costOut)}
                  </td>
                  <td className="border-b border-[var(--border)] py-1 text-right text-[10px]">
                    {[
                      fact.reasoning === true ? 'thinking' : null,
                      fact.input !== undefined && fact.input.includes('image') ? 'vision' : null
                    ]
                      .filter((flag): flag is string => flag !== null)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-[var(--text-secondary)]">Usage in this session</h3>
          <Button
            type="button"
            variant="ghost"
            disabled={!hasSession || usage.loading}
            onClick={usage.refresh}
            data-testid="routing-usage-refresh"
          >
            {usage.loading ? 'Reading…' : 'Refresh'}
          </Button>
        </div>

        {!hasSession ? (
          <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]">
            Open a chat to see what it has spent. Calls are attributed to the purpose that made
            them, so a big bill can be traced back to a summariser rather than guessed at.
          </p>
        ) : usage.error !== null ? (
          <p role="alert" className="mt-2 text-[11px] leading-4 text-[var(--danger-text)]">
            Could not read this chat&apos;s ledger: {usage.error}
          </p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
              <span>
                Calls <span className="tabular-nums text-[var(--text)]">{report?.total.calls ?? 0}</span>
              </span>
              <span>
                Input <span className="tabular-nums text-[var(--text)]">{formatTokens(report?.total.input)}</span>
              </span>
              <span>
                Output <span className="tabular-nums text-[var(--text)]">{formatTokens(report?.total.output)}</span>
              </span>
              <span>
                Cache read{' '}
                <span className="tabular-nums text-[var(--text)]">{formatTokens(report?.total.cacheRead)}</span>
              </span>
              <span>
                Cost <span className="tabular-nums text-[var(--text)]">{formatUsd(report?.total.cost ?? 0)}</span>
              </span>
            </div>

            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <UsageTable
                title="By purpose"
                testId="routing-usage-purpose"
                buckets={report?.byPurpose ?? []}
                labelOf={purposeLabel}
              />
              <UsageTable
                title="By model"
                testId="routing-usage-model"
                buckets={report?.byModel ?? []}
                labelOf={(key) => key}
              />
            </div>

            <p className="mt-3 text-[10px] leading-3.5 text-[var(--text-muted)]">
              Costs are the kernel&apos;s own figures, in USD, as reported per response. A model with
              no published price shows tokens but contributes nothing to the total.
            </p>
          </>
        )}
      </section>
    </div>
  )
}

export default memo(RoutingSettings)
