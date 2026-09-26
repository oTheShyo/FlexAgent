import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuestionSettings } from '../types'
import { codexApi } from '../api'

export interface UseQuestionSettingsResult {
  settings: QuestionSettings | null
  /** Set the auto-continue switch (issue 10). Resolves false when rejected. */
  setAutoContinue: (enabled: boolean) => Promise<boolean>
}

/**
 * Settings › General › Questions (issue 10).
 *
 * Only questions created after a change honour it: an answer panel already on
 * screen has a countdown the user has presumably noticed, and silently
 * extending it — or killing it — would be worse than leaving it alone.
 */
export function useQuestionSettings(): UseQuestionSettingsResult {
  const [settings, setSettings] = useState<QuestionSettings | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    void (async () => {
      try {
        const next = await codexApi.getQuestionSettings()
        if (!disposedRef.current) setSettings(next)
      } catch {
        // Unknown stays unknown; the switch renders disabled.
      }
    })()
    return () => {
      disposedRef.current = true
    }
  }, [])

  const setAutoContinue = useCallback(async (enabled: boolean): Promise<boolean> => {
    try {
      const next = await codexApi.setQuestionAutoContinue({ autoContinue: enabled })
      if (!disposedRef.current) setSettings(next)
      return true
    } catch {
      return false
    }
  }, [])

  return { settings, setAutoContinue }
}

export default useQuestionSettings
