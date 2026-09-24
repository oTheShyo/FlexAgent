import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionId, UsageReport } from '../types'
import { codexApi } from '../api'

export interface UseSessionUsageResult {
  report: UsageReport | null
  loading: boolean
  error: string | null
  /** Re-read after a run finishes; the ledger is a snapshot, not a stream. */
  refresh: () => void
}

function errorMessageOf(err: unknown): string {
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

/**
 * Token/cost ledger for one session, grouped by purpose and by model.
 *
 * This is the "调用来源" axis of the article's §12: without a purpose on every
 * call, "why is this conversation expensive" has no answer once a session
 * compacts, summarises and chats on three different models.
 *
 * Read on demand rather than subscribed: the kernel only reports usage after a
 * response settles, so the panel refreshes when asked.
 */
export function useSessionUsage(sessionId: SessionId | null): UseSessionUsageResult {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    if (sessionId === null) {
      setReport(null)
      setError(null)
      setLoading(false)
      return () => {
        disposedRef.current = true
      }
    }
    setLoading(true)
    void (async () => {
      try {
        const next = await codexApi.sessionUsage(sessionId)
        if (disposedRef.current) return
        setReport(next)
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
  }, [sessionId, nonce])

  const refresh = useCallback((): void => {
    setNonce((value) => value + 1)
  }, [])

  return { report, loading, error, refresh }
}

export default useSessionUsage
