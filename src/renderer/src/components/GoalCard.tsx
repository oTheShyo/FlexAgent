import { useCallback, type ReactElement } from 'react'
import type { GoalStateSummary } from '../types'
import { formatElapsed, groupTodosByRound } from '../lib/goalCard'

/**
 * Goal card (ticket 06). The description and elapsed time up top, the todo
 * groups by round in the middle (an item stays in the round it first appeared
 * in, even when a later round completes it), the controls at the bottom.
 */
export function GoalCard({
  goal,
  onCommand
}: {
  goal: GoalStateSummary
  /** Send a goal command (or a natural-language adjustment) as the user would. */
  onCommand: (raw: string) => void
}): ReactElement {
  const startedAt = goal.iterations[0]?.startedAt ?? goal.updatedAt
  const groups = groupTodosByRound(goal.iterations)
  const openTodos = groups.flatMap((group) => group.items.filter((item) => !item.done))
  const last = goal.iterations[goal.iterations.length - 1]
  const running = goal.status === 'active' && last !== undefined && last.verdict === undefined

  const command = useCallback(
    (raw: string): void => onCommand(raw),
    [onCommand]
  )

  return (
    <div
      data-testid="goal-card"
      className="mx-auto w-full max-w-3xl rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[var(--text-primary)]">
            <span className="font-medium">{goal.status === 'reached' ? '✓ Goal' : 'Goal'}</span>{' '}
            {goal.text}
          </p>
          <p className="mt-0.5 text-[var(--text-subtle)]" data-testid="goal-card-meta">
            {goal.status} · round {goal.iterations.length}/{goal.maxRounds} ·{' '}
            {formatElapsed(startedAt, Date.now())}
            {running ? ' · verifying…' : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {goal.status !== 'reached' && goal.status !== 'paused' && (
            <button
              type="button"
              data-testid="goal-pause"
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
              onClick={() => command('/goal pause')}
            >
              Pause
            </button>
          )}
          {(goal.status === 'paused' || goal.status === 'capped') && (
            <button
              type="button"
              data-testid="goal-resume"
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
              onClick={() => command('/goal resume')}
            >
              Resume
            </button>
          )}
          <button
            type="button"
            data-testid="goal-clear"
            className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
            onClick={() => command('/goal clear')}
          >
            Clear
          </button>
        </div>
      </div>

      {groups.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-2">
          {groups.map((group) => (
            <div key={group.round} data-testid={`goal-round-${group.round}`}>
              <p className="text-[11px] text-[var(--text-subtle)]">Round {group.round}</p>
              <ul className="mt-1 space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.text} className={item.done ? 'text-[var(--text-subtle)] line-through' : 'text-[var(--text-secondary)]'}>
                    {item.done ? '✓ ' : '· '}
                    {item.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {openTodos.length > 0 && goal.status === 'active' && (
        <p className="mt-2 border-t border-[var(--border)] pt-2 text-[11px] text-[var(--text-subtle)]" data-testid="goal-progress">
          {openTodos.length} outstanding item{openTodos.length === 1 ? '' : 's'} — the next round
          finishes them first.
        </p>
      )}
    </div>
  )
}

export default GoalCard
