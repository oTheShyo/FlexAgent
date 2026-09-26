import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Text selection inside the transcript, for the "add to the current task" bar.
 *
 * The thing this hook is really about is the streaming case. While the assistant
 * is mid-reply every arriving delta rewrites the text node the user selected,
 * so a toolbar that read the selection back out of the DOM on each render would
 * drift, grow, or point at a word that no longer exists. Here the selection is
 * copied into state the moment it settles and nothing ever reads the DOM again:
 * the copy is what becomes a reference, so a delta cannot overwrite what was
 * captured.
 *
 * Known limit: only one line. A drag that crosses a line break (two chat rows,
 * or two lines inside a tool result) yields no bar at all — anchoring a bar to a
 * fragment that is no longer where the user left it is worse than showing
 * nothing.
 */

export type SelectionSource = 'assistant' | 'tool' | 'user' | 'error'

export interface SelectionSnapshot {
  /** The frozen copy. */
  text: string
  /** Which kind of row it came from — becomes the label on the reference chip. */
  source: SelectionSource
  /** Characters, shown on the bar so an accidental two-character pick is visible. */
  length: number
  /** Viewport position of the selection's end, for the bar. */
  x: number
  y: number
  /**
   * The live range, kept only so the bar can follow a scroll. `null` once the
   * node behind it is gone (React replaced the streamed row with its final
   * version), at which point the bar hides rather than float over nothing.
   */
  range: Range | null
}

/** Below this the pick is noise (a stray double-click on a symbol). */
const MIN_CHARS = 3
/** No bar for an empty-looking pick, however many characters it claims. */
const MAX_CHARS = 32_000

function sourceOf(node: Node | null): SelectionSource | null {
  let element: Element | null = null
  if (node === null) return null
  if (node.nodeType === Node.ELEMENT_NODE) element = node as Element
  else element = node.parentElement
  // The toolbar opts out explicitly: selecting its own label must not spawn
  // another bar over the label.
  const host = element?.closest('[data-selection-host]')
  if (host === null || host === undefined) return null
  const marked = element?.closest('[data-selection-source]')
  const value = marked?.getAttribute('data-selection-source')
  return value === 'assistant' ||
    value === 'tool' ||
    value === 'user' ||
    value === 'error'
    ? value
    : null
}

function measure(range: Range): { x: number; y: number } {
  const rect = range.getBoundingClientRect()
  return { x: rect.right, y: rect.top }
}

function readSelection(host: HTMLElement | null): SelectionSnapshot | null {
  if (host === null) return null
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString()
  // Single line only — see the header.
  if (text.includes('\n') || text.trim().length === 0) return null
  if (text.length < MIN_CHARS || text.length > MAX_CHARS) return null
  const range = selection.getRangeAt(0)
  if (!host.contains(range.startContainer)) return null
  const source = sourceOf(selection.anchorNode)
  if (source === null) return null
  const { x, y } = measure(range)
  return { text: text.trim(), source, length: text.length, x, y, range }
}

export interface ChatSelection {
  snapshot: SelectionSnapshot | null
  /** Drops the bar; called once a pick has been turned into a reference. */
  dismiss: () => void
}

/**
 * Structurally typed so the transcript's own scroll container can be handed
 * over without contravariance gymnastics.
 */
export interface SelectionHost {
  current: HTMLElement | null
}

export function useChatSelection(hostRef: SelectionHost): ChatSelection {
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null)
  const snapshotRef = useRef<SelectionSnapshot | null>(null)
  snapshotRef.current = snapshot

  const dismiss = useCallback((): void => {
    setSnapshot(null)
    const selection = window.getSelection()
    selection?.removeAllRanges()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const sync = (): void => {
      const next = readSelection(host)
      const current = snapshotRef.current
      // Re-measuring an identical snapshot on every delta would set state on
      // each one; compare the parts that matter instead of the Range identity.
      if (
        next !== null &&
        current !== null &&
        next.text === current.text &&
        next.source === current.source
      ) {
        return
      }
      setSnapshot(next)
    }

    const schedule = (): void => {
      window.requestAnimationFrame(sync)
    }

    const repaint = (): void => {
      const current = snapshotRef.current
      if (current === null) return
      // The row behind the bar has been replaced by a newer render.
      if (current.range !== null && !current.range.startContainer.isConnected) {
        setSnapshot(null)
        return
      }
      const next = readSelection(host)
      if (next === null) {
        setSnapshot(null)
        return
      }
      setSnapshot({ ...current, x: next.x, y: next.y })
    }

    document.addEventListener('selectionchange', schedule)
    // Scroll/resize only needs a re-measure: re-reading the DOM there would
    // fight with deltas that arrive in the same frame.
    const onRepaint = (): void => {
      window.requestAnimationFrame(repaint)
    }
    host.addEventListener('scroll', onRepaint, { passive: true })
    window.addEventListener('resize', onRepaint)

    return () => {
      document.removeEventListener('selectionchange', schedule)
      host.removeEventListener('scroll', onRepaint)
      window.removeEventListener('resize', onRepaint)
    }
  }, [hostRef])

  return { snapshot, dismiss }
}
