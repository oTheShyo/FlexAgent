import { memo } from 'react'
import type { ReactElement } from 'react'
import type { SelectionSnapshot } from '../hooks/useChatSelection'
import { PlusIcon } from './icons'

/**
 * The bar that floats over a single-line selection in the transcript.
 *
 * `position: fixed` with viewport coordinates rather than absolute positioning
 * in the flow: the bar is anchored to where the text *is*, and the transcript
 * scrolls under it. It carries `data-selection-host`, so selecting the bar's own
 * label can never spawn another bar over itself.
 */

export interface SelectionToolbarProps {
  snapshot: SelectionSnapshot | null
  /** True while the draft already holds the limit — the button still says so. */
  disabled?: boolean
  onAdd: (snapshot: SelectionSnapshot) => void
}

const LABELS = {
  assistant: 'Assistant reply',
  tool: 'Tool output',
  user: 'Your message',
  error: 'Error'
} as const

function SelectionToolbar({ snapshot, disabled = false, onAdd }: SelectionToolbarProps): ReactElement | null {
  if (snapshot === null) return null
  const label = LABELS[snapshot.source]
  // Clamp so a selection near the right edge does not push the bar off-screen.
  const left = Math.min(Math.max(snapshot.x - 150, 8), Math.max(window.innerWidth - 316, 8))
  return (
    <div
      data-selection-host="true"
      role="toolbar"
      aria-label={`Selected ${label.toLowerCase()}`}
      className="fx-fade fixed z-40 select-none"
      style={{ left, top: Math.max(snapshot.y - 44, 8) }}
    >
      <div className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] py-1 pl-3 pr-1 shadow-[var(--shadow-lg)]">
        <span className="max-w-[220px] truncate text-[11px] text-[var(--text-muted)]">
          {label} · {snapshot.length} chars
        </span>
        <button
          type="button"
          data-testid="selection-add"
          disabled={disabled}
          onClick={() => onAdd(snapshot)}
          className="flex items-center gap-1 rounded-full bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent-contrast)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PlusIcon className="h-3 w-3" />
          Add to the current task
        </button>
      </div>
    </div>
  )
}

export default memo(SelectionToolbar)
