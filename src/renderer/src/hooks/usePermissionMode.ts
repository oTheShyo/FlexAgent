import { useCallback, useEffect, useState } from 'react'
import { codexApi } from '../api'
import { PERMISSION_MODES, type PermissionMode } from '../types'

export interface UsePermissionMode {
  mode: PermissionMode
  availableModes: readonly PermissionMode[]
  setMode: (mode: PermissionMode) => Promise<void>
  pending: boolean
  error: string | null
}

/**
 * Trust level for the active session. The kernel persists the choice to
 * `~/.flexagent/settings.json`, so it survives a restart; switching back to
 * whatever the session had at attach time is not possible without re-attaching.
 */
export function usePermissionMode(sessionId: string | null): UsePermissionMode {
  const [mode, setModeState] = useState<PermissionMode>('default')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setModeState('default')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const value = await codexApi.getPermissionMode(sessionId)
        if (!cancelled) setModeState(value)
      } catch {
        if (!cancelled) setModeState('default')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const setMode = useCallback(
    async (next: PermissionMode): Promise<void> => {
      if (!sessionId) return
      if (!PERMISSION_MODES.includes(next)) return
      setPending(true)
      setError(null)
      try {
        await codexApi.setPermissionMode({ sessionId, mode: next })
        setModeState(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(false)
      }
    },
    [sessionId]
  )

  return { mode, availableModes: PERMISSION_MODES, setMode, pending, error }
}
