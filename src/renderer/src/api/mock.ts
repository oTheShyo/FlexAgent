import {
  ContractError,
  type ApplyFileChangesInput,
  type ApplyFileChangesResult,
  type ChatMessage,
  type CodexApi,
  type CreateSessionInput,
  type CustomModelEntry,
  type CustomModelRef,
  type CustomModelSaveInput,
  type CustomModelWriteResult,
  type EventMeta,
  type FileChange,
  type InstallPluginInput,
  type KernelEvent,
  type ModelConfig,
  type ModelOption,
  type PermissionDecision,
  type PluginChangeEvent,
  type PluginDetail,
  type PluginId,
  type PluginSummary,
  type PromptAck,
  type PromptInput,
  type RespondPermissionInput,
  type SessionDetail,
  type SessionId,
  type SessionSearchHit,
  type SessionSummary,
  type SetModelInput,
  type SetSessionCwdInput,
  type SetThinkingLevelInput,
  type SkillPendingWrite,
  type SkillHubInfo,
  type SkillHubEntry,
  type AddSkillHubInput,
  type InstallSkillInput,
  type SkillSummary,
  type MemoryCard,
  type MemoryCardFile,
  type McpServerStatusEntry,
  type McpServerStatusEvent,
  type SlashCommandSummary,
  type TerminalCreateAck,
  type TerminalCreateInput,
  type TerminalId,
  type TerminalInputInput,
  type TerminalResizeInput,
  type ThinkingLevel,
  type ToolCallId,
  type UserMcpSaveInput,
  type UserMcpServerConfig,
  type UserMcpServerSummary
} from '../types'

type WithoutMeta<E> = E extends unknown ? Omit<E, keyof EventMeta> : never
type EventInput = WithoutMeta<KernelEvent>
type Listener = (event: KernelEvent) => void

interface RunHandle {
  aborted: boolean
  sleepers: Set<() => void>
}

interface PendingPermission {
  toolCallId: ToolCallId
  resolve: (decision: PermissionDecision | null) => void
}

interface TerminalState {
  alive: boolean
}

interface SessionState {
  summary: SessionSummary
  messages: ChatMessage[]
  seq: number
  listeners: Set<Listener>
  run: RunHandle | null
  steerQueue: string[]
  followUpQueue: string[]
  allowedTools: Set<string>
  pendingPermission: PendingPermission | null
  terminals: Map<TerminalId, TerminalState>
  modelConfig: ModelConfig
}

/** Deterministic per-token delays (ms), cycled to keep streaming inside 50–100ms. */
const TOKEN_DELAYS_MS = [60, 85, 70, 95] as const

const DEMO_CWD = '/demo/workspace'
/** Mirrors the main process: chats with no project live in the scratch workspace. */
const DEMO_SCRATCH_CWD = '/demo/scratch'

/** Mirrors registry.defaultTitle — scratch sessions stay "New chat". */
function mockDefaultTitle(cwd: string): string {
  if (cwd === DEMO_SCRATCH_CWD) return 'New chat'
  const parts = cwd.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? 'Session'
}
const MAX_TERMINALS_PER_SESSION = 4
const MOCK_MODEL_OPTIONS: ModelOption[] = [
  { provider: 'mimo', id: 'mimo-v2.6-flash', label: 'mimo-v2.6 Flash' },
  { provider: 'qwen', id: 'qwen-max', label: 'Qwen Max' },
  { provider: 'anthropic', id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }
]
const MOCK_THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']

// Regex: shell-ish prompts trigger the gated bash tool (the M4 permission path).
const SHELL_PROMPT_RE =
  /\b(bash|shell|zsh|npm|npx|yarn|pnpm|git|exec|command|terminal|install|deploy)\b|\brun\s+\S/i

const REPLY_LINES: string[] = [
  "Here's the plan:",
  '',
  '1. **Inspect** the current `src/App.tsx` layout',
  '2. **Wrap** the page in a semantic `<main>` shell',
  '3. **Mount** a `ChatPanel` slot for the streaming transcript',
  '',
  '```tsx',
  'export default function App() {',
  '  return (',
  '    <main className="app-shell">',
  '      <ChatPanel />',
  '    </main>',
  '  )',
  '}',
  '```',
  '',
  'Applying the edit now.'
]

/** Word-by-word tokens that preserve whitespace/newlines in the reply. */
function tokenize(reply: string): string[] {
  return reply.match(/\S+\s*/g) ?? []
}

function dirBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] ?? path) : path
}

export { dirBasename }

function buildAppFileChange(): FileChange {
  const patch = [
    '--- a/src/App.tsx',
    '+++ b/src/App.tsx',
    '@@ -1,7 +1,8 @@',
    ' export default function App() {',
    '   return (',
    '-    <div className="app">',
    '+    <main className="app-shell">',
    '       <h1>FlexAgent</h1>',
    '+      <ChatPanel />',
    '-    </div>',
    '+    </main>',
    '   )',
    ' }'
  ].join('\n')

  return {
    path: 'src/App.tsx',
    status: 'modified',
    additions: 3,
    deletions: 2,
    patch
  }
}

export class MockCodexApi implements CodexApi {
  private sessionCounter = 0
  private messageCounter = 0
  private toolCounter = 0
  private terminalCounter = 0
  private readonly sessions = new Map<SessionId, SessionState>()
  private readonly pluginDetails = new Map<PluginId, PluginDetail>()
  private readonly pluginListeners = new Set<(event: PluginChangeEvent) => void>()

  constructor() {
    this.addFixtureSession('Implement API contract', Date.UTC(2026, 8, 21, 9, 30), [
      ['user', 'Help me wire the IPC contract into the renderer'],
      ['assistant', 'I will read the shared contract first and map the command surface.']
    ])
    this.addFixtureSession('Sidebar shell layout', Date.UTC(2026, 8, 21, 15, 0), [])
    this.addFixtureSession('Diff review panel', Date.UTC(2026, 8, 20, 11, 0), [])
    this.addFixturePlugin('document-skills')
    this.addFixturePlugin('local-demo')
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.values()].map((session) => ({ ...session.summary }))
  }

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    const requested = typeof input?.cwd === 'string' ? input.cwd.trim() : ''
    const cwd = requested.length > 0 ? requested : DEMO_SCRATCH_CWD
    this.sessionCounter += 1
    const now = Date.now()
    const summary: SessionSummary = {
      id: `sess_${this.sessionCounter}`,
      title: input?.title?.trim() || mockDefaultTitle(cwd),
      cwd,
      createdAt: now,
      updatedAt: now,
      runState: 'idle'
    }
    this.sessions.set(summary.id, this.newSessionState(summary))
    return { ...summary }
  }

  async scratchCwd(): Promise<string> {
    return DEMO_SCRATCH_CWD
  }

  async setSessionCwd(input: SetSessionCwdInput): Promise<SessionSummary> {
    const session = this.sessions.get(input?.sessionId)
    if (!session) {
      throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${input?.sessionId}`)
    }
    const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
    if (cwd.length === 0) {
      throw new ContractError('INVALID_INPUT', 'cwd is required')
    }
    if (session.summary.runState !== 'idle') {
      throw new ContractError(
        'SESSION_BUSY',
        'cannot change the workspace while a run is in flight'
      )
    }
    // Mirrors registry.setCwd: a scratch session still called "New chat" gets
    // renamed after its project; a user-set title is left alone.
    if (session.summary.title === mockDefaultTitle(session.summary.cwd)) {
      session.summary.title = mockDefaultTitle(cwd)
    }
    session.summary.cwd = cwd
    session.summary.updatedAt = Date.now()
    return { ...session.summary }
  }

  async openSession(sessionId: SessionId): Promise<SessionDetail> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`)
    }
    return {
      summary: { ...session.summary },
      messages: session.messages.map((message) => ({ ...message }))
    }
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    if (!this.sessions.delete(sessionId)) {
      throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`)
    }
  }

  async prompt(input: PromptInput): Promise<PromptAck> {
    const session = this.sessions.get(input?.sessionId)
    if (!session) {
      throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${input?.sessionId}`)
    }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text.length === 0) {
      throw new ContractError('INVALID_INPUT', 'prompt text must not be empty')
    }

    if (session.run && session.summary.runState === 'running') {
      if (input.mode === 'followUp') {
        session.followUpQueue.push(text)
        return { disposition: 'queued' }
      }
      session.steerQueue.push(text)
      return { disposition: 'steering' }
    }

    const run: RunHandle = { aborted: false, sleepers: new Set() }
    session.run = run
    session.summary.runState = 'running'
    session.summary.updatedAt = Date.now()
    void this.executeRun(session, run, text)
    return { disposition: 'started' }
  }

  async abort(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`)
    }
    const run = session.run
    if (!run) return

    run.aborted = true
    for (const wake of [...run.sleepers]) wake()
    run.sleepers.clear()
    if (session.pendingPermission) {
      const pending = session.pendingPermission
      session.pendingPermission = null
      pending.resolve(null)
    }
    session.run = null
    session.steerQueue.length = 0
    session.followUpQueue.length = 0
    session.summary.runState = 'idle'
    session.summary.updatedAt = Date.now()
    this.emitEvent(session, { type: 'run_state', runState: 'idle' })
  }

  async respondPermission(input: RespondPermissionInput): Promise<void> {
    const session = this.sessions.get(input?.sessionId)
    if (!session) {
      throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${input?.sessionId}`)
    }
    const pending = session.pendingPermission
    if (!pending || pending.toolCallId !== input.toolCallId) {
      throw new ContractError('PERMISSION_EXPIRED', `No pending permission for ${input.toolCallId}`)
    }
    session.pendingPermission = null
    pending.resolve(input.decision)
  }

  subscribe(sessionId: SessionId, listener: Listener): () => void {
    const session = this.sessions.get(sessionId)
    if (!session) return () => undefined
    session.listeners.add(listener)
    return () => {
      session.listeners.delete(listener)
    }
  }

  async terminalCreate(input: TerminalCreateInput): Promise<TerminalCreateAck> {
    const session = this.sessions.get(input?.sessionId)
    if (!session) {
      throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${input?.sessionId}`)
    }
    if (
      !Number.isInteger(input.cols) || input.cols <= 0 ||
      !Number.isInteger(input.rows) || input.rows <= 0
    ) {
      throw new ContractError('INVALID_INPUT', 'cols and rows must be positive integers')
    }
    const liveCount = [...session.terminals.values()].filter((state) => state.alive).length
    if (liveCount >= MAX_TERMINALS_PER_SESSION) {
      throw new ContractError('TERMINAL_LIMIT', `At most ${MAX_TERMINALS_PER_SESSION} live terminals per session`)
    }

    this.terminalCounter += 1
    const terminalId = `pty_${this.terminalCounter}`
    session.terminals.set(terminalId, { alive: true })
    window.setTimeout(() => {
      const state = session.terminals.get(terminalId)
      if (!state || !state.alive) return
      this.emitEvent(session, {
        type: 'pty_output',
        terminalId,
        data: `flex-agent mock shell (${input.cwd ?? session.summary.cwd})\r\n$ `
      })
    }, 80)
    return { terminalId }
  }

  async terminalInput(input: TerminalInputInput): Promise<void> {
    const found = this.findTerminal(input?.terminalId)
    if (!found || !found.state.alive) {
      throw new ContractError('TERMINAL_NOT_FOUND', `Unknown or dead terminal: ${input?.terminalId}`)
    }
    if (typeof input.data !== 'string' || input.data.length === 0) {
      throw new ContractError('INVALID_INPUT', 'data must be a non-empty string')
    }
    const { session, state } = found
    const terminalId = input.terminalId

    this.emitEvent(session, { type: 'pty_output', terminalId, data: input.data })

    const newlineIndex = input.data.indexOf('\n')
    if (newlineIndex !== -1) {
      const line = input.data.slice(0, newlineIndex).replace(/\r$/, '')
      const result =
        line.startsWith('echo ') ? `${line.slice(5)}\r\n`
        : line.length > 0 ? `(mock) executed: ${line}\r\n`
        : ''
      window.setTimeout(() => {
        if (!state.alive) return
        this.emitEvent(session, { type: 'pty_output', terminalId, data: `${result}$ ` })
      }, 120)
    }
  }

  async terminalResize(input: TerminalResizeInput): Promise<void> {
    const found = this.findTerminal(input?.terminalId)
    if (!found || !found.state.alive) {
      throw new ContractError('TERMINAL_NOT_FOUND', `Unknown or dead terminal: ${input?.terminalId}`)
    }
    if (!Number.isInteger(input.cols) || input.cols <= 0 || !Number.isInteger(input.rows) || input.rows <= 0) {
      throw new ContractError('INVALID_INPUT', 'cols and rows must be positive integers')
    }
  }

  async terminalKill(terminalId: TerminalId): Promise<void> {
    const found = this.findTerminal(terminalId)
    if (!found) {
      throw new ContractError('TERMINAL_NOT_FOUND', `Unknown terminal: ${terminalId}`)
    }
    if (!found.state.alive) return
    found.state.alive = false
    this.emitEvent(found.session, { type: 'pty_exit', terminalId, exitCode: 0 })
  }

  async applyFileChanges(input: ApplyFileChangesInput): Promise<ApplyFileChangesResult> {
    const session = this.sessions.get(input?.sessionId)
    if (!session) {
      throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${input?.sessionId}`)
    }
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new ContractError('INVALID_INPUT', 'files must be a non-empty array')
    }
    for (const file of input.files) {
      if (typeof file?.path !== 'string' || file.path.length === 0) {
        throw new ContractError('INVALID_INPUT', 'each file requires a non-empty path')
      }
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 280)
    })
    return {
      applied: input.files.map((file) => file.path),
      alreadyApplied: [],
      failed: []
    }
  }

  private async executeRun(session: SessionState, run: RunHandle, initialText: string): Promise<void> {
    const alive = (): boolean => !run.aborted && session.run === run
    const emit = (input: EventInput): void => {
      if (!alive()) return
      this.emitEvent(session, input)
    }
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => {
          run.sleepers.delete(wake)
          resolve()
        }, ms)
        const wake = (): void => {
          window.clearTimeout(id)
          run.sleepers.delete(wake)
          resolve()
        }
        run.sleepers.add(wake)
      })
    const drainSteers = (): void => {
      while (session.steerQueue.length > 0 && alive()) {
        const steered = session.steerQueue.shift()
        if (steered === undefined) break
        emit({ type: 'user_message', message: this.nextMessage('user', steered) })
      }
    }

    let currentText = initialText

    emit({ type: 'run_state', runState: 'running' })
    emit({ type: 'user_message', message: this.nextMessage('user', currentText) })

    for (;;) {
      await sleep(180)
      if (!alive()) return
      const readCall = this.nextToolId()
      emit({
        type: 'tool_start',
        toolCallId: readCall,
        name: 'read_file',
        label: 'Read src/App.tsx',
        args: { path: 'src/App.tsx' }
      })
      await sleep(320)
      if (!alive()) return
      emit({ type: 'tool_update', toolCallId: readCall, chunk: 'export default function App() {\n' })
      await sleep(280)
      if (!alive()) return
      emit({ type: 'tool_update', toolCallId: readCall, chunk: '  return <div className="app" />\n' })
      await sleep(300)
      if (!alive()) return
      emit({
        type: 'tool_end',
        toolCallId: readCall,
        isError: false,
        summary: 'Read 24 lines from src/App.tsx'
      })

      if (SHELL_PROMPT_RE.test(currentText)) {
        const proceeded = await this.runBashStep(session, run, emit, sleep)
        if (!proceeded || !alive()) return
      }

      await sleep(220)
      if (!alive()) return
      drainSteers()

      const tokens = tokenize(REPLY_LINES.join('\n'))
      const assistantId = this.nextMessageId()
      let content = ''
      for (let index = 0; index < tokens.length; index += 1) {
        await sleep(TOKEN_DELAYS_MS[index % TOKEN_DELAYS_MS.length])
        if (!alive()) return
        content += tokens[index]
        emit({ type: 'text_delta', delta: tokens[index] })
        if (index % 6 === 5) drainSteers()
      }
      if (!alive()) return
      emit({
        type: 'message_end',
        message: { id: assistantId, role: 'assistant', content, createdAt: Date.now() }
      })
      drainSteers()

      await sleep(150)
      if (!alive()) return
      emit({ type: 'file_changes', files: [buildAppFileChange()] })
      drainSteers()

      // Queued followUps must surface (user_message) *before* idle, then the run cycles again.
      if (session.followUpQueue.length > 0 && alive()) {
        const queued = session.followUpQueue.splice(0, session.followUpQueue.length)
        for (const text of queued) {
          currentText = text
          emit({ type: 'user_message', message: this.nextMessage('user', text) })
        }
        if (!alive()) return
        emit({ type: 'run_state', runState: 'idle' })
        if (!alive()) return
        emit({ type: 'run_state', runState: 'running' })
        continue
      }

      emit({ type: 'run_state', runState: 'idle' })
      break
    }

    if (alive()) {
      session.run = null
      session.summary.runState = 'idle'
    }
  }

  /**
   * First bash per session: emit permission_request and block with ZERO further
   * events for this toolCallId until respondPermission settles it (contract §2.2/§4 M4).
   * Returns false when the run should stop (abort / cancelled permission).
   */
  private async runBashStep(
    session: SessionState,
    run: RunHandle,
    emit: (input: EventInput) => void,
    sleep: (ms: number) => Promise<void>
  ): Promise<boolean> {
    const alive = (): boolean => !run.aborted && session.run === run
    const toolCallId = this.nextToolId()
    const command = 'npm run typecheck'
    const label = 'Run npm run typecheck'
    const args: Record<string, unknown> = { command, cwd: session.summary.cwd }

    if (!session.allowedTools.has('bash')) {
      emit({
        type: 'permission_request',
        toolCallId,
        name: 'bash',
        label,
        args,
        reason: 'First bash tool call in this session'
      })
      if (!alive()) return false
      const decision = await this.awaitPermission(session, toolCallId)
      if (!alive() || decision === null) return false
      if (decision === 'deny') {
        emit({ type: 'tool_end', toolCallId, isError: true, summary: 'Permission denied by user' })
        return alive()
      }
      if (decision === 'allowSession') {
        session.allowedTools.add('bash')
      }
    }

    emit({ type: 'tool_start', toolCallId, name: 'bash', label, args })
    await sleep(300)
    if (!alive()) return false
    emit({ type: 'tool_update', toolCallId, chunk: `$ ${command}\n` })
    await sleep(450)
    if (!alive()) return false
    emit({
      type: 'tool_update',
      toolCallId,
      chunk: '\n> tsc --noEmit -p tsconfig.node.json\n> tsc --noEmit -p tsconfig.web.json\n'
    })
    await sleep(400)
    if (!alive()) return false
    emit({ type: 'tool_end', toolCallId, isError: false, summary: 'Command exited with code 0' })
    return true
  }

  private awaitPermission(session: SessionState, toolCallId: ToolCallId): Promise<PermissionDecision | null> {
    return new Promise((resolve) => {
      if (!session.run || session.run.aborted) {
        resolve(null)
        return
      }
      session.pendingPermission = { toolCallId, resolve }
    })
  }

  private newSessionState(summary: SessionSummary): SessionState {
    return {
      summary,
      messages: [],
      seq: 0,
      listeners: new Set(),
      run: null,
      steerQueue: [],
      followUpQueue: [],
      allowedTools: new Set(),
      pendingPermission: null,
      terminals: new Map(),
      modelConfig: {
        model: MOCK_MODEL_OPTIONS[0] ?? null,
        thinkingLevel: 'medium',
        availableThinkingLevels: [...MOCK_THINKING_LEVELS]
      }
    }
  }

  async listModels(): Promise<ModelOption[]> {
    return [...MOCK_MODEL_OPTIONS, ...this.customModelOptions()].map((option) => ({ ...option }))
  }

  async getModelConfig(sessionId: SessionId): Promise<ModelConfig> {
    return { ...this.requireSession(sessionId).modelConfig }
  }

  async setModel(input: SetModelInput): Promise<ModelConfig> {
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
      throw new ContractError('INVALID_INPUT', 'sessionId is required')
    }
    if (typeof input.provider !== 'string' || !input.provider || typeof input.id !== 'string' || !input.id) {
      throw new ContractError('INVALID_INPUT', 'provider and id are required')
    }
    const session = this.requireSession(input.sessionId)
    const model = [...MOCK_MODEL_OPTIONS, ...this.customModelOptions()].find(
      (option) => option.provider === input.provider && option.id === input.id
    )
    if (!model) {
      throw new ContractError('INVALID_INPUT', `Unknown model: ${input.provider}/${input.id}`)
    }
    session.modelConfig = {
      model: { ...model },
      thinkingLevel: input.thinkingLevel ?? session.modelConfig.thinkingLevel,
      availableThinkingLevels: [...MOCK_THINKING_LEVELS]
    }
    return { ...session.modelConfig }
  }

  async setThinkingLevel(input: SetThinkingLevelInput): Promise<ModelConfig> {
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
      throw new ContractError('INVALID_INPUT', 'sessionId is required')
    }
    if (!MOCK_THINKING_LEVELS.includes(input.level)) {
      throw new ContractError('INVALID_INPUT', `Invalid thinkingLevel: ${String(input.level)}`)
    }
    const session = this.requireSession(input.sessionId)
    session.modelConfig = { ...session.modelConfig, thinkingLevel: input.level }
    return { ...session.modelConfig }
  }

  async pickDirectory(): Promise<string | null> {
    return DEMO_CWD
  }

  // ── Custom models (v1.9) ──
  // Same observable behaviour as the real service: validated writes, and a
  // saved model is immediately resolvable by listModels/setModel.
  private readonly customModels = new Map<string, CustomModelEntry>()

  private static readonly PROVIDER_RE = /^[a-zA-Z0-9_-]{1,64}$/

  private customModelOptions(): ModelOption[] {
    return [...this.customModels.values()].map((entry) => ({
      provider: entry.provider,
      id: entry.id,
      ...(entry.label !== undefined ? { label: entry.label } : {})
    }))
  }

  private requireCustomModel(input: CustomModelRef | null): CustomModelRef {
    if (input === null || typeof input !== 'object') {
      throw new ContractError('INVALID_INPUT', 'expected { provider, id }')
    }
    if (!MockCodexApi.PROVIDER_RE.test(input.provider)) {
      throw new ContractError('INVALID_INPUT', 'provider must match [a-zA-Z0-9_-]{1,64}')
    }
    if (typeof input.id !== 'string' || input.id.trim().length === 0) {
      throw new ContractError('INVALID_INPUT', 'id is required')
    }
    return { provider: input.provider, id: input.id.trim() }
  }

  async listCustomModels(): Promise<CustomModelEntry[]> {
    return [...this.customModels.values()].map((entry) => ({ ...entry }))
  }

  async customModelsPath(): Promise<string> {
    return '~/.pi/agent/models.json'
  }

  async saveCustomModel(input: CustomModelSaveInput): Promise<CustomModelWriteResult> {
    const ref = this.requireCustomModel(input)
    if (typeof input.baseUrl !== 'string' || !/^https?:\/\//.test(input.baseUrl)) {
      throw new ContractError('INVALID_INPUT', 'Base URL must start with http:// or https://')
    }
    if (typeof input.apiKey !== 'string' || input.apiKey.trim().length === 0) {
      throw new ContractError('INVALID_INPUT', 'API key is required')
    }
    if (input.original !== undefined) this.customModels.delete(this.customKey(input.original))
    this.customModels.set(this.customKey(ref), {
      provider: ref.provider,
      id: ref.id,
      ...(input.label !== undefined && input.label.length > 0 ? { label: input.label } : {}),
      baseUrl: input.baseUrl,
      api: input.api ?? 'openai-completions',
      apiKeySet: true
    })
    return { models: await this.listCustomModels() }
  }

  async removeCustomModel(input: CustomModelRef): Promise<CustomModelWriteResult> {
    const ref = this.requireCustomModel(input)
    if (!this.customModels.delete(this.customKey(ref))) {
      throw new ContractError('CUSTOM_MODEL_NOT_FOUND', `Unknown custom model: ${ref.provider}/${ref.id}`)
    }
    return { models: await this.listCustomModels() }
  }

  private customKey(ref: CustomModelRef): string {
    return `${ref.provider}\u0000${ref.id}`
  }

  async listPlugins(): Promise<PluginSummary[]> {
    return [...this.pluginDetails.values()].map((detail) => this.pluginSummaryOf(detail))
  }

  async getPlugin(id: PluginId): Promise<PluginDetail> {
    const detail = this.pluginDetails.get(id)
    if (detail === undefined) {
      throw new ContractError('PLUGIN_NOT_FOUND', `Unknown plugin: ${id}`)
    }
    return {
      ...detail,
      source: { ...detail.source },
      componentCounts: { ...detail.componentCounts },
      components: detail.components.map((component) => ({ ...component }))
    }
  }

  async setPluginEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary> {
    const detail = this.pluginDetails.get(id)
    if (detail === undefined) {
      throw new ContractError('PLUGIN_NOT_FOUND', `Unknown plugin: ${id}`)
    }
    if (detail.enabled !== enabled) {
      detail.enabled = enabled
      this.pushPluginsChanged()
    }
    return this.pluginSummaryOf(detail)
  }

  async installPlugin(input: InstallPluginInput): Promise<PluginSummary> {
    const path = typeof input?.source?.path === 'string' ? input.source.path.trim() : ''
    if (path.length === 0) {
      throw new ContractError('INVALID_INPUT', 'installPlugin requires a non-empty directory path')
    }
    const name = dirBasename(path)
    for (const detail of this.pluginDetails.values()) {
      if (detail.name === name) {
        throw new ContractError('PLUGIN_ALREADY_INSTALLED', `Plugin already installed: ${name}`)
      }
    }
    const detail: PluginDetail = {
      id: `${name}@local`,
      name,
      version: '0.1.0',
      description: `Plugin installed from ${path}.`,
      enabled: true,
      source: { kind: 'local', label: 'Local' },
      componentCounts: { skill: 1 },
      rootPath: path,
      components: [
        {
          kind: 'skill',
          name: 'main',
          description: 'Entry skill discovered in this plugin folder.',
          path: 'skills/main/SKILL.md'
        }
      ],
      userConfig: [],
      diagnostics: []
    }
    this.pluginDetails.set(detail.id, detail)
    this.pushPluginsChanged()
    return this.pluginSummaryOf(detail)
  }

  async uninstallPlugin(id: PluginId): Promise<void> {
    if (!this.pluginDetails.delete(id)) {
      throw new ContractError('PLUGIN_NOT_FOUND', `Unknown plugin: ${id}`)
    }
    this.pushPluginsChanged()
  }

  subscribePlugins(listener: (event: PluginChangeEvent) => void): () => void {
    this.pluginListeners.add(listener)
    return () => {
      this.pluginListeners.delete(listener)
    }
  }

  async listSlashCommands(): Promise<SlashCommandSummary[]> {
    const commands: SlashCommandSummary[] = []
    for (const detail of this.pluginDetails.values()) {
      if (!detail.enabled) continue
      for (const component of detail.components) {
        if (component.kind !== 'command') continue
        commands.push({
          name: component.name,
          ...(component.description !== undefined ? { description: component.description } : {}),
          pluginId: detail.id
        })
      }
    }
    return commands
  }

  // ── User-level MCP servers (v1.8 fixtures) ──

  private readonly userMcpServers = new Map<string, UserMcpServerConfig>()
  private readonly mcpStatusListeners = new Set<(event: McpServerStatusEvent) => void>()

  async listUserMcpServers(): Promise<UserMcpServerSummary[]> {
    return [...this.userMcpServers.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, config]) => ({ name, config: { ...config } }))
  }

  async saveUserMcpServer(input: UserMcpSaveInput): Promise<UserMcpServerSummary[]> {
    if (input === null || typeof input !== 'object' || typeof input.name !== 'string') {
      throw new ContractError('INVALID_INPUT', 'expected { name, config }')
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.name)) {
      throw new ContractError('INVALID_INPUT', 'name must match [a-zA-Z0-9_-]{1,64}')
    }
    if (
      input.config === null ||
      typeof input.config !== 'object' ||
      (input.config.type !== 'stdio' && input.config.type !== 'http')
    ) {
      throw new ContractError('INVALID_INPUT', 'config.type must be "stdio" or "http"')
    }
    this.userMcpServers.set(input.name, { ...input.config })
    return this.listUserMcpServers()
  }

  async removeUserMcpServer(name: string): Promise<UserMcpServerSummary[]> {
    if (!this.userMcpServers.delete(name)) {
      throw new ContractError('USER_MCP_NOT_FOUND', `Unknown MCP server: ${name}`)
    }
    return this.listUserMcpServers()
  }

  async toggleUserMcpServer(name: string, enabled: boolean): Promise<UserMcpServerSummary[]> {
    const config = this.userMcpServers.get(name)
    if (config === undefined) {
      throw new ContractError('USER_MCP_NOT_FOUND', `Unknown MCP server: ${name}`)
    }
    this.userMcpServers.set(name, { ...config, enabled })
    return this.listUserMcpServers()
  }

  async listMcpServerStatus(): Promise<McpServerStatusEntry[]> {
    const servers: McpServerStatusEntry[] = []
    for (const [name, config] of this.userMcpServers) {
      if (config.enabled === false) continue
      servers.push({ key: `user:${name}`, source: 'user', type: config.type, connected: true, toolCount: 0 })
    }
    return servers
  }

  subscribeMcpStatus(listener: (event: McpServerStatusEvent) => void): () => void {
    this.mcpStatusListeners.add(listener)
    return () => {
      this.mcpStatusListeners.delete(listener)
    }
  }

  // ── Skills / Memory / History (v1.7 fixtures) ──

  private readonly pendingSkillWrites: SkillPendingWrite[] = [
    {
      id: 'pending-mock-1',
      skillName: 'deploy-checklist',
      summary: ['create skill "deploy-checklist" (1840 chars)'],
      targetPaths: ['~/.flexagent/skills/deploy-checklist'],
      createdAt: Date.now() - 60_000
    }
  ]

  private readonly memoryCards: MemoryCard[] = [
    { file: 'MEMORY', index: 0, text: 'Runtime config lives in realtime-cv-inversion-0521/config.json, not the -wbh workdir.' },
    { file: 'MEMORY', index: 1, text: 'Contract changes are additive only — never repurpose existing fields.' },
    { file: 'USER', index: 0, text: 'Prefers concise, table-first answers with evidence.' }
  ]

  async listSkills(): Promise<SkillSummary[]> {
    const skills: SkillSummary[] = [
      {
        name: 'repo-conventions',
        description: 'How this repo structures commits, contracts and handoffs.',
        source: 'user',
        path: '~/.flexagent/skills/repo-conventions'
      }
    ]
    for (const detail of this.pluginDetails.values()) {
      if (!detail.enabled) continue
      for (const component of detail.components) {
        if (component.kind !== 'skill') continue
        skills.push({
          name: component.name,
          ...(component.description !== undefined ? { description: component.description } : {}),
          source: 'plugin',
          path: component.path ?? '',
          pluginId: detail.id
        })
      }
    }
    return skills
  }

  async listPendingSkillWrites(): Promise<SkillPendingWrite[]> {
    return this.pendingSkillWrites.map((write) => ({ ...write }))
  }

  async approveSkillWrite(id: string): Promise<void> {
    const index = this.pendingSkillWrites.findIndex((write) => write.id === id)
    if (index < 0) throw new ContractError('INVALID_INPUT', `no pending skill write with id ${id}`)
    this.pendingSkillWrites.splice(index, 1)
  }

  async rejectSkillWrite(id: string): Promise<void> {
    await this.approveSkillWrite(id)
  }

  async listMemoryCards(): Promise<MemoryCard[]> {
    return this.memoryCards.map((card) => ({ ...card }))
  }

  async addMemoryCard(file: MemoryCardFile, text: string): Promise<void> {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed.length === 0) throw new ContractError('INVALID_INPUT', 'text is required')
    this.memoryCards.push({ file, index: this.memoryCards.filter((c) => c.file === file).length, text: trimmed })
  }

  async removeMemoryCard(file: MemoryCardFile, index: number): Promise<void> {
    const globalIndex = this.memoryCards.findIndex((card) => card.file === file && card.index === index)
    if (globalIndex < 0) throw new ContractError('INVALID_INPUT', 'card index out of range')
    this.memoryCards.splice(globalIndex, 1)
    // Reindex remaining cards of that file.
    let next = 0
    for (const card of this.memoryCards) {
      if (card.file === file) card.index = next++
    }
  }

  async searchSessions(query: string): Promise<SessionSearchHit[]> {    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return []
    const hits: SessionSearchHit[] = []
    for (const session of this.sessions.values()) {
      const title = session.summary.title
      if (title.toLowerCase().includes(needle)) {
        hits.push({
          sessionId: session.summary.id,
          title,
          snippet: '(标题匹配)',
          updatedAt: session.summary.updatedAt
        })
        continue
      }
      const firstMatch = session.messages.find((message) =>
        message.content.toLowerCase().includes(needle)
      )
      if (firstMatch !== undefined) {
        const at = firstMatch.content.toLowerCase().indexOf(needle)
        const start = Math.max(0, at - 60)
        const snippet = `${start > 0 ? '…' : ''}${firstMatch.content.slice(start, at + needle.length + 60).replace(/\s+/g, ' ')}…`
        hits.push({
          sessionId: session.summary.id,
          title,
          snippet: `${firstMatch.role === 'user' ? '你' : 'AI'}: ${snippet}`,
          updatedAt: session.summary.updatedAt
        })
      }
      if (hits.length >= 20) break
    }
    return hits
  }

  private mockSkillHubs: SkillHubInfo[] = [
    { id: 'official', name: 'Official', url: 'github:anthropics/skills', builtIn: true, skillCount: 4 }
  ]

  private mockHubEntries: SkillHubEntry[] = [
    {
      hub: 'official',
      name: 'document-skills-docx',
      description: 'Create and edit Word documents with tracked changes and formatting.',
      source: 'github:anthropics/skills/document-skills/docx',
      installed: false
    },
    {
      hub: 'official',
      name: 'document-skills-pdf',
      description: 'Read, merge, split and fill PDF files.',
      source: 'github:anthropics/skills/document-skills/pdf',
      installed: false
    },
    {
      hub: 'official',
      name: 'artifacts-builder',
      description: 'Build elaborate claude.ai HTML artifacts with modern frontend tooling.',
      source: 'github:anthropics/skills/artifacts-builder',
      installed: false
    },
    {
      hub: 'official',
      name: 'webapp-testing',
      description: 'Drive Playwright against local web apps to verify and debug UI behavior.',
      source: 'github:anthropics/skills/webapp-testing',
      installed: false
    }
  ]

  async listSkillHubs(): Promise<SkillHubInfo[]> {
    return this.mockSkillHubs.map((hub) => ({ ...hub }))
  }

  async addSkillHub(input: AddSkillHubInput): Promise<SkillHubInfo> {
    const name = input.name.trim().toLowerCase()
    if (this.mockSkillHubs.some((hub) => hub.id === name)) {
      throw new ContractError('INVALID_INPUT', `hub "${name}" already exists`)
    }
    const info: SkillHubInfo = { id: name, name, url: input.url, builtIn: false, skillCount: 0 }
    this.mockSkillHubs.push(info)
    this.mockHubEntries.push({
      hub: name,
      name: `${name}-sample-skill`,
      description: `Fixture entry for the mock hub "${name}".`,
      source: 'github:example/sample',
      installed: false
    })
    return { ...info }
  }

  async removeSkillHub(id: string): Promise<void> {
    if (id === 'official') throw new ContractError('INVALID_INPUT', 'the built-in hub cannot be removed')
    this.mockSkillHubs = this.mockSkillHubs.filter((hub) => hub.id !== id)
    this.mockHubEntries = this.mockHubEntries.filter((entry) => entry.hub !== id)
  }

  async browseSkillHub(id?: string): Promise<SkillHubEntry[]> {
    return this.mockHubEntries
      .filter((entry) => id === undefined || entry.hub === id)
      .map((entry) => ({
        ...entry,
        installed: this.mockSkillHubs.length >= 0 && entry.installed
      }))
  }

  async installSkill(input: InstallSkillInput): Promise<SkillSummary> {
    const src = input.source
    let entry: SkillHubEntry | undefined
    if (src.kind === 'hub') {
      entry = this.mockHubEntries.find(
        (candidate) => candidate.hub === src.hub && candidate.name === src.name
      )
    } else if (src.kind === 'source') {
      entry = this.mockHubEntries.find((candidate) => candidate.source === src.source)
    } else {
      entry = undefined
    }
    if (entry === undefined) {
      const name = src.kind === 'folder' ? src.folderPath.split(/[\\/]/u).pop() ?? 'local-skill' : 'skill'
      return { name, description: 'Installed from local folder (mock).', source: 'user', path: `~/.flexagent/skills/${name}` }
    }
    if (entry.installed && input.overwrite !== true) {
      throw new ContractError('SKILL_ALREADY_INSTALLED', `"${entry.name}" is already installed`)
    }
    entry.installed = true
    return {
      name: entry.name,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      source: 'user',
      path: `~/.flexagent/skills/${entry.name}`
    }
  }

  async uninstallSkill(name: string): Promise<void> {
    const entry = this.mockHubEntries.find((candidate) => candidate.name === name)
    if (entry !== undefined) entry.installed = false
  }

  adoptPlugin(detail: PluginDetail): void {
    this.pluginDetails.set(detail.id, detail)
    this.pushPluginsChanged()
  }

  installedVersionOf(name: string): string | null {
    for (const detail of this.pluginDetails.values()) {
      if (detail.name === name) return detail.version
    }
    return null
  }

  private pluginSummaryOf(detail: PluginDetail): PluginSummary {
    return {
      id: detail.id,
      name: detail.name,
      version: detail.version,
      description: detail.description,
      enabled: detail.enabled,
      source: { ...detail.source },
      componentCounts: { ...detail.componentCounts }
    }
  }

  private pushPluginsChanged(): void {
    window.setTimeout(() => {
      const plugins = [...this.pluginDetails.values()].map((detail) => this.pluginSummaryOf(detail))
      for (const listener of this.pluginListeners) {
        listener({ plugins })
      }
    }, 120)
  }

  private addFixturePlugin(name: 'document-skills' | 'local-demo'): void {
    const details: Record<
      'document-skills' | 'local-demo',
      Omit<PluginDetail, 'id' | 'rootPath' | 'source'>
    > = {
      'document-skills': {
        name: 'document-skills',
        version: '1.0.0',
        description: 'Built-in skills for generating DOCX and PDF documents.',
        enabled: true,
        componentCounts: { skill: 2, command: 1 },
        components: [
          {
            kind: 'skill',
            name: 'docx',
            description: 'Create, read, and edit Word documents.',
            path: 'skills/docx/SKILL.md'
          },
          {
            kind: 'skill',
            name: 'pdf',
            description: 'Merge, split, and extract text from PDF files.',
            path: 'skills/pdf/SKILL.md'
          },
          {
            kind: 'command',
            name: 'summarize',
            description: 'Summarize the current file or selection.',
            path: 'commands/summarize.md'
          }
        ],
        userConfig: [],
        diagnostics: []
      },
      'local-demo': {
        name: 'local-demo',
        version: '0.2.1',
        description: 'Local demo plugin with an extension and one skill.',
        enabled: false,
        componentCounts: { extension: 1, skill: 1 },
        components: [
          {
            kind: 'extension',
            name: 'demo-extension',
            description: 'Registers a demo renderer extension.',
            path: 'extension/index.js'
          },
          {
            kind: 'skill',
            name: 'demo-greet',
            description: 'Greets the user with a demo phrase.',
            path: 'skills/demo-greet/SKILL.md'
          }
        ],
        userConfig: [
          {
            key: 'greeting_name',
            title: 'Greeting name',
            description: 'Name used by the demo skill.',
            type: 'string',
            default: 'FlexAgent',
            required: true
          },
          {
            key: 'api_key',
            title: 'API key',
            description: 'Third-party service credential.',
            type: 'string',
            required: true,
            sensitive: true
          },
          {
            key: 'data_dir',
            title: 'Data directory',
            type: 'directory'
          }
        ],
        diagnostics: [
          {
            code: 'PLUGIN_COMPONENT_INVALID',
            severity: 'warning',
            message: 'commands/example.md: frontmatter is missing a description; command skipped.',
            pluginId: 'local-demo@local'
          }
        ]
      }
    }
    const base = details[name]
    const source =
      name === 'document-skills'
        ? { kind: 'bundled' as const, label: 'Bundled' }
        : { kind: 'local' as const, label: 'Local' }
    const id = `${name}@${source.kind}`
    const rootPath =
      name === 'document-skills'
        ? '<bundled>/document-skills'
        : `${DEMO_CWD}/fixtures/local-demo`
    this.pluginDetails.set(id, { ...base, id, source, rootPath })
  }

  private requireSession(sessionId: SessionId): SessionState {
    const session = this.sessions.get(sessionId)
    if (!session) throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`)
    return session
  }

  private addFixtureSession(
    title: string,
    updatedAt: number,
    seeded: ReadonlyArray<readonly [ChatMessage['role'], string]>
  ): void {
    this.sessionCounter += 1
    const summary: SessionSummary = {
      id: `sess_${this.sessionCounter}`,
      title,
      cwd: DEMO_CWD,
      createdAt: updatedAt,
      updatedAt,
      runState: 'idle'
    }
    const state = this.newSessionState(summary)
    state.messages = seeded.map(([role, content]) => this.nextMessage(role, content, updatedAt))
    this.sessions.set(summary.id, state)
  }

  private nextMessage(role: ChatMessage['role'], content: string, createdAt = Date.now()): ChatMessage {
    this.messageCounter += 1
    return { id: `msg_${this.messageCounter}`, role, content, createdAt }
  }

  private nextMessageId(): string {
    this.messageCounter += 1
    return `msg_${this.messageCounter}`
  }

  private nextToolId(): ToolCallId {
    this.toolCounter += 1
    return `call_${this.toolCounter}`
  }

  private findTerminal(terminalId: TerminalId): { session: SessionState; state: TerminalState } | null {
    if (typeof terminalId !== 'string' || terminalId.length === 0) return null
    for (const session of this.sessions.values()) {
      const state = session.terminals.get(terminalId)
      if (state) return { session, state }
    }
    return null
  }

  // Contract §3: per-session seq starts at 0 and is gap-free; transcript mirrors
  // user_message/message_end so openSession can replay history.
  private emitEvent(session: SessionState, input: EventInput): void {
    const event = {
      ...input,
      sessionId: session.summary.id,
      seq: session.seq,
      ts: Date.now()
    } as KernelEvent
    session.seq += 1

    if (event.type === 'run_state') session.summary.runState = event.runState
    if (event.type === 'user_message' || event.type === 'message_end') {
      session.messages.push(event.message)
      session.summary.updatedAt = event.ts
    }

    for (const listener of session.listeners) {
      try {
        listener(event)
      } catch {
        // listener failures must not break dispatch to remaining listeners
      }
    }
  }
}
