import { memo } from 'react'
import type { PermissionDecision } from '../types'
import type { PermissionRequest } from '../hooks/useChat'
import { ShieldIcon } from './icons'
import { Button } from './ui'

export interface PermissionDialogProps {
  request: PermissionRequest
  onRespond: (decision: PermissionDecision) => void
}

function PermissionDialog({ request, onRespond }: PermissionDialogProps) {
  const argsJson = JSON.stringify(request.args, null, 2)

  return (
    // Topmost layer on purpose: a run can ask for permission while Settings
    // (z-70) or the palette (z-60) is open, and the request has to win.
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="presentation">
      <div className="absolute inset-0 bg-[var(--overlay)]" aria-hidden="true" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Permission required"
        className="relative w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-lg)]"
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

        {request.reason && <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">{request.reason}</p>}

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
          <Button type="button" variant="primary" onClick={() => onRespond('allowOnce')}>
            Allow once
          </Button>
        </div>
      </div>
    </div>
  )
}

export default memo(PermissionDialog)
