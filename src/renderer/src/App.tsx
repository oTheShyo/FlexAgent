import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PermissionDecision, PromptMode, ThinkingLevel } from './types'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import EmptyState from './components/EmptyState'
import Composer from './components/Composer'
import PluginsPage from './components/PluginsPage'
import PluginDetailPanel from './components/PluginDetailPanel'
import { usePlugins } from './hooks/usePlugins'
import ChatView from './components/ChatView'
import DiffPanel from './components/DiffPanel'
import PermissionDialog from './components/PermissionDialog'
import TerminalDrawer from './components/TerminalDrawer'
import CommandPalette from './components/CommandPalette'
import ErrorBoundary from './components/ErrorBoundary'
import ConnectionBanner from './components/ConnectionBanner'
import { ChatSkeleton } from './components/Skeleton'
import { useChat } from './hooks/useChat'
import {
  clearSessionMeta,
  displaySessionTitle,
  pruneSessionMeta,
  useSessionMeta
} from './lib/sessionMeta'
import { useShortcuts } from './lib/shortcuts'

export interface AppProps {
  children?: ReactNode
}

export default function App({ children }: AppProps) {
  const [showTerminal, setShowTerminal] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [paletteOpenSettings, setPaletteOpenSettings] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const sessionMeta = useSessionMeta()
  const {
    plugins,
    loading: pluginsLoading,
    loadingDetail,
    detail,
    error: pluginError,
    busyId,
    installFromDirectory,
    toggleEnabled,
    openDetail,
    closeDetail,
    uninstall
  } = usePlugins()
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
    deleteSession,
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
  } = useChat()

  useEffect(() => {
    if (files.length > 0) setShowReview(true)
  }, [files])

  // The rename/archive overlay is keyed by session id, so an entry whose
  // session is gone (deleted elsewhere, or through the kernel) would silently
  // re-title an unrelated id. Drop those once the list has settled.
  useEffect(() => {
    if (sessionsLoaded !== true) return
    pruneSessionMeta(sessions.map((session) => session.id))
  }, [sessions, sessionsLoaded])

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

  const handleNewChat = useCallback(
    (cwd?: string): void => {
      setShowPlugins(false)
      closeDetail()
      void createSession(cwd)
    },
    [createSession, closeDetail]
  )

  const handleDeleteSession = useCallback(
    (sessionId: string): void => {
      // The overlay is local, so it has to be cleared alongside the real delete.
      clearSessionMeta(sessionId)
      void deleteSession(sessionId)
    },
    [deleteSession]
  )

  const handleChooseProject = useCallback((): void => {
    setShowPlugins(false)
    closeDetail()
    void pickDirectoryOrNewSession()
  }, [pickDirectoryOrNewSession, closeDetail])

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
      setShowPlugins(false)
      closeDetail()
      void openSession(sessionId)
    },
    [openSession, closeDetail]
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
    setPaletteOpenSettings(false)
  }, [])

  const handleOpenSettings = useCallback((): void => {
    setPaletteOpenSettings(true)
    setShowPalette(true)
  }, [])

  const handleOpenPlugins = useCallback((): void => {
    setShowPlugins(true)
  }, [])

  const handleClosePlugins = useCallback((): void => {
    setShowPlugins(false)
  }, [])

  const handleUninstallPlugin = useCallback(
    (id: string): void => {
      void uninstall(id)
    },
    [uninstall]
  )

  const handleTogglePlugin = useCallback(
    (id: string, enabled: boolean): void => {
      void toggleEnabled(id, enabled)
    },
    [toggleEnabled]
  )

  const handleInstallPlugin = useCallback((): void => {
    void installFromDirectory()
  }, [installFromDirectory])

  const handleOpenPluginDetail = useCallback(
    (id: string): void => {
      void openDetail(id)
    },
    [openDetail]
  )

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
        handleClosePalette()
        return
      }
      if (showPlugins && detail !== null) {
        event.preventDefault()
        closeDetail()
        return
      }
      if (showPlugins) {
        event.preventDefault()
        handleClosePlugins()
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
    [showPalette, showPlugins, detail, showTerminal, showReview, closeDetail, handleClosePalette, handleClosePlugins]
  )

  useShortcuts([
    {
      id: 'togglePalette',
      key: 'k',
      ctrlOrMeta: true,
      preventDefault: true,
      allowInEditable: true,
      handler: () => {
        setPaletteOpenSettings(false)
        setShowPalette((value) => !value)
      }
    },
    {
      id: 'togglePaletteAlias',
      key: 'p',
      ctrlOrMeta: true,
      shift: true,
      preventDefault: true,
      allowInEditable: true,
      handler: () => {
        setPaletteOpenSettings(false)
        setShowPalette((value) => !value)
      }
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
      // Wrapped: handleNewChat's first parameter is a cwd, not the event.
      handler: () => handleNewChat()
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
    <div className="flex h-[100dvh] w-full overflow-hidden bg-[var(--surface)] text-[var(--text)] antialiased">
      <ErrorBoundary fallbackClassName="h-full min-h-[240px] w-64 shrink-0">
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewChat={handleNewChat}
          onSelect={handleSelectSession}
          onAddProject={handleChooseProject}
          onDelete={handleDeleteSession}
          loading={sessionsLoaded !== true}
          onOpenPlugins={handleOpenPlugins}
          pluginsActive={showPlugins}
          onOpenSettings={handleOpenSettings}
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
          <ErrorBoundary>
            {showPlugins ? (
              <PluginsPage
                plugins={plugins}
                loading={pluginsLoading}
                error={pluginError}
                busyId={busyId}
                installFromDirectory={handleInstallPlugin}
                toggleEnabled={handleTogglePlugin}
                onOpenDetail={handleOpenPluginDetail}
              />
            ) : (
              content
            )}
          </ErrorBoundary>
        </div>

        <Composer
          onSend={handleSend}
          disabled={!activeSessionId}
          running={isStreaming}
          cwd={activeSession?.cwd}
          onChooseProject={handleChooseProject}
          modelConfig={modelConfig}
          modelOptions={modelOptions}
          slashCommands={slashCommands}
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
        <PluginDetailPanel
          open={showPlugins && (detail !== null || loadingDetail)}
          detail={detail}
          loading={loadingDetail}
          uninstallBusy={busyId !== null && busyId === (detail?.id ?? null)}
          onClose={closeDetail}
          onUninstall={handleUninstallPlugin}
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
            onOpenPlugins={handleOpenPlugins}
            onClose={handleClosePalette}
            openSettings={paletteOpenSettings}
          />
        )}
      </div>
    </div>
  )
}
