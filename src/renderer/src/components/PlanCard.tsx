import { useState, type ReactElement } from 'react'
import type { PlanState } from '../types'

/**
 * Plan card (ticket 07): the agent's proposal, as a checklist, with the three
 * ways out — approve (writes unlock and execution starts), request changes
 * (feedback goes back, the agent revises in plan mode), or cancel.
 *
 * The blocked-write count is shown when non-zero on purpose: it is the receipt
 * proving plan mode refused real attempts instead of never being asked.
 */
export function PlanCard({
  plan,
  onRespond
}: {
  plan: PlanState
  /** Approve, reject with feedback, or cancel. */
  onRespond: (input: { decision: 'approve' | 'reject' | 'cancel'; note?: string }) => void
}): ReactElement {
  const [revising, setRevising] = useState(false)
  const [note, setNote] = useState('')
  const pending = plan.status === 'draft'
  const blocked = plan.blockedWrites ?? 0

  return (
    <div
      data-testid="plan-card"
      className="mx-auto w-full max-w-3xl rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-[var(--text-primary)]">
            {plan.status === 'approved'
              ? '✓ Plan approved'
              : plan.status === 'rejected'
                ? 'Plan — changes requested'
                : plan.status === 'cancelled'
                  ? 'Plan cancelled'
                  : 'Proposed plan'}
          </p>
          <p className="mt-0.5 text-[var(--text-subtle)]" data-testid="plan-card-meta">
            {plan.steps.length > 0
              ? `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`
              : 'free-form'}
            {' · no writes allowed until you approve'}
            {blocked > 0 ? ` · ${blocked} write${blocked === 1 ? '' : 's'} blocked` : ''}
          </p>
        </div>
        {pending && !revising && (
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              data-testid="plan-approve"
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
              onClick={() => onRespond({ decision: 'approve' })}
            >
              Approve
            </button>
            <button
              type="button"
              data-testid="plan-reject"
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
              onClick={() => setRevising(true)}
            >
              Request changes
            </button>
            <button
              type="button"
              data-testid="plan-cancel"
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
              onClick={() => onRespond({ decision: 'cancel' })}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {plan.steps.length > 0 ? (
        <ol className="mt-3 space-y-0.5 border-t border-[var(--border)] pt-2" data-testid="plan-steps">
          {plan.steps.map((step) => (
            <li key={step.index} className="text-[var(--text-secondary)]">
              <span className="text-[var(--text-subtle)]">{step.index}. </span>
              {step.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 whitespace-pre-wrap border-t border-[var(--border)] pt-2 text-[var(--text-secondary)]">
          {plan.text.trim()}
        </p>
      )}

      {revising && pending && (
        <div className="mt-3 border-t border-[var(--border)] pt-2">
          <label className="block text-[11px] text-[var(--text-subtle)]" htmlFor="plan-feedback">
            What should change?
          </label>
          <textarea
            id="plan-feedback"
            data-testid="plan-feedback"
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px] text-[var(--text-primary)]"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              data-testid="plan-send-feedback"
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
              disabled={note.trim().length === 0}
              onClick={() => {
                onRespond({ decision: 'reject', note: note.trim() })
                setNote('')
                setRevising(false)
              }}
            >
              Send
            </button>
            <button
              type="button"
              className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]"
              onClick={() => {
                setRevising(false)
                setNote('')
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {plan.note !== undefined && plan.status === 'rejected' && (
        <p className="mt-2 border-t border-[var(--border)] pt-2 text-[11px] text-[var(--text-subtle)]">
          Asked for: {plan.note}
        </p>
      )}
    </div>
  )
}

export default PlanCard
