import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelFacts, ModelOption, ModelRole, ModelRoleState, RoutingState } from '../types'
import { codexApi } from '../api'

export interface UseModelRoutingResult {
  roles: ModelRoleState[]
  /** The kernel's catalogue, so a role can be picked on facts rather than on a name. */
  facts: ModelFacts[]
  /** routing.json path, for the panel copy. Null until the bridge answers. */
  path: string | null
  loading: boolean
  saving: boolean
  /** Last read/write failure; cleared on the next attempt. */
  error: string | null
  /**
   * Persist one role's binding (or clear it with `null`). Resolves to false only
   * when the write itself failed — a binding the kernel cannot resolve still
   * counts as saved, and comes back as that role's `error`.
   */
  bind: (role: ModelRole, model: ModelOption | null) => Promise<boolean>
}

function errorMessageOf(err: unknown): string {
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

/**
 * Owns the Settings › Routing table. Every write goes through the main process,
 * which persists `~/.flexagent/routing.json` and then re-resolves every role
 * against the live kernel runtime — what comes back is the post-write truth
 * (a model can be stored and still be unusable; see ModelRoleState.error).
 *
 * Nothing here re-reads the composer's model list: the `chat` role only takes
 * effect on the *next* session, so there is no list to refresh.
 */
export function useModelRouting(): UseModelRoutingResult {
  const [state, setState] = useState<RoutingState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    void (async () => {
      try {
        const next = await codexApi.listModelRoles()
        if (disposedRef.current) return
        setState(next)
      } catch (err) {
        if (!disposedRef.current) setError(errorMessageOf(err))
      } finally {
        if (!disposedRef.current) setLoading(false)
      }
    })()
    return () => {
      disposedRef.current = true
    }
  }, [])

  const bind = useCallback(async (role: ModelRole, model: ModelOption | null): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      setState(await codexApi.setModelRole({ role, model }))
      return true
    } catch (err) {
      setError(errorMessageOf(err))
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  return {
    roles: state?.roles ?? [],
    facts: state?.facts ?? [],
    path: state?.path ?? null,
    loading,
    saving,
    error,
    bind
  }
}

export default useModelRouting
