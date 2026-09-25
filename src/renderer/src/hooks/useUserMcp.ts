import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  McpServerStatusEntry,
  UserMcpSaveInput,
  UserMcpServerSummary
} from '../types'
import { codexApi } from '../api'

export interface UseUserMcpResult {
  servers: UserMcpServerSummary[]
  status: Map<string, McpServerStatusEntry>
  loading: boolean
  busyName: string | null
  error: string | null
  save: (input: UserMcpSaveInput) => Promise<boolean>
  toggle: (name: string, enabled: boolean) => Promise<void>
  remove: (name: string) => Promise<void>
}

function errorMessageOf(err: unknown): string {
  const message = (err as { message?: string }).message
  return typeof message === 'string' ? message : String(err)
}

export function useUserMcp(): UseUserMcpResult {
  const [servers, setServers] = useState<UserMcpServerSummary[]>([])
  const [status, setStatus] = useState<Map<string, McpServerStatusEntry>>(new Map())
  const [loading, setLoading] = useState(true)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let disposed = false
    unsubRef.current = codexApi.subscribeMcpStatus((event) => {
      if (disposed) return
      setStatus(new Map(event.servers.map((entry) => [entry.key, entry])))
    })
    void (async () => {
      try {
        const [list, statusList] = await Promise.all([
          codexApi.listUserMcpServers(),
          codexApi.listMcpServerStatus()
        ])
        if (disposed) return
        setServers(list)
        setStatus(new Map(statusList.map((entry) => [entry.key, entry])))
      } catch (err) {
        if (!disposed) setError(errorMessageOf(err))
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
      unsubRef.current?.()
      unsubRef.current = null
    }
  }, [])

  const save = useCallback(async (input: UserMcpSaveInput): Promise<boolean> => {
    setBusyName(input.name)
    setError(null)
    try {
      setServers(await codexApi.saveUserMcpServer(input))
      return true
    } catch (err) {
      setError(errorMessageOf(err))
      return false
    } finally {
      setBusyName(null)
    }
  }, [])

  const toggle = useCallback(async (name: string, enabled: boolean): Promise<void> => {
    setBusyName(name)
    setError(null)
    try {
      setServers(await codexApi.toggleUserMcpServer(name, enabled))
    } catch (err) {
      setError(errorMessageOf(err))
    } finally {
      setBusyName(null)
    }
  }, [])

  const remove = useCallback(async (name: string): Promise<void> => {
    setBusyName(name)
    setError(null)
    try {
      setServers(await codexApi.removeUserMcpServer(name))
    } catch (err) {
      setError(errorMessageOf(err))
    } finally {
      setBusyName(null)
    }
  }, [])

  return { servers, status, loading, busyName, error, save, toggle, remove }
}

export default useUserMcp
