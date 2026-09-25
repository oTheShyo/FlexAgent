import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PermissionDecision } from '../types'
import type { PermissionRequest } from '../hooks/useChat'
import { codexApi } from '../api'
import type { PermissionRuleScope } from '../types'
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
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const capturedInvokerRef = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    // Capture-once: a StrictMode re-run must not capture our own focused button.
    if (!capturedInvokerRef.current) {
      capturedInvokerRef.current = true
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== dialogRef.current
      ) {
        restoreFocusRef.current = active
      }
    }
    // Re-focus on every request: autoFocus only covers the initial mount.
    dialogRef.current
      ?.querySelector<HTMLButtonElement>('[data-testid="permission-allow-once"]')
      ?.focus()
  }, [request])

  useEffect(() => {
    return () => {
      const prev = restoreFocusRef.current
      if (prev !== null && document.contains(prev)) prev.focus()
    }
  }, [])

  /**
   * Answer the call, optionally remembering it first.
   *
   * The rule is written before the answer is sent: the run must not be able to
   * proceed on a promise the rule file does not keep. A failed write therefore
   * keeps the dialog open with the reason — answering anyway would turn "your
   * settings could not be saved" into an invisible no-op. Escape still denies,
   * so a wedged write cannot trap the run.
   *
   * Persisting is not expressible as a `PermissionDecision`: the kernel's
   * decision vocabulary is fixed at allowOnce/allowSession/deny, so the dialog
   * writes the rule itself and then answers the kernel as if for one call.
   */
  const respond = useCallback(
    (decision: PermissionDecision, scope?: PermissionRuleScope): void => {
      if (scope === undefined) {
        onRespond(decision)
        return
      }
      setSaveError(null)
      codexApi
        .savePermissionRule({
          tool: request.name,
          args: request.args,
          sessionId: request.sessionId,
          scope,
          action: decision === 'deny' ? 'deny' : 'allow'
        })
        .then(
          () => onRespond(decision),
          (err: unknown) => setSaveError(err instanceof Error ? err.message : String(err))
        )
    },
    [onRespond, request]
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Security: Escape = deny. stopPropagation blocks the window Escape
      // stack from firing a second respond() in the same tick.
      event.preventDefault()
      event.stopPropagation()
      onRespond('deny')
      return
    }
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
          <span className="ml-auto shrink-0 rounded border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]">
            {request.name}
          </span>
        </div>

        {verdict && (
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {verdict.via} · {verdict.reason}
          </p>
        )}

        {request.reason && <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">{request.reason}</p>}

        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Trust level: {request.mode === 'plan' ? 'Plan' : request.mode}
        </p>

        <pre
          tabIndex={0}
          className="mt-3 max-h-40 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-3 font-mono text-xs leading-5 text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          {argsJson}
        </pre>

        {/* Two tiers on purpose. "Allow once" and "Allow session" are forgotten
            automatically; the second tier writes to `~/.flexagent/permissions.json`
            and is still there after a restart, so it says so before it asks. */}
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-end gap-2">
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

          <div className="border-t border-[var(--border)] pt-2.5">
            <p
              className="text-[11px] leading-4 text-[var(--text-muted)]"
              data-testid="permission-scope-warning"
            >
              Remembering writes a rule to <code className="font-mono">permissions.json</code> that
              outlives this run — undo it under Settings › Permissions.{' '}
              <strong className="font-medium text-[var(--text-secondary)]">This project</strong> applies
              only while the session works inside this workspace;{' '}
              <strong className="font-medium text-[var(--text-secondary)]">any project</strong> applies to
              every workspace you open, including ones you have not created yet. Refusals are always
              honoured first.
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                data-testid="permission-deny-always"
                title="Refuse this class of call from now on, everywhere"
                onClick={() => respond('deny', 'global')}
              >
                Always deny
              </Button>
              <Button
                type="button"
                variant="secondary"
                data-testid="permission-allow-global"
                title="Allow this class of call in every project, until you remove the rule"
                onClick={() => respond('allowOnce', 'global')}
              >
                Always allow · any project
              </Button>
              <Button
                type="button"
                variant="secondary"
                data-testid="permission-allow-project"
                title="Allow this class of call inside this project, until you remove the rule"
                onClick={() => respond('allowOnce', 'project')}
              >
                Always allow · this project
              </Button>
            </div>
          </div>
        </div>

        {saveError !== null && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5 text-[11px] leading-4 text-[var(--text-secondary)]"
            data-testid="permission-scope-error"
          >
            The rule was not saved: {saveError}. Nothing was recorded for this choice — pick another
            option below, or press Escape to deny.
          </p>
        )}
      </div>
    </div>
  )
}

export default memo(PermissionDialog)
