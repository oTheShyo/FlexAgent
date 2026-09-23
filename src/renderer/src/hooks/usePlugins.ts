import { useCallback, useEffect, useState } from 'react'
import type {
  CodexApi,
  InstallPluginInput,
  PluginChangeEvent,
  PluginDetail,
  PluginId,
  PluginSummary
} from '../types'
import { codexApi } from '../api'

type PluginApiView = CodexApi & Partial<{
  listPlugins(): Promise<PluginSummary[]>
  getPlugin(id: PluginId): Promise<PluginDetail>
  setPluginEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary>
  installPlugin(input: InstallPluginInput): Promise<PluginSummary>
  uninstallPlugin(id: PluginId): Promise<void>
  subscribePlugins(listener: (event: PluginChangeEvent) => void): () => void
}>

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

const PLUGIN_UNAVAILABLE = 'Plugin management is not available in this build yet.'

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

export function usePlugins(): UsePluginsResult {
  const pluginApi = codexApi as PluginApiView
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    const { listPlugins, subscribePlugins } = pluginApi
    if (listPlugins === undefined || subscribePlugins === undefined) {
      setError(PLUGIN_UNAVAILABLE)
      setLoading(false)
      return
    }
    let disposed = false
    const unsubscribe = subscribePlugins.call(pluginApi, (event) => {
      if (disposed) return
      setPlugins(event.plugins)
      setBusyId(null)
    })
    void (async () => {
      try {
        const list = await listPlugins.call(pluginApi)
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
      unsubscribe()
    }
  }, [pluginApi])

  const installFromDirectory = useCallback(async (): Promise<void> => {
    if (typeof pluginApi.installPlugin !== 'function') {
      setError(PLUGIN_UNAVAILABLE)
      return
    }
    try {
      const dir = await pluginApi.pickDirectory()
      if (dir === null) return
      setError(null)
      await pluginApi.installPlugin({ source: { kind: 'directory', path: dir } })
    } catch (err) {
      setError(errorMessageOf(err))
    }
  }, [pluginApi])

  const toggleEnabled = useCallback(
    async (id: PluginId, enabled: boolean): Promise<void> => {
      if (typeof pluginApi.setPluginEnabled !== 'function') {
        setError(PLUGIN_UNAVAILABLE)
        return
      }
      setBusyId(id)
      setError(null)
      try {
        await pluginApi.setPluginEnabled(id, enabled)
      } catch (err) {
        setError(errorMessageOf(err))
        setBusyId(null)
      }
    },
    [pluginApi]
  )

  const openDetail = useCallback(
    async (id: PluginId): Promise<void> => {
      if (typeof pluginApi.getPlugin !== 'function') {
        setError(PLUGIN_UNAVAILABLE)
        return
      }
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
    },
    [pluginApi]
  )

  const closeDetail = useCallback((): void => {
    setDetail(null)
  }, [])

  const uninstall = useCallback(
    async (id: PluginId): Promise<void> => {
      if (typeof pluginApi.uninstallPlugin !== 'function') {
        setError(PLUGIN_UNAVAILABLE)
        return
      }
      setBusyId(id)
      setError(null)
      try {
        await pluginApi.uninstallPlugin(id)
        setDetail((current) => (current?.id === id ? null : current))
      } catch (err) {
        setError(errorMessageOf(err))
      } finally {
        setBusyId(null)
      }
    },
    [pluginApi]
  )

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
