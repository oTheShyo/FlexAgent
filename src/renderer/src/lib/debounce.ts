/**
 * Trailing-edge debounce for the Composer's list sources.
 *
 * Both list sources behind the `@`/`#` popups hit work that is per-keystroke
 * expensive: the file list is filtered out of a whole-repo path set and the
 * session search runs a main-process scan over stored transcripts. Calling
 * either on every `keyup` made typing feel like it was competing with the
 * scan, which is exactly when the user is typing the fastest.
 *
 * Deliberately generic and timer-based rather than rAF-based: these are
 * async sources (a scan, an IPC round trip), so the meaningful unit of
 * "settled" is milliseconds, not a frame.
 */
export interface Debounced<TArgs extends unknown[]> {
  (...args: TArgs): void
  /** Drop a pending invocation; used on unmount so a late call cannot land. */
  cancel(): void
  /** Run a pending invocation immediately. */
  flush(): void
}

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number
): Debounced<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: TArgs | null = null

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const debounced = ((...args: TArgs): void => {
    pending = args
    clear()
    timer = setTimeout(() => {
      timer = null
      const args_ = pending
      pending = null
      if (args_ === null) return
      fn(...args_)
    }, delayMs)
  }) as Debounced<TArgs>

  debounced.cancel = (): void => {
    clear()
    pending = null
  }

  debounced.flush = (): void => {
    const args_ = pending
    clear()
    pending = null
    if (args_ !== null) fn(...args_)
  }

  return debounced
}
