import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ContractError,
  type ApplyFileChangesResult,
  type ChatMessage,
  type ContractErrorCode,
  type FileChange,
  type KernelEvent,
  type ModelConfig,
  type ModelOption,
  type PermissionDecision,
  type PromptMode,
  type RunState,
  type SessionSummary,
  type SlashCommandSummary,
  type ThinkingLevel
} from '../types'
import { codexApi } from '../api'

export type PermissionRequest = Extract<KernelEvent, { type: 'permission_request' }>

export type ChatItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'partial'; content: string }
  | {
      kind: 'tool'
      toolCallId: string
      name: string
      label: string
      args: Record<string, unknown>
      chunks: string[]
      status: 'waiting' | 'running' | 'done' | 'error'
      summary?: string
    }
  | { kind: 'error'; code: ContractErrorCode; message: string }

export type ConnectionState = 'ok' | 'degraded'

export interface UseChatResult {
  sessions: SessionSummary[]
  activeSessionId: string | null
  runState: RunState
  isStreaming: boolean
  items: ChatItem[]
  files: FileChange[]
  pendingPermission: PermissionRequest | null
  send: (text: string, mode?: PromptMode) => Promise<void>
  stop: () => Promise<void>
  respond: (decision: PermissionDecision) => Promise<void>
  applyFiles: (files: FileChange[]) => Promise<ApplyFileChangesResult | null>
  createSession: (cwd?: string) => Promise<SessionSummary | null>
  openSession: (sessionId: string) => Promise<void>
  refreshSessions: () => Promise<SessionSummary[]>
  /** Native directory picker → createSession(picked cwd). No-op when cancelled. */
  pickDirectoryOrNewSession: () => Promise<void>
  modelConfig: ModelConfig | null
  modelOptions: ModelOption[]
  /** Slash commands from enabled plugins; empty when the bridge lacks the channel. */
  slashCommands: SlashCommandSummary[]
  setModel: (provider: string, id: string) => Promise<ModelConfig | null>
  setThinkingLevel: (level: ThinkingLevel) => Promise<ModelConfig | null>
  connectionState?: ConnectionState
  connectionMessage?: string
  /** True once the initial listSessions has settled (success or failure). */
  sessionsLoaded?: boolean
  /** True while openSession is in flight (including reconcile re-opens). */
  historyLoading?: boolean
}

const RECONNECTED_CLEAR_MS = 2000

let partialCounter = 0

function errorItemFrom(err: unknown): ChatItem {
  if (err instanceof ContractError) {
    return { kind: 'error', code: err.code, message: err.message }
  }
  return {
    kind: 'error',
    code: 'KERNEL_INTERNAL',
    message: err instanceof Error ? err.message : String(err)
  }
}

function finalizePartials(prev: ChatItem[]): ChatItem[] {
  let next: ChatItem[] | null = null
  for (let index = 0; index < prev.length; index += 1) {
    const item = prev[index]
    if (item.kind !== 'partial') continue
    if (next === null) next = [...prev]
    partialCounter += 1
    next[index] = {
      kind: 'message',
      message: {
        id: `msg_partial_${partialCounter}`,
        role: 'assistant',
        content: item.content,
        createdAt: Date.now()
      }
    }
  }
  return next ?? prev
}

function preserveChunks(prev: ChatItem[], toolCallId: string): string[] {
  const existing = prev.find((item) => item.kind === 'tool' && item.toolCallId === toolCallId)
  return existing?.kind === 'tool' ? existing.chunks : []
}

function closeOpenTools(prev: ChatItem[]): ChatItem[] {
  let next: ChatItem[] | null = null
  for (let index = 0; index < prev.length; index += 1) {
    const item = prev[index]
    if (item.kind !== 'tool' || item.status === 'done' || item.status === 'error') continue
    if (next === null) next = [...prev]
    next[index] = {
      ...item,
      status: 'error',
      summary: item.summary ?? 'Interrupted before completion'
    }
  }
  return next ?? prev
}

function upsertTool(
  prev: ChatItem[],
  draft: Extract<ChatItem, { kind: 'tool' }>
): ChatItem[] {
  const index = prev.findIndex(
    (item) => item.kind === 'tool' && item.toolCallId === draft.toolCallId
  )
  if (index === -1) return [...prev, draft]
  const next = [...prev]
  const existing = prev[index]
  if (existing.kind === 'tool') {
    next[index] = { ...existing, ...draft, chunks: draft.chunks.length > 0 ? draft.chunks : existing.chunks }
  }
  return next
}

export function useChat(): UseChatResult {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [runState, setRunState] = useState<RunState>('idle')
  const [items, setItems] = useState<ChatItem[]>([])
  const [files, setFiles] = useState<FileChange[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('ok')
  const [connectionMessage, setConnectionMessage] = useState<string | undefined>(undefined)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [slashCommands, setSlashCommands] = useState<SlashCommandSummary[]>([])

  const unsubRef = useRef<(() => void) | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const lastSeqRef = useRef<number | null>(null)
  const reconcilingRef = useRef(false)
  const connectionStateRef = useRef<ConnectionState>('ok')
  const reconnectTimerRef = useRef<number | null>(null)
  const reconcileRef = useRef<(() => void) | null>(null)

  const clearReconnectTimer = useCallback((): void => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const applyDegraded = useCallback((): void => {
    clearReconnectTimer()
    connectionStateRef.current = 'degraded'
    setConnectionState('degraded')
    setConnectionMessage('Connection lost — reconciling…')
  }, [clearReconnectTimer])

  const applyReconnected = useCallback((): void => {
    if (connectionStateRef.current !== 'degraded') return
    setConnectionMessage('Reconnected')
    clearReconnectTimer()
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      connectionStateRef.current = 'ok'
      setConnectionState('ok')
      setConnectionMessage(undefined)
    }, RECONNECTED_CLEAR_MS)
  }, [clearReconnectTimer])

  const handleEvent = useCallback((event: KernelEvent): void => {
    if (event.sessionId !== activeIdRef.current) return

    const prevSeq = lastSeqRef.current
    if (prevSeq !== null && event.seq !== prevSeq + 1) {
      lastSeqRef.current = event.seq
      const shouldAutoReconcile =
        connectionStateRef.current === 'ok' && !reconcilingRef.current
      applyDegraded()
      if (shouldAutoReconcile) reconcileRef.current?.()
    } else {
      lastSeqRef.current = event.seq
    }

    switch (event.type) {
      case 'run_state': {
        const nextRunState = event.runState
        setRunState(nextRunState)
        setSessions((prev) =>
          prev.map((session) =>
            session.id === event.sessionId ? { ...session, runState: nextRunState } : session
          )
        )
        setItems((prev) => closeOpenTools(finalizePartials(prev)))
        if (nextRunState === 'idle') setPendingPermission(null)
        break
      }
      case 'user_message': {
        const message = event.message
        setItems((prev) => [...prev, { kind: 'message', message }])
        break
      }
      case 'text_delta': {
        const delta = event.delta
        setItems((prev) => {
          for (let index = prev.length - 1; index >= 0; index -= 1) {
            const item = prev[index]
            if (item.kind === 'partial') {
              const next = [...prev]
              next[index] = { kind: 'partial', content: item.content + delta }
              return next
            }
          }
          return [...prev, { kind: 'partial', content: delta }]
        })
        break
      }
      case 'message_end': {
        const message = event.message
        setItems((prev) => {
          const finalized: ChatItem = { kind: 'message', message }
          for (let index = prev.length - 1; index >= 0; index -= 1) {
            if (prev[index].kind === 'partial') {
              const next = [...prev]
              next[index] = finalized
              return next
            }
          }
          const existingIndex = prev.findIndex(
            (item) => item.kind === 'message' && item.message.id === message.id
          )
          if (existingIndex >= 0) {
            const next = [...prev]
            next[existingIndex] = finalized
            return next
          }
          return [...prev, finalized]
        })
        break
      }
      case 'tool_start': {
        const { toolCallId, name, label, args } = event
        setItems((prev) =>
          upsertTool(prev, {
            kind: 'tool',
            toolCallId,
            name,
            label,
            args,
            chunks: preserveChunks(prev, toolCallId),
            status: 'running'
          })
        )
        break
      }
      case 'tool_update': {
        const { toolCallId, chunk } = event
        setItems((prev) => {
          const index = prev.findIndex(
            (item) => item.kind === 'tool' && item.toolCallId === toolCallId
          )
          if (index === -1) {
            return [
              ...prev,
              {
                kind: 'tool',
                toolCallId,
                name: 'tool',
                label: 'Tool',
                args: {},
                chunks: [chunk],
                status: 'running'
              } satisfies ChatItem
            ]
          }
          const next = [...prev]
          const existing = prev[index]
          if (existing.kind === 'tool') {
            next[index] = { ...existing, chunks: [...existing.chunks, chunk] }
          }
          return next
        })
        break
      }
      case 'tool_end': {
        const { toolCallId, isError, summary } = event
        setItems((prev) => {
          const index = prev.findIndex(
            (item) => item.kind === 'tool' && item.toolCallId === toolCallId
          )
          const status = isError ? 'error' : 'done'
          if (index === -1) {
            return [
              ...prev,
              {
                kind: 'tool',
                toolCallId,
                name: 'tool',
                label: 'Tool',
                args: {},
                chunks: [],
                status,
                summary
              } satisfies ChatItem
            ]
          }
          const next = [...prev]
          const existing = prev[index]
          if (existing.kind === 'tool') {
            next[index] = { ...existing, status, summary }
          }
          return next
        })
        break
      }
      case 'permission_request': {
        const request = event
        setPendingPermission(request)
        setItems((prev) =>
          upsertTool(prev, {
            kind: 'tool',
            toolCallId: request.toolCallId,
            name: request.name,
            label: request.label,
            args: request.args,
            chunks: preserveChunks(prev, request.toolCallId),
            status: 'waiting'
          })
        )
        break
      }
      case 'file_changes': {
        setFiles(event.files)
        break
      }
      case 'error': {
        const { code, message } = event
        setItems((prev) => [...prev, { kind: 'error', code, message }])
        // Only a kernel-level failure leaves the transport suspect. Ordinary
        // contract errors (SESSION_BUSY, INVALID_INPUT, …) are per-call outcomes
        // and must not raise the "connection lost" banner.
        if (code === 'KERNEL_INTERNAL') {
          const shouldReconcileError =
            connectionStateRef.current === 'ok' && !reconcilingRef.current
          applyDegraded()
          if (shouldReconcileError) reconcileRef.current?.()
        }
        break
      }
      case 'pty_output':
      case 'pty_exit':
        // pty_* events are owned by TerminalDrawer's own subscription.
        break
    }
  }, [applyDegraded])

  const openSession = useCallback(
    async (sessionId: string): Promise<void> => {
      setHistoryLoading(true)
      try {
        const detail = await codexApi.openSession(sessionId)
        unsubRef.current?.()
        unsubRef.current = null
        activeIdRef.current = sessionId
        lastSeqRef.current = null
        setActiveSessionId(sessionId)
        const loaded: ChatItem[] = detail.messages.map((message) => ({ kind: 'message', message }))
        setItems(loaded)
        setFiles([])
        setPendingPermission(null)
        setRunState(detail.summary.runState)
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? detail.summary : s)))
        unsubRef.current = codexApi.subscribe(sessionId, handleEvent)
        applyReconnected()
      } catch (err) {
        setItems((prev) => [...prev, errorItemFrom(err)])
        applyDegraded()
      } finally {
        setHistoryLoading(false)
      }
    },
    [handleEvent, applyReconnected, applyDegraded]
  )

  useEffect(() => {
    reconcileRef.current = (): void => {
      if (reconcilingRef.current) return
      const id = activeIdRef.current
      if (id === null) return
      reconcilingRef.current = true
      void openSession(id).finally(() => {
        reconcilingRef.current = false
      })
    }
  }, [openSession])

  const refreshSessions = useCallback(async (): Promise<SessionSummary[]> => {
    try {
      const list = await codexApi.listSessions()
      setSessions(list)
      setSessionsLoaded(true)
      return list
    } catch (err) {
      setSessionsLoaded(true)
      setItems((prev) => [...prev, errorItemFrom(err)])
      applyDegraded()
      return []
    }
  }, [applyDegraded])

  const createSession = useCallback(
    async (cwd?: string): Promise<SessionSummary | null> => {
      try {
        const target = cwd ?? (await codexApi.pickDirectory())
        if (target === null) return null
        const summary = await codexApi.createSession({ cwd: target })
        setSessions((prev) => [summary, ...prev])
        await openSession(summary.id)
        return summary
      } catch (err) {
        setItems((prev) => [...prev, errorItemFrom(err)])
        return null
      }
    },
    [openSession]
  )

  const pickDirectoryOrNewSession = useCallback(async (): Promise<void> => {
    try {
      const dir = await codexApi.pickDirectory()
      if (dir === null) return
      await createSession(dir)
    } catch (err) {
      setItems((prev) => [...prev, errorItemFrom(err)])
    }
  }, [createSession])

  const setModel = useCallback(
    async (provider: string, id: string): Promise<ModelConfig | null> => {
      const sessionId = activeIdRef.current
      if (sessionId === null) return null
      try {
        const config = await codexApi.setModel({ sessionId, provider, id })
        setModelConfig(config)
        return config
      } catch (err) {
        setItems((prev) => [...prev, errorItemFrom(err)])
        return null
      }
    },
    []
  )

  const setThinkingLevel = useCallback(
    async (level: ThinkingLevel): Promise<ModelConfig | null> => {
      const sessionId = activeIdRef.current
      if (sessionId === null) return null
      try {
        const config = await codexApi.setThinkingLevel({ sessionId, level })
        setModelConfig(config)
        return config
      } catch (err) {
        setItems((prev) => [...prev, errorItemFrom(err)])
        return null
      }
    },
    []
  )

  useEffect(() => {
    if (activeSessionId === null) {
      setModelConfig(null)
      return
    }
    let disposed = false
    void codexApi
      .getModelConfig(activeSessionId)
      .then((config) => {
        if (!disposed) setModelConfig(config)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [activeSessionId])

  useEffect(() => {
    let disposed = false
    void codexApi
      .listModels()
      .then((options) => {
        if (!disposed) setModelOptions(options)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      const pending = codexApi.listSlashCommands?.()
      if (pending === undefined) return
      void pending
        .then((commands) => {
          if (!disposed) setSlashCommands(commands)
        })
        .catch(() => {})
    }
    refresh()
    // Commands come from enabled plugins, so plugin changes invalidate the list.
    const unsubscribe = codexApi.subscribePlugins(refresh)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const send = useCallback(async (text: string, mode?: PromptMode): Promise<void> => {
    const sessionId = activeIdRef.current
    const trimmed = text.trim()
    if (!sessionId || trimmed.length === 0) return
    try {
      await codexApi.prompt({ sessionId, text: trimmed, mode })
    } catch (err) {
      setItems((prev) => [...prev, errorItemFrom(err)])
    }
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    const sessionId = activeIdRef.current
    if (!sessionId) return
    setPendingPermission(null)
    try {
      await codexApi.abort(sessionId)
    } catch (err) {
      setItems((prev) => [...prev, errorItemFrom(err)])
    }
  }, [])

  const respond = useCallback(
    async (decision: PermissionDecision): Promise<void> => {
      const sessionId = activeSessionId
      if (!sessionId || !pendingPermission) return
      const toolCallId = pendingPermission.toolCallId
      setPendingPermission(null)
      try {
        await codexApi.respondPermission({ sessionId, toolCallId, decision })
      } catch (err) {
        setItems((prev) => [...prev, errorItemFrom(err)])
      }
    },
    [activeSessionId, pendingPermission]
  )

  const applyFiles = useCallback(
    async (fileChanges: FileChange[]): Promise<ApplyFileChangesResult | null> => {
      const sessionId = activeIdRef.current
      if (!sessionId || fileChanges.length === 0) return null
      try {
        return await codexApi.applyFileChanges({ sessionId, files: fileChanges })
      } catch (err) {
        setItems((prev) => [...prev, errorItemFrom(err)])
        throw err
      }
    },
    []
  )

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const list = await codexApi.listSessions()
        if (disposed) return
        setSessions(list)
        setSessionsLoaded(true)
        if (list.length > 0) await openSession(list[0].id)
      } catch (err) {
        if (disposed) return
        setSessionsLoaded(true)
        setItems((prev) => [...prev, errorItemFrom(err)])
        applyDegraded()
      }
    })()
    return () => {
      disposed = true
      unsubRef.current?.()
      unsubRef.current = null
      activeIdRef.current = null
      lastSeqRef.current = null
      clearReconnectTimer()
    }
  }, [openSession, applyDegraded, clearReconnectTimer])

  return {
    sessions,
    activeSessionId,
    runState,
    isStreaming: runState === 'running',
    items,
    files,
    pendingPermission,
    send,
    stop,
    respond,
    applyFiles,
    createSession,
    openSession,
    refreshSessions,
    pickDirectoryOrNewSession,
    modelConfig,
    modelOptions,
    slashCommands,
    setModel,
    setThinkingLevel,
    connectionState,
    connectionMessage,
    sessionsLoaded,
    historyLoading
  }
}

export default useChat
