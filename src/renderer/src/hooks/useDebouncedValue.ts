import { useEffect, useState } from 'react'

/**
 * Trailing-edge debounce for a value, not a callback.
 *
 * The Composer's popup queries change on every keystroke, and the work behind
 * some of them (a repo walk, a transcript scan) costs more than the keystroke
 * that triggered it. Debouncing the *value* rather than the handler keeps the
 * trigger and the query in step: the popup reads `null` while a query is still
 * settling, which is honest — there is no list yet.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return settled
}

export default useDebouncedValue
