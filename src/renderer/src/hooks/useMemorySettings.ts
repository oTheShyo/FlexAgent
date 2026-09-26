import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemorySettings } from '../types'
import { codexApi } from '../api'

export interface UseMemorySettingsResult {
  settings: MemorySettings | null
  /** Set the automatic extraction switch. Resolves false when rejected. */
  setAutoExtract: (enabled: boolean) => Promise<boolean>
}

/**
 * Settings › General › Memory (issue 15).
 *
 * The switch is off by default and only affects sessions created after it
 * changes — which is why the panel says so instead of implying the open chat
 * starts remembering immediately.
 */
export function useMemorySettings(): UseMemorySettingsResult {
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    void (async () => {
      try {
        const next = await codexApi.getMemorySettings()
        if (!disposedRef.current) setSettings(next)
      } catch {
        // Leave it null: the switch renders disabled rather than claiming a
        // state the backend never confirmed.
      }
    })()
    return () => {
      disposedRef.current = true
    }
  }, [])

  const setAutoExtract = useCallback(async (enabled: boolean): Promise<boolean> => {
    try {
      const next = await codexApi.setMemoryAutoExtract({ autoExtract: enabled })
      if (!disposedRef.current) setSettings(next)
      return true
    } catch {
      return false
    }
  }, [])

  return { settings, setAutoExtract }
}

export default useMemorySettings
