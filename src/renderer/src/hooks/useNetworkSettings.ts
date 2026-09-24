import { useCallback, useEffect, useRef, useState } from 'react'
import type { NetworkSettings, SetNetworkInput } from '../types'
import { codexApi } from '../api'

export interface UseNetworkSettingsResult {
  settings: NetworkSettings | null
  loading: boolean
  saving: boolean
  /** Last read/write failure; cleared on the next attempt. */
  error: string | null
  save: (patch: SetNetworkInput) => Promise<boolean>
}

function errorMessageOf(err: unknown): string {
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

/**
 * Owns Settings › Network, which writes the *kernel's* `~/.pi/agent/settings.json`
 * rather than a FlexAgent file — hence the path comes from the kernel, never
 * from a guess.
 *
 * The read is only half the story: after a write the main process re-installs
 * the kernel's HTTP dispatcher and reports whether that actually took. A saved
 * proxy with `dispatcher: 'unavailable'` does nothing at all, so the returned
 * settings — not the submitted patch — are what the panel renders.
 */
export function useNetworkSettings(): UseNetworkSettingsResult {
  const [settings, setSettings] = useState<NetworkSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    void (async () => {
      try {
        const next = await codexApi.getNetworkSettings()
        if (disposedRef.current) return
        setSettings(next)
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

  const save = useCallback(async (patch: SetNetworkInput): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      setSettings(await codexApi.setNetworkSettings(patch))
      return true
    } catch (err) {
      setError(errorMessageOf(err))
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  return { settings, loading, saving, error, save }
}

export default useNetworkSettings
