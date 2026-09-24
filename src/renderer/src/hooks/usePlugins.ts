import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CodexApi,
  InstallPluginInput,
  PluginChangeEvent,
  PluginDetail,
  PluginId,
  PluginSummary
} from '../types'
import { codexApi } from '../api'

type PluginApi = CodexApi & {
  listPlugins(): Promise<PluginSummary[]>
  getPlugin(id: PluginId): Promise<PluginDetail>
  setPluginEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary>
  installPlugin(input: InstallPluginInput): Promise<PluginSummary>
  uninstallPlugin(id: PluginId): Promise<void>
  subscribePlugins(listener: (event: PluginChangeEvent) => void): () => void
}

const pluginApi = codexApi as PluginApi

const BUSY_FALLBACK_MS = 5000

export interface UsePluginsResult {
  plugins: PluginSummary[]
  loading: boolean
  loadingDetail: boolean
  detail: PluginDetail | null
  error: string | null
  busyId: string | null
  installFromDirectory: () => Promise<void>
  toggleEnabled: (id: PluginId, enabled: boolean) => Promise<void>
  openDetail: (id: PluginId) => Promise<void>
  closeDetail: () => void
  uninstall: (id: PluginId) => Promise<void>
}

function errorMessageOf(err: unknown): string {
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

export function usePlugins(): UsePluginsResult {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const unsubRef = useRef<(() => void) | null>(null)
  const busyTimerRef = useRef<number | null>(null)

  const clearBusy = useCallback((): void => {
    setBusyId(null)
    if (busyTimerRef.current !== null) {
      window.clearTimeout(busyTimerRef.current)
      busyTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    let disposed = false
    unsubRef.current = pluginApi.subscribePlugins((event: PluginChangeEvent) => {
      if (disposed) return
      setPlugins(event.plugins)
      clearBusy()
    })
    void (async () => {
      try {
        const list = await pluginApi.listPlugins()
        if (disposed) return
        setPlugins(list)
      } catch (err) {
        if (disposed) return
        setError(errorMessageOf(err))
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
      unsubRef.current?.()
      unsubRef.current = null
      if (busyTimerRef.current !== null) {
        window.clearTimeout(busyTimerRef.current)
        busyTimerRef.current = null
      }
    }
  }, [clearBusy])

  const installFromDirectory = useCallback(async (): Promise<void> => {
    try {
      const dir = await pluginApi.pickDirectory()
      if (dir === null) return
      setError(null)
      await pluginApi.installPlugin({ source: { kind: 'directory', path: dir } })
    } catch (err) {
      setError(errorMessageOf(err))
    }
  }, [])

  const toggleEnabled = useCallback(
    async (id: PluginId, enabled: boolean): Promise<void> => {
      setBusyId(id)
      setError(null)
      if (busyTimerRef.current !== null) window.clearTimeout(busyTimerRef.current)
      busyTimerRef.current = window.setTimeout(() => {
        busyTimerRef.current = null
        setBusyId((current) => (current === id ? null : current))
      }, BUSY_FALLBACK_MS)
      try {
        await pluginApi.setPluginEnabled(id, enabled)
      } catch (err) {
        setError(errorMessageOf(err))
        clearBusy()
      }
    },
    [clearBusy]
  )

  const openDetail = useCallback(async (id: PluginId): Promise<void> => {
    setLoadingDetail(true)
    setError(null)
    try {
      const next = await pluginApi.getPlugin(id)
      setDetail(next)
    } catch (err) {
      setError(errorMessageOf(err))
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  const closeDetail = useCallback((): void => {
    setDetail(null)
  }, [])

  const uninstall = useCallback(async (id: PluginId): Promise<void> => {
    setError(null)
    try {
      await pluginApi.uninstallPlugin(id)
      setDetail((current) => (current !== null && current.id === id ? null : current))
    } catch (err) {
      setError(errorMessageOf(err))
    }
  }, [])

  return {
    plugins,
    loading,
    loadingDetail,
    detail,
    error,
    busyId,
    installFromDirectory,
    toggleEnabled,
    openDetail,
    closeDetail,
    uninstall
  }
}

export default usePlugins
