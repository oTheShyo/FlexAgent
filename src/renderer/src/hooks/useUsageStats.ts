import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalUsageStats } from '../types'
import { codexApi } from '../api'

export interface UseUsageStatsResult {
  stats: GlobalUsageStats | null
  loading: boolean
  error: string | null
  /** Re-read on demand: the report is a snapshot of the log, not a stream. */
  refresh: () => void
}

function errorMessageOf(err: unknown): string {
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

/**
 * Settings › Usage (issue 09).
 *
 * Read on demand, never subscribed: the numbers come from an offline
 * aggregation over the observability log, so there is nothing to stream — and a
 * refresh is one IPC call, not a new reporting channel.
 */
export function useUsageStats(): UseUsageStatsResult {
  const [stats, setStats] = useState<GlobalUsageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    setLoading(true)
    void (async () => {
      try {
        const next = await codexApi.getUsageStats()
        if (disposedRef.current) return
        setStats(next)
        setError(null)
      } catch (err) {
        if (!disposedRef.current) setError(errorMessageOf(err))
      } finally {
        if (!disposedRef.current) setLoading(false)
      }
    })()
    return () => {
      disposedRef.current = true
    }
  }, [nonce])

  const refresh = useCallback((): void => setNonce((value) => value + 1), [])

  return { stats, loading, error, refresh }
}

export default useUsageStats
