import { memo, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PermissionDecision } from '../types'
import type { PermissionRequest } from '../hooks/useChat'
import { ShieldIcon } from './icons'
import { Button } from './ui'

export interface PermissionDialogProps {
  request: PermissionRequest
  onRespond: (decision: PermissionDecision) => void
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function PermissionDialog({ request, onRespond }: PermissionDialogProps) {
  const argsJson = JSON.stringify(request.args, null, 2)
  const verdict = request.verdict
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Re-focus on every request: autoFocus only covers the initial mount.
  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLButtonElement>('[data-testid="permission-allow-once"]')
      ?.focus()
  }, [request])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    const outside = active === null || !dialog.contains(active)
    if (event.shiftKey) {
      if (outside || active === first || active === dialog) {
        event.preventDefault()
        last.focus()
      }
    } else if (outside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    // Topmost layer on purpose: a run can ask for permission while Settings
    // (z-70) or the palette (z-60) is open, and the request has to win.
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="presentation">
      <div className="fx-overlay absolute inset-0 bg-[var(--overlay)]" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="Permission required"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="fx-rise relative w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-lg)] focus:outline-none"
        data-testid="permission-dialog"
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
            <ShieldIcon />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text)]">Permission required</h2>
            <p className="truncate text-xs text-[var(--text-muted)]">{request.label}</p>
          </div>
          <span className="ml-auto shrink-0 rounded border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
            {request.name}
          </span>
        </div>

        {verdict && (
          <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {verdict.via} · {verdict.reason}
          </p>
        )}

        {request.reason && <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">{request.reason}</p>}

        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          Trust level: {request.mode === 'plan' ? 'Plan' : request.mode}
        </p>

        <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-3 font-mono text-xs leading-5 text-[var(--text-secondary)]">
          {argsJson}
        </pre>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onRespond('deny')}>
            Deny
          </Button>
          <Button type="button" variant="secondary" onClick={() => onRespond('allowSession')}>
            Allow session
          </Button>
          <Button
            type="button"
            variant="primary"
            autoFocus
            data-testid="permission-allow-once"
            onClick={() => onRespond('allowOnce')}
          >
            Allow once
          </Button>
        </div>
      </div>
    </div>
  )
}

export default memo(PermissionDialog)
