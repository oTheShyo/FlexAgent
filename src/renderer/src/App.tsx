import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PermissionDecision, PromptMode, ThinkingLevel } from './types'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import EmptyState from './components/EmptyState'
import Composer from './components/Composer'
import ChatView from './components/ChatView'
import DiffPanel from './components/DiffPanel'
import PermissionDialog from './components/PermissionDialog'
import TerminalDrawer from './components/TerminalDrawer'
import CommandPalette from './components/CommandPalette'
import ErrorBoundary from './components/ErrorBoundary'
import ConnectionBanner from './components/ConnectionBanner'
import { ChatSkeleton } from './components/Skeleton'
import { useChat } from './hooks/useChat'
import { displaySessionTitle, useSessionMeta } from './lib/sessionMeta'
import { useShortcuts } from './lib/shortcuts'

export interface AppProps {
  children?: ReactNode
}

export default function App({ children }: AppProps) {
  const [showTerminal, setShowTerminal] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const sessionMeta = useSessionMeta()
  const {
    sessions,
    activeSessionId,
    runState,
    isStreaming,
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
    setModel,
    setThinkingLevel,
    connectionState,
    connectionMessage,
    sessionsLoaded,
    historyLoading
  } = useChat()

  useEffect(() => {
    if (files.length > 0) setShowReview(true)
  }, [files])

  const handleSend = useCallback(
    (text: string, mode?: PromptMode): void => {
      void send(text, mode)
    },
    [send]
  )

  const handleRegenerate = useCallback((): void => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.kind === 'message' && item.message.role === 'user') {
        const text = item.message.content
        if (text.trim().length > 0) handleSend(text)
        return
      }
    }
  }, [items, handleSend])

  const canRegenerate =
    runState === 'idle' &&
    items.some(
      (item) =>
        item.kind === 'message' &&
        item.message.role === 'user' &&
        item.message.content.trim().length > 0
    ) &&
    items.some((item) => item.kind === 'message' && item.message.role === 'assistant')

  const onRegenerate = canRegenerate ? handleRegenerate : undefined

  const handleNewChat = useCallback((): void => {
    void createSession()
  }, [createSession])

  const handleChooseProject = useCallback((): void => {
    void pickDirectoryOrNewSession()
  }, [pickDirectoryOrNewSession])

  const handleSetModel = useCallback(
    (provider: string, id: string): void => {
      void setModel(provider, id)
    },
    [setModel]
  )

  const handleSetThinkingLevel = useCallback(
    (level: ThinkingLevel): void => {
      void setThinkingLevel(level)
    },
    [setThinkingLevel]
  )

  const handleSelectSession = useCallback(
    (sessionId: string): void => {
      void openSession(sessionId)
    },
    [openSession]
  )

  const handleRetryConnection = useCallback((): void => {
    const id = activeSessionId
    if (id !== null) {
      void openSession(id)
      return
    }
    void (async () => {
      const list = await refreshSessions()
      if (list.length > 0) await openSession(list[0].id)
    })()
  }, [activeSessionId, openSession, refreshSessions])

  const handleClosePalette = useCallback((): void => {
    setShowPalette(false)
  }, [])

  const handleToggleTerminal = useCallback((): void => {
    setShowTerminal((value) => !value)
  }, [])

  const handleToggleReview = useCallback((): void => {
    setShowReview((value) => !value)
  }, [])

  const handleStop = useCallback((): void => {
    void stop()
  }, [stop])

  const handleCloseReview = useCallback((): void => {
    setShowReview(false)
  }, [])

  const handleRejectReview = useCallback((): void => {
    setShowReview(false)
  }, [])

  const acceptDisabled = activeSessionId === null || runState === 'running'
  const acceptTitle =
    activeSessionId === null
      ? 'Open a session to accept changes'
      : runState === 'running'
        ? 'Wait for the run to finish'
        : undefined

  const handleCloseTerminal = useCallback((): void => {
    setShowTerminal(false)
  }, [])

  const handleRespond = useCallback(
    (decision: PermissionDecision): void => {
      void respond(decision)
    },
    [respond]
  )

  const handleEscape = useCallback(
    (event: KeyboardEvent): void => {
      if (showPalette) {
        event.preventDefault()
        setShowPalette(false)
        return
      }
      if (showTerminal) {
        event.preventDefault()
        setShowTerminal(false)
        return
      }
      if (showReview) {
        event.preventDefault()
        setShowReview(false)
      }
    },
    [showPalette, showTerminal, showReview]
  )

  useShortcuts([
    {
      id: 'togglePalette',
      key: 'k',
      ctrlOrMeta: true,
      preventDefault: true,
      allowInEditable: true,
      handler: () => setShowPalette((value) => !value)
    },
    {
      id: 'togglePaletteAlias',
      key: 'p',
      ctrlOrMeta: true,
      shift: true,
      preventDefault: true,
      allowInEditable: true,
      handler: () => setShowPalette((value) => !value)
    },
    {
      id: 'toggleTerminal',
      key: 't',
      ctrlOrMeta: true,
      preventDefault: true,
      allowInEditable: true,
      handler: handleToggleTerminal
    },
    {
      id: 'newChat',
      key: 'o',
      ctrlOrMeta: true,
      shift: true,
      preventDefault: true,
      allowInEditable: true,
      handler: handleNewChat
    },
    {
      id: 'closeTop',
      key: 'Escape',
      ctrlOrMeta: false,
      allowInEditable: true,
      handler: handleEscape
    }
  ])

  const activeSession = sessions.find((session) => session.id === activeSessionId)

  const content =
    children ??
    (items.length > 0 ? (
      <ChatView items={items} running={isStreaming} onRegenerate={onRegenerate} />
    ) : historyLoading === true ? (
      <ChatSkeleton />
    ) : (
      <EmptyState />
    ))

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[var(--surface)] text-[var(--text)] antialiased">
      <ErrorBoundary fallbackClassName="h-full min-h-[240px] w-64 shrink-0">
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewChat={handleNewChat}
          onSelect={handleSelectSession}
          loading={sessionsLoaded !== true}
        />
      </ErrorBoundary>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={activeSession ? displaySessionTitle(activeSession, sessionMeta) : 'New chat'}
          terminalActive={showTerminal}
          reviewActive={showReview}
          running={isStreaming}
          onToggleTerminal={handleToggleTerminal}
          onToggleReview={handleToggleReview}
          onStop={handleStop}
        />

        {connectionState === 'degraded' && connectionMessage !== undefined && (
          <ConnectionBanner message={connectionMessage} onRetry={handleRetryConnection} />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary>{content}</ErrorBoundary>
        </div>

        <Composer
          onSend={handleSend}
          disabled={!activeSessionId}
          running={isStreaming}
          cwd={activeSession?.cwd}
          onChooseProject={handleChooseProject}
          modelConfig={modelConfig}
          modelOptions={modelOptions}
          onSetModel={handleSetModel}
          onSetThinkingLevel={handleSetThinkingLevel}
        />

        <DiffPanel
          open={showReview}
          files={files}
          acceptDisabled={acceptDisabled}
          acceptTitle={acceptTitle}
          onAccept={applyFiles}
          onReject={handleRejectReview}
          onClose={handleCloseReview}
        />
        <TerminalDrawer
          open={showTerminal}
          onClose={handleCloseTerminal}
          sessionId={activeSessionId}
        />
        {pendingPermission && (
          <PermissionDialog
            request={pendingPermission}
            onRespond={handleRespond}
          />
        )}
        {showPalette && (
          <CommandPalette
            sessions={sessions}
            activeSessionId={activeSessionId}
            onNewChat={handleNewChat}
            onOpenSession={handleSelectSession}
            onToggleTerminal={handleToggleTerminal}
            onClose={handleClosePalette}
          />
        )}
      </div>
    </div>
  )
}
