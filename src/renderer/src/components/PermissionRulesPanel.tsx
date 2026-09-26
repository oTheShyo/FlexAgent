import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { codexApi } from '../api'
import type { PermissionRule, PermissionRuleSet, PermissionRuleScope } from '../types'

const SCOPE_LABEL: Record<PermissionRuleScope, string> = {
  project: 'this project',
  global: 'every project'
}

function formatWhen(createdAt: number | undefined): string {
  if (createdAt === undefined || createdAt === 0) return 'unknown'
  return new Date(createdAt).toLocaleString()
}

function formatMatcher(rule: PermissionRule): ReactNode {
  const parts: string[] = []
  parts.push(rule.tool !== undefined ? `tool ${rule.tool}` : 'tool *')
  if (rule.command !== undefined) parts.push(`command contains "${rule.command}"`)
  if (rule.path !== undefined) parts.push(`path contains "${rule.path}"`)
  return parts.join(' · ')
}

function RuleRow({
  rule,
  onRevoke
}: {
  rule: PermissionRule
  onRevoke?: () => void
}): ReactNode {
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-2">
      <div className="min-w-0">
        <p className="text-xs text-[var(--text-secondary)]">{formatMatcher(rule)}</p>
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]" title={rule.note}>
          {rule.note ?? 'no note'}
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          {rule.action} · {rule.scope === undefined ? 'every project' : SCOPE_LABEL[rule.scope]}
          {rule.scope === 'project' && rule.projectPath !== undefined ? ` (${rule.projectPath})` : ''} · added{' '}
          {formatWhen(rule.createdAt)}
        </p>
      </div>
      {onRevoke !== undefined && (
        <button
          type="button"
          onClick={onRevoke}
          data-testid={`permission-rule-revoke-${rule.id ?? 'unknown'}`}
          className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
        >
          Revoke
        </button>
      )}
    </li>
  )
}

/**
 * The rules actually in force, user ones removable and built-ins read-only.
 *
 * Both lists are shown on purpose: a rule file that contains only what the user
 * typed looks like the whole policy, and every one of those built-in `deny`
 * entries is the reason a `bash` call never reaches the classifier.
 */
export default function PermissionRulesPanel(): ReactNode {
  const [rules, setRules] = useState<PermissionRuleSet | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRules(await codexApi.listPermissionRules())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const revoke = useCallback(
    async (id: string): Promise<void> => {
      setError(null)
      try {
        await codexApi.removePermissionRule({ id })
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh]
  )

  const userRules = (rules?.rules ?? []).filter((rule) => rule.origin !== 'builtin')
  const builtinRules = (rules?.rules ?? []).filter((rule) => rule.origin === 'builtin')

  return (
    <>
      <section
        className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5"
        data-testid="permission-rules-user"
      >
        <h3 className="text-xs font-medium text-[var(--text-secondary)]">
          Your rules <span className="text-[var(--text-muted)]">({userRules.length})</span>
        </h3>
        {userRules.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Nothing saved. The confirmation dialog offers “always allow · this project”, “always allow ·
            any project” and “always deny”, and each one lands here.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {userRules.map((rule) => (
              <RuleRow key={rule.id ?? 'rule'} rule={rule} onRevoke={() => void revoke(rule.id ?? '')} />
            ))}
          </ul>
        )}
        {rules !== null && (
          <p className="mt-2 truncate font-mono text-[11px] text-[var(--text-muted)]">
            {rules.sourcePath}
          </p>
        )}
      </section>

      <section
        className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5"
        data-testid="permission-rules-builtin"
      >
        <h3 className="text-xs font-medium text-[var(--text-secondary)]">Built-in rules (read-only)</h3>
        <ul className="mt-2 space-y-1.5">
          {builtinRules.map((rule) => (
            <RuleRow key={rule.id ?? rule.action} rule={rule} />
          ))}
        </ul>
      </section>

      {error !== null && (
        <p role="alert" className="text-xs text-[var(--text-secondary)]" data-testid="permission-rules-error">
          {error}
        </p>
      )}
    </>
  )
}
