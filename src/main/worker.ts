import { parentPort } from 'worker_threads'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import {
  ContractError,
  type ChatMessage,
  type FileChange,
  type ModelConfig,
  type ModelOption,
  type PermissionDecision,
  type PromptDisposition,
  type RunState,
  type SessionId,
  type ThinkingLevel,
  type ToolCallId
} from '../shared/contract'
import type { WorkerKernelEvent, WorkerRequest, WorkerResponse } from '../shared/kernel-protocol'
import type { AgentSession, SessionManager as SessionManagerType } from '@earendil-works/pi-coding-agent'

/**
 * PI package is ESM-only (`exports.import` only). electron-vite emits this
 * worker as CJS, and `require()` throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Dynamic `import()` loads the ESM graph correctly from CJS.
 */
type PiModule = typeof import('@earendil-works/pi-coding-agent')
let piPromise: Promise<PiModule> | null = null

function loadPi(): Promise<PiModule> {
  piPromise ??= import('@earendil-works/pi-coding-agent')
  return piPromise
}

const port = parentPort
if (!port) {
  throw new Error('worker.ts must run as a worker_thread')
}

const AUTO_ALLOW_TOOLS = new Set(['read', 'ls', 'grep', 'find'])
const FILE_TOOLS = new Set(['edit', 'write'])

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void
}

interface WriteSnapshot {
  absPath: string
  relPath: string
  oldContent: string | null
  newContent: string
}

interface HostSession {
  session: AgentSession
  sessionId: SessionId
  cwd: string
  unsubscribe: () => void
  runState: RunState
  allowSessionNames: Set<string>
  allowOnceIds: Set<ToolCallId>
  pending: Map<ToolCallId, PendingPermission>
  fileChanges: Map<string, FileChange>
  writeSnapshots: Map<ToolCallId, WriteSnapshot>
}

const sessions = new Map<SessionId, HostSession>()

function emit(sessionId: SessionId, event: WorkerKernelEvent): void {
  port!.postMessage({ type: 'event', sessionId, event } satisfies WorkerResponse)
}

function fail(requestId: string, code: ContractError['code'], message: string, details?: unknown): void {
  port!.postMessage({ requestId, type: 'fail', code, message, details } satisfies WorkerResponse)
}

function ok(requestId: string, result?: unknown): void {
  port!.postMessage({ requestId, type: 'ok', result } satisfies WorkerResponse)
}

function requireSession(sessionId: SessionId): HostSession {
  const host = sessions.get(sessionId)
  if (!host) throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`)
  return host
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

let modelRuntimePromise: Promise<import('@earendil-works/pi-coding-agent').ModelRuntime> | null =
  null

async function getModelRuntime(): Promise<import('@earendil-works/pi-coding-agent').ModelRuntime> {
  modelRuntimePromise ??= (async () => {
    const { ModelRuntime } = await loadPi()
    return ModelRuntime.create()
  })()
  return modelRuntimePromise
}

function toModelOption(model: {
  provider: string
  id: string
  name?: string
  label?: string
}): ModelOption {
  const label = model.name ?? model.label
  return label && label !== model.id
    ? { provider: model.provider, id: model.id, label }
    : { provider: model.provider, id: model.id }
}

function readModelConfig(session: AgentSession): ModelConfig {
  const model = session.model
  const base = {
    model: model ? toModelOption(model) : null,
    thinkingLevel: session.thinkingLevel
  }
  if (!model) return base
  try {
    const levels = session.getAvailableThinkingLevels()
    return levels.length > 0 ? { ...base, availableThinkingLevels: levels } : base
  } catch {
    return base
  }
}

function assertThinkingLevel(level: unknown): ThinkingLevel {
  if (typeof level !== 'string' || !THINKING_LEVELS.has(level as ThinkingLevel)) {
    throw new ContractError('INVALID_INPUT', `Invalid thinkingLevel: ${String(level)}`)
  }
  return level as ThinkingLevel
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: 'text'; text: string } => !!c && typeof c === 'object' && (c as { type?: string }).type === 'text')
      .map((c) => c.text)
      .join('')
  }
  return ''
}

function messageText(msg: { content?: unknown }): string {
  return contentToText(msg.content)
}

function toChatMessage(msg: { role?: string; content?: unknown; timestamp?: number; responseId?: string }): ChatMessage | null {
  const role = msg.role
  if (role !== 'user' && role !== 'assistant') return null
  const text = messageText(msg)
  const ts = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
  const id = `${role}:${ts}:${text.slice(0, 64)}`
  return { id, role, content: text, createdAt: ts }
}

function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function emitFileChanges(host: HostSession): void {
  emit(host.sessionId, {
    type: 'file_changes',
    sessionId: host.sessionId,
    ts: Date.now(),
    files: [...host.fileChanges.values()]
  })
}

function upsertFileChange(host: HostSession, file: FileChange): void {
  host.fileChanges.set(file.path, file)
  emitFileChanges(host)
}

function setRunState(host: HostSession, runState: RunState): void {
  if (host.runState === runState) return
  host.runState = runState
  emit(host.sessionId, {
    type: 'run_state',
    sessionId: host.sessionId,
    ts: Date.now(),
    runState
  })
}

function toolArgsForDisplay(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return { ...(args as Record<string, unknown>) }
  }
  return { value: args }
}

function summarizeResult(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined
  if (typeof result === 'string') return result.slice(0, 200)
  const content = (result as { content?: unknown }).content
  const text = contentToText(content).trim()
  if (text) return text.slice(0, 200)
  try {
    return JSON.stringify(result).slice(0, 200)
  } catch {
    return undefined
  }
}

function extractPatchDetails(result: unknown): { patch?: unknown; diff?: unknown } {
  if (result && typeof result === 'object') {
    const details = (result as { details?: unknown }).details
    if (details && typeof details === 'object') {
      return details as { patch?: unknown; diff?: unknown }
    }
  }
  return {}
}

function setupPermissionGate(host: HostSession): void {
  host.session.agent.beforeToolCall = async (ctx) => {
    const toolCallId = ctx.toolCall.id
    const name = ctx.toolCall.name

    if (AUTO_ALLOW_TOOLS.has(name) || host.allowSessionNames.has(name)) return undefined
    if (host.allowOnceIds.delete(toolCallId)) return undefined

    emit(host.sessionId, {
      type: 'permission_request',
      sessionId: host.sessionId,
      ts: Date.now(),
      toolCallId,
      name,
      label: name,
      args: toolArgsForDisplay(ctx.args),
      reason: `Kernel requires approval for tool "${name}"`
    })

    const decision = await new Promise<PermissionDecision>((resolvePromise) => {
      host.pending.set(toolCallId, { resolve: resolvePromise })
    })

    if (decision === 'allowSession') {
      host.allowSessionNames.add(name)
      return undefined
    }
    if (decision === 'allowOnce') {
      host.allowOnceIds.add(toolCallId)
      return undefined
    }
    return { block: true, reason: 'User denied this tool call' }
  }
}

async function handleAgentEvent(host: HostSession, raw: { type?: string; [k: string]: unknown }): Promise<void> {
  const sessionId = host.sessionId
  const meta = { sessionId, ts: Date.now() } as const

  switch (raw.type) {
    case 'agent_start': {
      // New run: file_changes is a per-run full snapshot (contract §3.2.5).
      host.fileChanges.clear()
      host.writeSnapshots.clear()
      emitFileChanges(host)
      setRunState(host, 'running')
      break
    }
    case 'agent_settled': {
      setRunState(host, 'idle')
      break
    }
    case 'message_start': {
      const message = raw.message as { role?: string } | undefined
      if (message?.role === 'user') {
        const chat = toChatMessage(message as never)
        if (chat) emit(sessionId, { type: 'user_message', ...meta, message: chat })
      }
      break
    }
    case 'message_update': {
      const evt = raw.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (evt?.type === 'text_delta' && typeof evt.delta === 'string' && evt.delta.length > 0) {
        emit(sessionId, { type: 'text_delta', ...meta, delta: evt.delta })
      }
      break
    }
    case 'message_end': {
      const chat = toChatMessage(raw.message as never)
      if (chat) emit(sessionId, { type: 'message_end', ...meta, message: chat })
      break
    }
    case 'tool_execution_start': {
      const toolCallId = String(raw.toolCallId ?? '')
      const name = String(raw.toolName ?? 'tool')
      const args = raw.args
      emit(sessionId, {
        type: 'tool_start',
        ...meta,
        toolCallId,
        name,
        label: name,
        args: toolArgsForDisplay(args)
      })
      if (FILE_TOOLS.has(name) && name === 'write' && args && typeof args === 'object') {
        const a = args as { path?: string; content?: string }
        if (typeof a.path === 'string') {
          const absPath = isAbsolute(a.path) ? a.path : resolve(host.cwd, a.path)
          const relPath = toPosix(relative(host.cwd, absPath))
          const existed = existsSync(absPath)
          host.writeSnapshots.set(toolCallId, {
            absPath,
            relPath,
            oldContent: existed ? readFileSync(absPath, 'utf8') : null,
            newContent: typeof a.content === 'string' ? a.content : ''
          })
        }
      }
      break
    }
    case 'tool_execution_update': {
      const toolCallId = String(raw.toolCallId ?? '')
      const partial = raw.partialResult
      let chunk = ''
      if (typeof partial === 'string') chunk = partial
      else if (partial && typeof partial === 'object') {
        const maybe = partial as { output?: unknown; text?: unknown; chunk?: unknown }
        if (typeof maybe.chunk === 'string') chunk = maybe.chunk
        else if (typeof maybe.output === 'string') chunk = maybe.output
        else if (typeof maybe.text === 'string') chunk = maybe.text
        else {
          try {
            chunk = JSON.stringify(partial)
          } catch {
            chunk = ''
          }
        }
      }
      if (chunk) emit(sessionId, { type: 'tool_update', ...meta, toolCallId, chunk })
      break
    }
    case 'tool_execution_end': {
      const toolCallId = String(raw.toolCallId ?? '')
      const name = String(raw.toolName ?? 'tool')
      const isError = Boolean(raw.isError)
      const result = raw.result

      if (!isError && FILE_TOOLS.has(name)) {
        const args = raw.args as { path?: string } | undefined
        const details = extractPatchDetails(result)

        if (name === 'edit' && typeof details.patch === 'string' && typeof args?.path === 'string') {
          const absPath = isAbsolute(args.path) ? args.path : resolve(host.cwd, args.path)
          const relPath = toPosix(relative(host.cwd, absPath))
          const { additions, deletions } = countPatch(details.patch)
          upsertFileChange(host, {
            path: relPath,
            status: 'modified',
            additions,
            deletions,
            patch: details.patch
          })
        } else         if (name === 'write') {
          const snap = host.writeSnapshots.get(toolCallId)
          host.writeSnapshots.delete(toolCallId)
          if (snap) {
            const { generateUnifiedPatch } = await loadPi()
            const patch = generateUnifiedPatch(snap.relPath, snap.oldContent ?? '', snap.newContent)
            const { additions, deletions } = countPatch(patch)
            upsertFileChange(host, {
              path: snap.relPath,
              status: snap.oldContent === null ? 'added' : 'modified',
              additions,
              deletions,
              patch
            })
          }
        }
      }

      emit(sessionId, {
        type: 'tool_end',
        ...meta,
        toolCallId,
        isError,
        summary: summarizeResult(result)
      })
      break
    }
    default:
      break
  }
}

function buildMessages(session: AgentSession): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const msg of session.messages) {
    const chat = toChatMessage(msg as never)
    if (chat && (chat.content || chat.role === 'user')) out.push(chat)
  }
  return out
}

async function attachSession(
  sessionId: SessionId,
  cwd: string,
  sessionManager: SessionManagerType
): Promise<HostSession> {
  const { createAgentSession } = await loadPi()
  const { session } = await createAgentSession({ cwd, sessionManager })
  const host: HostSession = {
    session,
    sessionId,
    cwd,
    unsubscribe: () => {},
    runState: session.isStreaming ? 'running' : 'idle',
    allowSessionNames: new Set(),
    allowOnceIds: new Set(),
    pending: new Map(),
    fileChanges: new Map(),
    writeSnapshots: new Map()
  }
  host.unsubscribe = session.subscribe((event) => {
    void handleAgentEvent(host, event as unknown as { type?: string })
  })
  setupPermissionGate(host)
  sessions.set(sessionId, host)
  if (host.runState === 'running') setRunState(host, 'running')
  return host
}

async function handleRequest(req: WorkerRequest): Promise<unknown> {
  switch (req.type) {
    case 'listSessions': {
      return [...sessions.keys()]
    }
    case 'createSession': {
      if (!req.cwd || !isAbsolute(req.cwd)) {
        throw new ContractError('INVALID_INPUT', 'cwd must be an absolute path')
      }
      if (sessions.has(req.sessionId)) {
        const existing = sessions.get(req.sessionId)!
        return { piSessionFile: existing.session.sessionFile }
      }
      const { SessionManager } = await loadPi()
      const host = await attachSession(req.sessionId, req.cwd, SessionManager.create(req.cwd))
      return { piSessionFile: host.session.sessionFile }
    }
    case 'openSession': {
      const existing = sessions.get(req.sessionId)
      if (existing) {
        return { messages: buildMessages(existing.session) }
      }
      if (!req.piSessionFile) {
        return { messages: [] }
      }
      const { SessionManager } = await loadPi()
      const sessionManager = SessionManager.open(req.piSessionFile, undefined, req.cwd)
      const host = await attachSession(req.sessionId, req.cwd, sessionManager)
      return { messages: buildMessages(host.session) }
    }
    case 'prompt': {
      const host = requireSession(req.sessionId)
      const text = req.text
      const streaming = host.session.isStreaming
      let disposition: PromptDisposition
      if (!streaming) disposition = 'started'
      else if (req.disposition === 'queued') disposition = 'queued'
      else disposition = 'steering'

      // Contract §3.1.1: resolve when accepted (preflightResult), not when the run ends.
      // PI prompt() awaits the full run after preflight(true) on the started path.
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let accepted = false
        const preflightResult = (success: boolean): void => {
          if (settled) return
          settled = true
          accepted = success
          if (success) resolve()
          else reject(new ContractError('INVALID_INPUT', 'Prompt rejected before run start'))
        }
        const opts = streaming
          ? {
              streamingBehavior: disposition === 'queued' ? ('followUp' as const) : ('steer' as const),
              preflightResult
            }
          : { preflightResult }
        host.session.prompt(text, opts).then(
          () => {
            if (!settled) {
              settled = true
              accepted = true
              resolve()
            }
          },
          (err: unknown) => {
            if (accepted) {
              // Post-acceptance failure: surface as error event; agent_settled still drives idle.
              emit(host.sessionId, {
                type: 'error',
                sessionId: host.sessionId,
                ts: Date.now(),
                code: 'KERNEL_INTERNAL',
                message: err instanceof Error ? err.message : String(err)
              })
              return
            }
            if (settled) return // preflight already rejected; swallow duplicate
            settled = true
            reject(
              err instanceof ContractError
                ? err
                : new ContractError('KERNEL_INTERNAL', err instanceof Error ? err.message : String(err))
            )
          }
        )
      })
      setRunState(host, 'running')
      return { disposition }
    }
    case 'abort': {
      const host = requireSession(req.sessionId)
      await host.session.abort()
      // abort() waits for idle; belt-and-suspenders if agent_settled was missed.
      setRunState(host, 'idle')
      return undefined
    }
    case 'respondPermission': {
      const host = requireSession(req.sessionId)
      const pending = host.pending.get(req.toolCallId)
      if (!pending) {
        throw new ContractError('PERMISSION_EXPIRED', `No pending permission for ${req.toolCallId}`)
      }
      host.pending.delete(req.toolCallId)
      pending.resolve(req.decision)
      return undefined
    }
    case 'disposeSession': {
      const host = sessions.get(req.sessionId)
      if (!host) return undefined
      host.unsubscribe()
      for (const p of host.pending.values()) p.resolve('deny')
      host.pending.clear()
      host.session.dispose()
      sessions.delete(req.sessionId)
      return undefined
    }
    case 'listModels': {
      const runtime = await getModelRuntime()
      const available = await runtime.getAvailable()
      return available.map((m) => toModelOption(m))
    }
    case 'getModelConfig': {
      const host = requireSession(req.sessionId)
      return readModelConfig(host.session)
    }
    case 'setModel': {
      const host = requireSession(req.sessionId)
      if (typeof req.provider !== 'string' || !req.provider || typeof req.id !== 'string' || !req.id) {
        throw new ContractError('INVALID_INPUT', 'provider and id are required')
      }
      const runtime = host.session.modelRuntime
      const model = runtime.getModel(req.provider, req.id)
      if (!model) {
        throw new ContractError('INVALID_INPUT', `Unknown model: ${req.provider}/${req.id}`)
      }
      await host.session.setModel(model, { persist: false })
      if (req.thinkingLevel !== undefined) {
        host.session.setThinkingLevel(assertThinkingLevel(req.thinkingLevel), { persist: false })
      }
      return readModelConfig(host.session)
    }
    case 'setThinkingLevel': {
      const host = requireSession(req.sessionId)
      host.session.setThinkingLevel(assertThinkingLevel(req.level), { persist: false })
      return readModelConfig(host.session)
    }
    case 'shutdown': {
      for (const [id, host] of [...sessions]) {
        host.unsubscribe()
        for (const p of host.pending.values()) p.resolve('deny')
        host.pending.clear()
        try {
          host.session.dispose()
        } catch {
          // dispose can race with in-flight agent teardown
        }
        sessions.delete(id)
      }
      setTimeout(() => process.exit(0), 10)
      return undefined
    }
    default: {
      throw new ContractError('INVALID_INPUT', 'Unknown worker request')
    }
  }
}

port.on('message', (req: WorkerRequest) => {
  void handleRequest(req)
    .then((result) => ok(req.requestId, result))
    .catch((err: unknown) => {
      if (err instanceof ContractError) {
        fail(req.requestId, err.code, err.message, err.details)
      } else {
        fail(req.requestId, 'KERNEL_INTERNAL', err instanceof Error ? err.message : String(err))
      }
    })
})
