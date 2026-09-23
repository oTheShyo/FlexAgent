import {
  ContractError,
  type ApplyFileChangesInput,
  type ApplyFileChangesResult,
  type ChatMessage,
  type CodexApi,
  type CreateSessionInput,
  type EventMeta,
  type FileChange,
  type KernelEvent,
  type PermissionDecision,
  type PromptAck,
  type PromptInput,
  type RespondPermissionInput,
  type SessionDetail,
  type SessionId,
  type SessionSummary,
  type TerminalCreateAck,
  type TerminalCreateInput,
  type TerminalId,
  type TerminalInputInput,
  type TerminalResizeInput,
  type ToolCallId
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
}

/** Deterministic per-token delays (ms), cycled to keep streaming inside 50–100ms. */
const TOKEN_DELAYS_MS = [60, 85, 70, 95] as const

const WORKSPACE_CWD = 'D:/2026/FlexAgent'
const MAX_TERMINALS_PER_SESSION = 4

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

  constructor() {
    this.addFixtureSession('Implement API contract', Date.UTC(2026, 8, 21, 9, 30), [
      ['user', 'Help me wire the IPC contract into the renderer'],
      ['assistant', 'I will read the shared contract first and map the command surface.']
    ])
    this.addFixtureSession('Sidebar shell layout', Date.UTC(2026, 8, 21, 15, 0), [])
    this.addFixtureSession('Diff review panel', Date.UTC(2026, 8, 20, 11, 0), [])
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.values()].map((session) => ({ ...session.summary }))
  }

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    const cwd = typeof input?.cwd === 'string' ? input.cwd.trim() : ''
    if (cwd.length === 0) {
      throw new ContractError('INVALID_INPUT', 'createSession requires a non-empty cwd')
    }
    this.sessionCounter += 1
    const now = Date.now()
    const summary: SessionSummary = {
      id: `sess_${this.sessionCounter}`,
      title: input.title?.trim() || 'New chat',
      cwd,
      createdAt: now,
      updatedAt: now,
      runState: 'idle'
    }
    this.sessions.set(summary.id, this.newSessionState(summary))
    return { ...summary }
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
      terminals: new Map()
    }
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
      cwd: WORKSPACE_CWD,
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
