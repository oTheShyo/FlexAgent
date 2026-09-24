import { useCallback, useEffect, useState } from 'react'
import type {
  MarketplaceInfo,
  MarketplaceInstallSource,
  MarketplaceProgressEvent,
  MarketplaceSearchResult
} from '../types'
import { marketplaceApi } from '../api'

export interface UseMarketplaceResult {
  marketplaces: MarketplaceInfo[]
  results: MarketplaceSearchResult[]
  query: string
  setQuery: (query: string) => void
  loading: boolean
  busy: boolean
  error: string | null
  progress: MarketplaceProgressEvent | null
  activeKey: string | null
  addSource: (source: string) => Promise<boolean>
  install: (source: MarketplaceInstallSource, overwrite?: boolean) => Promise<boolean>
}

export function installKeyOf(source: MarketplaceInstallSource): string {
  if (source.kind === 'entry') return `entry:${source.marketplace}/${source.name}`
  if (source.kind === 'path') return `path:${source.path}`
  return `url:${source.url}`
}

function errorMessageOf(err: unknown): string {
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

export function useMarketplace(): UseMarketplaceResult {
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([])
  const [results, setResults] = useState<MarketplaceSearchResult[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<MarketplaceProgressEvent | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [searchNonce, setSearchNonce] = useState(0)

  useEffect(() => {
    let disposed = false
    const unsubscribe = marketplaceApi.subscribeMarketplaceProgress((event) => {
      if (disposed) return
      setProgress(event)
    })
    void (async () => {
      try {
        const list = await marketplaceApi.listMarketplaces()
        if (!disposed) setMarketplaces(list)
      } catch (err) {
        if (!disposed) setError(errorMessageOf(err))
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const next = await marketplaceApi.searchMarketplaces({ query })
        if (!disposed) setResults(next)
      } catch (err) {
        if (!disposed) setError(errorMessageOf(err))
      }
    })()
    return () => {
      disposed = true
    }
  }, [query, marketplaces, searchNonce])

  const addSource = useCallback(async (source: string): Promise<boolean> => {
    const trimmed = source.trim()
    if (trimmed.length === 0) return false
    setBusy(true)
    setError(null)
    try {
      await marketplaceApi.addMarketplace({ source: trimmed })
      const list = await marketplaceApi.listMarketplaces()
      setMarketplaces(list)
      return true
    } catch (err) {
      setError(errorMessageOf(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const install = useCallback(
    async (source: MarketplaceInstallSource, overwrite?: boolean): Promise<boolean> => {
      setBusy(true)
      setActiveKey(installKeyOf(source))
      setError(null)
      setProgress(null)
      try {
        await marketplaceApi.installFromMarketplace({ source, overwrite })
        setSearchNonce((nonce) => nonce + 1)
        return true
      } catch (err) {
        setError(errorMessageOf(err))
        return false
      } finally {
        setBusy(false)
        setActiveKey(null)
      }
    },
    []
  )

  return {
    marketplaces,
    results,
    query,
    setQuery,
    loading,
    busy,
    error,
    progress,
    activeKey,
    addSource,
    install
  }
}

export default useMarketplace
