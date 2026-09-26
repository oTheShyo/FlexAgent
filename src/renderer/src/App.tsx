import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  PermissionDecision,
  PromptMode,
  PromptReference,
  ThinkingLevel
} from './types'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import TopBar from './components/TopBar'
import EmptyState from './components/EmptyState'
import Composer from './components/Composer'
import MemoryPage from './components/MemoryPage'
import PluginsPage from './components/PluginsPage'
import PluginDetailPanel from './components/PluginDetailPanel'
import SkillsPage from './components/SkillsPage'
import { usePlugins } from './hooks/usePlugins'
import ChatView from './components/ChatView'
import DiffPanel from './components/DiffPanel'
import PermissionDialog from './components/PermissionDialog'
import QuestionPanel from './components/QuestionPanel'
import CommandPalette from './components/CommandPalette'
import ErrorBoundary from './components/ErrorBoundary'
import ConnectionBanner from './components/ConnectionBanner'
import { ChatSkeleton } from './components/Skeleton'
import { useChat } from './hooks/useChat'
import { usePermissionMode } from './hooks/usePermissionMode'
import { useShortcuts } from './lib/shortcuts'
import { pathKey } from './lib/paths'
import type { SelectionSource } from './hooks/useChatSelection'
import type { ContextReference } from './components/composerReferences'

// Deferred so xterm (~345 kB source) and the settings tree load only when
// their surface is first opened, keeping them out of the entry chunk.
const TerminalDrawer = lazy(() => import('./components/TerminalDrawer'))
const SettingsPage = lazy(() => import('./components/SettingsPage'))

// Stable "nothing is waiting" identity: a fresh [] on every render would give
// the memoized Composer a new prop and re-render it for no reason.
const EMPTY_QUEUE: readonly string[] = []

export interface AppProps {
  children?: ReactNode
}

export default function App({ children }: AppProps) {
  const [showTerminal, setShowTerminal] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('codex.sidebar.v1') !== '0'
  )
  useEffect(() => {
    localStorage.setItem('codex.sidebar.v1', sidebarOpen ? '1' : '0')
  }, [sidebarOpen])
  const toggleSidebar = useCallback((): void => {
    setSidebarOpen((value) => !value)
  }, [])
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
    modelRetry,
    pendingQuestion,
    goal,
    goalMessage,
    respondQuestion,
    stopQuestionTimer,
    send,
    listWorkspaceFiles,
    readSessionContext,
    stop,
    respond,
    applyFiles,
    openSession,
    refreshSessions,
    deleteSession,
    renameSession,
    setSessionArchived,
    forkSession,
    newChat,
    chooseProject,
    bindingProject,
    newChatInFolder,
    scratchCwd,
    modelConfig,
    modelOptions,
    slashCommands,
    setModel,
    setThinkingLevel,
    refreshModels,
    connectionState,
    connectionMessage,
    sessionsLoaded,
    historyLoading
  } = useChat()

  // ←/→ walk recent session switches (browser-style history). The stack starts
  // empty, so both arrows stay disabled until the user switches sessions once;
  // that first transition seeds the stack with the session it left behind.
  const [history, setHistory] = useState<{ ids: string[]; index: number }>({
    ids: [],
    index: -1
  })
  const historyNavRef = useRef(false)
  const lastSessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    const sessionId = activeSessionId
    const previous = lastSessionIdRef.current
    lastSessionIdRef.current = sessionId
    if (historyNavRef.current) {
      historyNavRef.current = false
      return
    }
    if (sessionId === null || sessionId === previous) return
    setHistory((state) => {
      if (state.ids[state.index] === sessionId) return state
      const base =
        state.ids.length > 0
          ? state.ids.slice(0, state.index + 1)
          : previous === null
            ? []
            : [previous]
      const ids = [...base, sessionId]
      return { ids, index: ids.length - 1 }
    })
  }, [activeSessionId])

  // file_changes lands before run_state goes idle, so the auto-open is armed
  // mid-run and spent when the run settles; a manual close disarms it.
  const reviewAutoOpenRef = useRef(false)
  const runWasStreamingRef = useRef(isStreaming)

  useEffect(() => {
    const wasStreaming = runWasStreamingRef.current
    runWasStreamingRef.current = isStreaming
    if (files.length === 0) {
      reviewAutoOpenRef.current = false
      return
    }
    if (isStreaming) {
      reviewAutoOpenRef.current = true
      return
    }
    if (wasStreaming) {
      if (!reviewAutoOpenRef.current) return
      reviewAutoOpenRef.current = false
    }
    setShowReview(true)
  }, [files, isStreaming])

  // A message sent while the active run is streaming waits here instead of
  // steering into the turn. Keyed by session so switching chats never mixes
  // two backlogs; in-memory only, so nothing survives an app restart.
  const [queuedBySession, setQueuedBySession] = useState<Record<string, string[]>>({})

  const handleSend = useCallback(
    (text: string, mode?: PromptMode, references?: PromptReference[]): void => {
      const sessionId = activeSessionId
      // An explicit mode is a caller that already chose steer vs followUp, so
      // only the plain send path is eligible to wait for the run to finish.
      if (mode === undefined && isStreaming && sessionId !== null) {
        setQueuedBySession((prev) => ({
          ...prev,
          [sessionId]: [...(prev[sessionId] ?? []), text]
        }))
        return
      }
      void send(text, mode, references)
    },
    [send, activeSessionId, isStreaming]
  )

  // Edge-triggered drain: exactly one message per running -> idle transition,
  // or per switch onto an idle session that still has a backlog. The snapshot
  // is written before any early return, so a StrictMode double run of the same
  // edge sees prev === current and cannot flush the same message twice.
  const flushEdgeRef = useRef({ runState, activeSessionId })

  useEffect(() => {
    const previous = flushEdgeRef.current
    flushEdgeRef.current = { runState, activeSessionId }
    if (runState !== 'idle' || activeSessionId === null) return
    const runFinished = previous.runState === 'running'
    const switchedSession = previous.activeSessionId !== activeSessionId
    if (!runFinished && !switchedSession) return
    const queue = queuedBySession[activeSessionId]
    if (queue === undefined || queue.length === 0) return
    const first = queue[0]
    setQueuedBySession((prev) => {
      const list = prev[activeSessionId]
      if (list === undefined || list.length === 0) return prev
      const remaining = list.slice(1)
      const next = { ...prev }
      if (remaining.length === 0) delete next[activeSessionId]
      else next[activeSessionId] = remaining
      return next
    })
    void send(first)
  }, [runState, activeSessionId, queuedBySession, send])

  // References staged for the current draft. They live here because the
  // transcript and the Composer are siblings, but the Composer decides how a
  // pick is staged (limits, the refusal notice) — the two entry points share
  // one list, so one of them cannot have a different idea of the ceiling.
  const [references, setReferences] = useState<readonly ContextReference[]>([])
  const [selectionPick, setSelectionPick] = useState<{
    text: string
    source: SelectionSource
    token: number
  } | null>(null)
  const selectionPickSeqRef = useRef(0)

  const handleAddReference = useCallback(
    (payload: { text: string; source: SelectionSource }): void => {
      selectionPickSeqRef.current += 1
      setSelectionPick({ ...payload, token: selectionPickSeqRef.current })
    },
    []
  )

  const handleSelectionPickConsumed = useCallback((): void => {
    setSelectionPick(null)
  }, [])

  // Switching chats invalidates the references: a quote from a transcript that
  // is no longer on screen has no business sitting in the next chat's draft.
  useEffect(() => {
    setReferences([])
    setSelectionPick(null)
  }, [activeSessionId])

  const handleQueueRemove = useCallback((sessionId: string, index: number): void => {
    setQueuedBySession((prev) => {
      const list = prev[sessionId]
      if (list === undefined || index < 0 || index >= list.length) return prev
      const remaining = list.filter((_, position) => position !== index)
      const next = { ...prev }
      if (remaining.length === 0) delete next[sessionId]
      else next[sessionId] = remaining
      return next
    })
  }, [])

  // "Send now" skips the wait: the entry leaves the queue and is steered into
  // the in-flight run. When the kernel is already idle the contract ignores the
  // mode, so the same call simply starts a normal run.
  const handleQueueSendNow = useCallback(
    (sessionId: string, index: number): void => {
      const list = queuedBySession[sessionId]
      if (list === undefined || index < 0 || index >= list.length) return
      const text = list[index]
      handleQueueRemove(sessionId, index)
      void send(text, 'steer')
    },
    [queuedBySession, handleQueueRemove, send]
  )

  const handleComposerQueueRemove = useCallback(
    (index: number): void => {
      if (activeSessionId !== null) handleQueueRemove(activeSessionId, index)
    },
    [activeSessionId, handleQueueRemove]
  )

  const handleComposerQueueSendNow = useCallback(
    (index: number): void => {
      if (activeSessionId !== null) handleQueueSendNow(activeSessionId, index)
    },
    [activeSessionId, handleQueueSendNow]
  )

  const queuedMessages = useMemo(
    () =>
      activeSessionId === null
        ? EMPTY_QUEUE
        : (queuedBySession[activeSessionId] ?? EMPTY_QUEUE),
    [activeSessionId, queuedBySession]
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

  // A run can fail before any assistant message exists (first-turn failures);
  // retry must not be gated on an assistant message in that case.
  const canRetryError =
    runState === 'idle' &&
    items.some(
      (item) =>
        item.kind === 'message' &&
        item.message.role === 'user' &&
        item.message.content.trim().length > 0
    )

  const onErrorRetry = canRetryError ? handleRegenerate : undefined

  const handleNewChat = useCallback(
    (cwd?: string): void => {
      setShowPlugins(false)
      setShowSkills(false)
      setShowMemory(false)
      closeDetail()
      void newChat(cwd)
    },
    [newChat, closeDetail]
  )

  const handleAnswerQuestion = useCallback(
    (questionId: string, answer: string): void => {
      void respondQuestion(questionId, answer)
    },
    [respondQuestion]
  )

  const handleStopQuestionTimer = useCallback(
    (questionId: string): void => {
      void stopQuestionTimer(questionId)
    },
    [stopQuestionTimer]
  )

  const handleDeleteSession = useCallback(
    (sessionId: string): void => {
      void deleteSession(sessionId)
    },
    [deleteSession]
  )

  // Rename and archive are registry writes: the list is re-read afterwards so
  // what the sidebar shows is what the registry has, not what the click hoped
  // for. A failed write therefore leaves the row unchanged instead of showing a
  // title that was never persisted.
  const handleRenameSession = useCallback(
    (sessionId: string, title: string): void => {
      void renameSession(sessionId, title)
    },
    [renameSession]
  )

  const handleSetArchived = useCallback(
    (sessionId: string, archived: boolean): void => {
      void setSessionArchived(sessionId, archived)
    },
    [setSessionArchived]
  )

  // Composer chip: give the open chat a workspace (or replace the current one).
  const handleChooseProject = useCallback((): void => {
    setShowPlugins(false)
    setShowSkills(false)
    setShowMemory(false)
    closeDetail()
    void chooseProject()
  }, [chooseProject, closeDetail])

  // Sidebar Projects "+": pick a folder and open a chat in it.
  const handleAddProject = useCallback((): void => {
    setShowPlugins(false)
    setShowSkills(false)
    setShowMemory(false)
    closeDetail()
    void newChatInFolder()
  }, [newChatInFolder, closeDetail])

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
      setShowSkills(false)
      setShowMemory(false)
      closeDetail()
      void openSession(sessionId)
    },
    [openSession, closeDetail]
  )

  // Ticket 17: fork from a stable completed assistant message — the new
  // session inherits the transcript prefix; disk files are never touched.
  const handleForkSession = useCallback(
    (message: { createdAt: number; content: string }): void => {
      void forkSession(message)
    },
    [forkSession]
  )

  const navigateHistory = useCallback(
    (step: -1 | 1): void => {
      const next = history.index + step
      if (step < 0 ? next < 0 : next >= history.ids.length) return
      const target = history.ids[next]
      historyNavRef.current = true
      setHistory({ ids: history.ids, index: next })
      void openSession(target)
    },
    [history, openSession]
  )

  const handleBack = useCallback((): void => navigateHistory(-1), [navigateHistory])

  const handleForward = useCallback((): void => navigateHistory(1), [navigateHistory])

  const canBack = history.index > 0
  const canForward = history.index >= 0 && history.index < history.ids.length - 1

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

  // Settings is a window of its own, not a mode of the palette: it owns the
  // whole viewport and its own navigation.
  const handleOpenSettings = useCallback((): void => {
    setShowPalette(false)
    setShowSettings(true)
  }, [])

  const handleCloseSettings = useCallback((): void => {
    setShowSettings(false)
  }, [])

  const handleOpenPlugins = useCallback((): void => {
    setShowSkills(false)
    setShowMemory(false)
    setShowPlugins(true)
  }, [])

  const handleOpenSkills = useCallback((): void => {
    setShowPlugins(false)
    setShowMemory(false)
    setShowSkills(true)
  }, [])

  const handleOpenMemory = useCallback((): void => {
    setShowPlugins(false)
    setShowSkills(false)
    setShowMemory(true)
  }, [])

  const handleClosePlugins = useCallback((): void => {
    setShowPlugins(false)
  }, [])

  const handleCloseSkills = useCallback((): void => {
    setShowSkills(false)
  }, [])

  const handleCloseMemory = useCallback((): void => {
    setShowMemory(false)
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
    setShowReview((value) => {
      if (value) reviewAutoOpenRef.current = false
      return !value
    })
  }, [])

  const handleStop = useCallback((): void => {
    void stop()
  }, [stop])

  const closeReview = useCallback((): void => {
    reviewAutoOpenRef.current = false
    setShowReview(false)
  }, [])

  const handleCloseReview = useCallback((): void => {
    closeReview()
  }, [closeReview])

  const handleRejectReview = useCallback((): void => {
    closeReview()
  }, [closeReview])

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
      if (pendingPermission !== null) {
        event.preventDefault()
        handleRespond('deny')
        return
      }
      if (showSettings) {
        event.preventDefault()
        handleCloseSettings()
        return
      }
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
      if (showSkills) {
        event.preventDefault()
        handleCloseSkills()
        return
      }
      if (showMemory) {
        event.preventDefault()
        handleCloseMemory()
        return
      }
      if (showTerminal) {
        event.preventDefault()
        setShowTerminal(false)
        return
      }
      if (showReview) {
        event.preventDefault()
        closeReview()
      }
    },
    [pendingPermission, handleRespond, showSettings, showPalette, showPlugins, showSkills, showMemory, detail, showTerminal, showReview, closeDetail, closeReview, handleCloseSettings, handleClosePalette, handleClosePlugins, handleCloseSkills, handleCloseMemory]
  )

  useShortcuts([
    {
      id: 'togglePalette',
      key: 'k',
      ctrlOrMeta: true,
      preventDefault: true,
      allowInEditable: true,
      handler: () => {
        setShowSettings(false)
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
        setShowSettings(false)
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

  const permission = usePermissionMode(activeSessionId)

  // The scratch workspace is the absence of a project, not a project named
  // "scratch" — so it never reaches the composer chip or the sidebar grouping.
  const activeProjectCwd =
    activeSession === undefined ||
    (scratchCwd !== null && pathKey(activeSession.cwd) === pathKey(scratchCwd))
      ? undefined
      : activeSession.cwd

  const activePageName = showPlugins
    ? 'Plugins'
    : showSkills
      ? 'Skills'
      : showMemory
        ? 'Memory'
        : null

  const content =
    children ??
    (items.length > 0 ? (
      <ChatView
        items={items}
        running={isStreaming}
        modelRetry={modelRetry}
        onRegenerate={onRegenerate}
        onAddReference={handleAddReference}
        onErrorRetry={onErrorRetry}
        onFork={handleForkSession}
        goal={goal}
        goalMessage={goalMessage}
        onGoalCommand={(raw) => void send(raw)}
      />
    ) : historyLoading === true ? (
      <ChatSkeleton />
    ) : (
      <EmptyState />
    ))

  // Key per branch so the wrapper remounts and re-runs fx-fade on each switch.
  const contentKey = showPlugins
    ? 'plugins'
    : showSkills
      ? 'skills'
      : showMemory
        ? 'memory'
        : children !== undefined
          ? 'children'
          : items.length > 0
            ? 'chat'
            : historyLoading === true
              ? 'skeleton'
              : 'empty'

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text)] antialiased">
      <TitleBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        canBack={canBack}
        canForward={canForward}
        onBack={handleBack}
        onForward={handleForward}
        onNewChat={handleNewChat}
        onOpenSettings={handleOpenSettings}
        onToggleTerminal={handleToggleTerminal}
      />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <ErrorBoundary fallbackClassName="h-full min-h-[240px] w-64 shrink-0">
            <Sidebar
              sessions={sessions}
              activeSessionId={activeSessionId}
              onNewChat={handleNewChat}
              onSelect={handleSelectSession}
              onAddProject={handleAddProject}
              scratchCwd={scratchCwd}
              onDelete={handleDeleteSession}
              onRenameSession={handleRenameSession}
              onSetArchived={handleSetArchived}
              loading={sessionsLoaded !== true}
              onOpenPlugins={handleOpenPlugins}
              pluginsActive={showPlugins}
              onOpenSkills={handleOpenSkills}
              skillsActive={showSkills}
              onOpenMemory={handleOpenMemory}
              memoryActive={showMemory}
              onOpenSettings={handleOpenSettings}
            />
          </ErrorBoundary>
        )}

        <div
          className={`flex min-w-0 flex-1 flex-col overflow-hidden${
            sidebarOpen ? ' rounded-tl-2xl' : ''
          }`}
        >
          <TopBar
            title={
              activePageName ??
              (activeSession ? activeSession.title : 'New chat')
            }
            terminalActive={showTerminal}
            reviewActive={showReview}
            reviewCount={files.length}
            running={isStreaming}
            sessionControls={activePageName === null}
            onToggleTerminal={handleToggleTerminal}
            onToggleReview={handleToggleReview}
          />

          {connectionState === 'degraded' && connectionMessage !== undefined && (
            <ConnectionBanner message={connectionMessage} onRetry={handleRetryConnection} />
          )}

          <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--content-bg)]">
            <ErrorBoundary>
              <div key={contentKey} className="fx-fade h-full">
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
                ) : showSkills ? (
                  <SkillsPage onOpenMemory={handleOpenMemory} />
                ) : showMemory ? (
                  <MemoryPage />
                ) : (
                  content
                )}
              </div>
            </ErrorBoundary>
          </div>

          {activePageName === null && (
            <Composer
              onSend={(text, references) => handleSend(text, undefined, references)}
              listWorkspaceFiles={
                activeSessionId === null
                  ? undefined
                  : (query: string) => listWorkspaceFiles(activeSessionId, query)
              }
              readSessionContext={readSessionContext}
              onStop={handleStop}
              disabled={!activeSessionId}
              running={isStreaming}
              cwd={activeProjectCwd}
              projectBusy={bindingProject}
              onChooseProject={handleChooseProject}
              modelConfig={modelConfig}
              modelOptions={modelOptions}
              // A newly created chat exists before the kernel has reported its
              // model; say so instead of printing a placeholder name.
              modelResolving={activeSessionId !== null && modelConfig?.model == null}
              slashCommands={slashCommands}
              onSetModel={handleSetModel}
              onSetThinkingLevel={handleSetThinkingLevel}
              permissionMode={permission.mode}
              permissionPending={permission.pending}
              onChangePermissionMode={(mode) => void permission.setMode(mode)}
              queuedMessages={queuedMessages}
              onQueueRemove={handleComposerQueueRemove}
              onQueueSendNow={handleComposerQueueSendNow}
              references={references}
              onReferencesChange={setReferences}
              selectionPick={selectionPick}
              onSelectionPickConsumed={handleSelectionPickConsumed}
              sessions={sessions}
              activeSessionId={activeSessionId}
            />
          )}

          {showTerminal && (
            <Suspense
              fallback={
                <div className="h-72 shrink-0 rounded-t-xl border-t border-[var(--border)] bg-[var(--surface)]" />
              }
            >
              <TerminalDrawer
                open={showTerminal}
                onClose={handleCloseTerminal}
                sessionId={activeSessionId}
              />
            </Suspense>
          )}

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
          {pendingPermission && (
            <PermissionDialog
              request={pendingPermission}
              onRespond={handleRespond}
            />
          )}
          {pendingQuestion && (
            <QuestionPanel
              question={pendingQuestion}
              onAnswer={handleAnswerQuestion}
              onStopTimer={handleStopQuestionTimer}
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
              onOpenSettings={handleOpenSettings}
              onClose={handleClosePalette}
            />
          )}
          {showSettings && (
            <Suspense
              fallback={
                <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
                  <div className="absolute inset-0 bg-[var(--overlay)]" />
                  <div className="h-[min(660px,86vh)] w-[min(960px,92vw)] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]" />
                </div>
              }
            >
              <SettingsPage
                sessions={sessions}
                activeCwd={activeProjectCwd ?? null}
                activeSessionId={activeSessionId}
                onClose={handleCloseSettings}
                onModelsChanged={refreshModels}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  )
}
