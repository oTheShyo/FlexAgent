import { useCallback, useEffect, useRef, useState } from 'react'
import type { CustomModelEntry, CustomModelRef, CustomModelSaveInput } from '../types'
import { codexApi } from '../api'

export interface UseCustomModelsResult {
  models: CustomModelEntry[]
  /** models.json path, for the panel copy. Null until the bridge answers. */
  path: string | null
  loading: boolean
  saving: boolean
  /** Last write/read failure; cleared on the next attempt. */
  error: string | null
  /**
   * Written to models.json but not resolvable by the kernel, or vice versa.
   * Separate from `error` because the file change stands — the UI has to say so.
   */
  kernelWarning: string | null
  save: (input: CustomModelSaveInput) => Promise<boolean>
  remove: (ref: CustomModelRef) => Promise<boolean>
}

function errorMessageOf(err: unknown): string {
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

/**
 * Owns the Settings › Models list. Every write goes through the main process,
 * which persists the kernel's own `models.json` and then asks the kernel to
 * recompose — the list returned here is the post-write truth, not a guess.
 */
export function useCustomModels(onChanged?: () => void): UseCustomModelsResult {
  const [models, setModels] = useState<CustomModelEntry[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kernelWarning, setKernelWarning] = useState<string | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    void (async () => {
      try {
        const [list, modelsPath] = await Promise.all([
          codexApi.listCustomModels(),
          codexApi.customModelsPath()
        ])
        if (disposedRef.current) return
        setModels(list)
        setPath(modelsPath)
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

  const save = useCallback(
    async (input: CustomModelSaveInput): Promise<boolean> => {
      setSaving(true)
      setError(null)
      setKernelWarning(null)
      try {
        const result = await codexApi.saveCustomModel(input)
        setModels(result.models)
        if (result.error !== undefined) setKernelWarning(result.error)
        // The composer's picker is a separate list; re-read it either way, since
        // the kernel's answer (not this call) decides what is selectable.
        onChanged?.()
        return true
      } catch (err) {
        setError(errorMessageOf(err))
        return false
      } finally {
        setSaving(false)
      }
    },
    [onChanged]
  )

  const remove = useCallback(
    async (ref: CustomModelRef): Promise<boolean> => {
      setSaving(true)
      setError(null)
      setKernelWarning(null)
      try {
        const result = await codexApi.removeCustomModel(ref)
        setModels(result.models)
        if (result.error !== undefined) setKernelWarning(result.error)
        onChanged?.()
        return true
      } catch (err) {
        setError(errorMessageOf(err))
        return false
      } finally {
        setSaving(false)
      }
    },
    [onChanged]
  )

  return { models, path, loading, saving, error, kernelWarning, save, remove }
}

export default useCustomModels
