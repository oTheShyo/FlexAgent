import { parentPort } from 'worker_threads'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { enableCompileCache } from 'node:module'
import {
  ContractError,
  type ChatMessage,
  type FileChange,
  type ModelConfig,
  type ModelOption,
  type PermissionDecision,
  type PromptDisposition,
  type RoutingState,
  type RunState,
  type SessionId,
  type SessionSearchHit,
  type ThinkingLevel,
  type ToolCallId,
  type UsageReport
} from '../shared/contract'
import type {
  WorkerKernelEvent,
  WorkerRequest,
  WorkerResponse,
  NetworkStatus,
  PluginResourceSpec,
  PluginMcpServerConfig
} from '../shared/kernel-protocol'
import type {
  AgentSession,
  DefaultResourceLoader as DefaultResourceLoaderType,
  SessionManager as SessionManagerType
} from '@earendil-works/pi-coding-agent'
import { createPluginBridgeFactory, type PluginHookDeps, type McpToolBridgeDef, type McpToolBridgeResult } from './pluginBridge'
import { parseHooksContent } from './hookSources'
import { perfStart } from './perf'
import { interpolateHookTemplate } from './userConfig'
import { runHook, type HookRunOptions, type HookRunResult } from './hooks/hookRunner'
import {
  createSelfEvolutionExtension,
  flushPendingMemoryWrites,
  SKILLS_HOME
} from './skills/selfEvolution'
import { buildJudgePrompt, parseJudgeReply } from './skills/memoryDedupe'
import { buildUsageReport, resolveRoleModel, resolveRoles } from './modelRoles'
import { createCompactionRoutingExtension } from './compactionRouting'
import { loadKernelHttp } from './kernelHttp'
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from './kernelSettings'
import { readJsonDocument } from './jsonFile'
import {
  connectMcpClient,
  listMcpTools,
  callMcpTool,
  closeMcpClient,
  toMcpToolName,
  type McpClientHandle,
  type McpToolDescriptor
} from './mcp/mcpClient'

/**
 * PI package is ESM-only (`exports.import` only). electron-vite emits this
 * worker as CJS, and `require()` throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Dynamic `import()` loads the ESM graph correctly from CJS.
 */
type PiModule = typeof import('@earendil-works/pi-coding-agent')
let piPromise: Promise<PiModule> | null = null

/**
 * Same V8 compile cache the main process enables. Worker threads share the
 * process-wide cache directory, so this is belt-and-braces for the case where
 * the worker is ever run on its own.
 */
const compileCacheDir = process.env.FLEXAGENT_COMPILE_CACHE
if (compileCacheDir) {
  try {
    enableCompileCache(compileCacheDir)
  } catch {
    // Optimisation only — a failure here must not stop the worker from booting.
  }
}

function loadPi(): Promise<PiModule> {
  piPromise ??= import('@earendil-works/pi-coding-agent')
  return piPromise
}

let pluginResourceSpec: PluginResourceSpec = {
  extensionPaths: [],
  skillRoots: [],
  commands: [],
  hooks: [],
  hookContexts: {},
  mcp: [],
  pluginStorageRoot: ''
}

const inflightHookRuns = new Set<Promise<unknown>>()

function trackedRunHook(options: HookRunOptions): Promise<HookRunResult> {
  const tracked = runHook(options).finally(() => {
    inflightHookRuns.delete(tracked)
  })
  inflightHookRuns.add(tracked)
  return tracked
}

const hookDeps: PluginHookDeps = {
  parseHooksContent,
  interpolate: interpolateHookTemplate,
  runHook: trackedRunHook
}

async function settleHookRuns(): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50))
  if (inflightHookRuns.size === 0) return
  await Promise.race([
    Promise.allSettled([...inflightHookRuns]),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 2000))
  ])
}

const inflightMcpCalls = new Set<Promise<unknown>>()
const mcpClients: McpClientHandle[] = []
let mcpStartupPromise: Promise<McpToolBridgeDef[]> | undefined

interface McpToolEntry {
  bridgeName: string
  serverKey: string
  tool: McpToolDescriptor
  handle: McpClientHandle
  config: PluginMcpServerConfig
}

/** All discovered MCP tools (proxy + direct); registry for the single `mcp` proxy tool. */
const mcpToolRegistry: McpToolEntry[] = []
/** Servers that failed to connect at bridge startup, keyed by serverKey (reported via mode="status"). */
const mcpServerErrors = new Map<string, string>()

/**
 * Timestamp of the last request that came from the UI. Warmup work is pure
 * speculation, so it must never compete with a real user action for this single
 * thread: measured, an attach running next to a warmup takes 3-4x longer
 * (`getAvailable` went 20ms -> 5787ms), which is worse than not warming at all.
 */
let lastUserRequestAt = Date.now()

/** How many UI-originated requests are currently being served. */
let userRequestsInFlight = 0

/**
 * Wait until the UI has no request in flight and none has arrived for
 * `quietMs`. Checking in-flight matters: the first request of a launch runs for
 * several seconds (loading PI, attaching a session), and a purely time-based
 * check mistakes that silence for idleness — starting a warmup then makes the
 * very request it was meant to speed up 1.5x slower.
 */
async function waitForQuiet(quietMs: number, timeoutMs = 25000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (userRequestsInFlight === 0 && Date.now() - lastUserRequestAt >= quietMs) return true
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100))
  }
  return false
}

async function settleMcpCalls(): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50))
  if (inflightMcpCalls.size === 0) return
  await Promise.race([
    Promise.allSettled([...inflightMcpCalls]),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 2000))
  ])
}

function mapMcpToolResult(result: unknown): McpToolBridgeResult {
  const blocks: Array<{ type: 'text'; text: string }> = []
  const record =
    result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : undefined
  if (record && Array.isArray(record.content)) {
    for (const block of record.content as unknown[]) {
      if (block === null || typeof block !== 'object') continue
      const entry = block as Record<string, unknown>
      if (entry.type === 'text' && typeof entry.text === 'string' && entry.text.length > 0) {
        blocks.push({ type: 'text', text: entry.text })
      }
    }
  }
  const structured = record?.structuredContent
  if (
    structured !== null &&
    typeof structured === 'object' &&
    Object.keys(structured as Record<string, unknown>).length > 0
  ) {
    blocks.push({
      type: 'text',
      text: `Structured content:\n${JSON.stringify(structured, null, 2)}`
    })
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: JSON.stringify(result) })
  }
  const text = blocks.map((block) => block.text).join('\n\n')
  return {
    content: [{ type: 'text', text: record?.isError === true ? `MCP tool returned an error:\n${text}` : text }],
    details: undefined
  }
}

function trackMcpCall(promise: Promise<unknown>): Promise<unknown> {
  const tracked = promise.finally(() => {
    inflightMcpCalls.delete(tracked)
  })
  inflightMcpCalls.add(tracked)
  return tracked
}

function findMcpEntry(name: string | undefined): McpToolEntry | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const exact = mcpToolRegistry.find((entry) => entry.bridgeName === name)
  if (exact) return exact
  const loose = mcpToolRegistry.filter(
    (entry) => entry.bridgeName.endsWith(`__${name}`) || entry.tool.name === name
  )
  return loose.length === 1 ? loose[0] : undefined
}

function buildMcpProxyDef(): McpToolBridgeDef {
  return {
    name: 'mcp',
    label: 'MCP',
    description:
      'Discover and call tools from configured MCP servers. ' +
      'mode="search": list matching tools (space-separated keywords, OR; empty = all). ' +
      'mode="describe" + tool: full input schema of one tool. ' +
      'mode="call" + tool + args: execute a tool. ' +
      'mode="status": server connectivity and tool counts.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['search', 'describe', 'call', 'status'],
          description: 'Which MCP proxy operation to perform'
        },
        query: {
          type: 'string',
          description:
            'search: space-separated keywords (OR) matched against tool names, descriptions, and server keys'
        },
        tool: {
          type: 'string',
          description: 'describe/call: exact tool name as returned by search (mcp__<server>__<tool>)'
        },
        args: {
          type: 'object',
          description: 'call: arguments object matching the tool input schema (see describe)'
        }
      },
      required: ['mode']
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const params =
        rawParams !== null && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {}
      const mode = typeof params.mode === 'string' ? params.mode : ''
      if (mode === 'status') {
        const lines: string[] = []
        const byServer = new Map<string, { type: string; count: number }>()
        for (const entry of mcpToolRegistry) {
          const current = byServer.get(entry.serverKey)
          if (current) current.count += 1
          else byServer.set(entry.serverKey, { type: entry.config.type, count: 1 })
        }
        for (const [serverKey, info] of byServer) {
          lines.push(`- ${serverKey} [${info.type}]: connected, ${info.count} tool(s)`)
        }
        for (const [serverKey, message] of mcpServerErrors) {
          lines.push(`- ${serverKey}: UNAVAILABLE — ${message}`)
        }
        if (lines.length === 0) lines.push('No MCP servers configured.')
        return { content: [{ type: 'text', text: lines.join('\n') }], details: undefined }
      }
      if (mode === 'search') {
        const query = typeof params.query === 'string' ? params.query.toLowerCase() : ''
        const words = query.split(/\s+/).filter((word) => word.length > 0)
        const matched = mcpToolRegistry.filter((entry) => {
          if (words.length === 0) return true
          const haystack =
            `${entry.bridgeName} ${entry.tool.name} ${entry.tool.description ?? ''} ${entry.serverKey}`.toLowerCase()
          return words.some((word) => haystack.includes(word))
        })
        if (matched.length === 0) {
          return {
            content: [
              { type: 'text', text: 'No matching MCP tools. Use mode="status" to see server health.' }
            ],
            details: undefined
          }
        }
        const lines = matched.map((entry) => {
          const desc = entry.tool.description ? ` — ${entry.tool.description}` : ''
          return `- ${entry.bridgeName}${desc}`
        })
        return { content: [{ type: 'text', text: lines.join('\n') }], details: undefined }
      }
      if (mode === 'describe' || mode === 'call') {
        const entry = findMcpEntry(typeof params.tool === 'string' ? params.tool : undefined)
        if (!entry) {
          return {
            content: [
              {
                type: 'text',
                text: `Unknown MCP tool: ${String(params.tool ?? '')}. Use mode="search" first.`
              }
            ],
            details: undefined
          }
        }
        if (mode === 'describe') {
          const text = [
            `${entry.bridgeName} (server: ${entry.serverKey})`,
            entry.tool.description ? `Description: ${entry.tool.description}` : undefined,
            `Input schema:\n${JSON.stringify(
              entry.tool.inputSchema ?? { type: 'object', properties: {} },
              null,
              2
            )}`
          ]
            .filter((line) => line !== undefined)
            .join('\n')
          return { content: [{ type: 'text', text }], details: undefined }
        }
        const result = await trackMcpCall(
          callMcpTool(entry.handle, entry.tool.name, params.args, entry.config.timeoutMs, signal)
        )
        return mapMcpToolResult(result)
      }
      return {
        content: [
          { type: 'text', text: `Unknown mode "${mode}". Use search, describe, call, or status.` }
        ],
        details: undefined
      }
    }
  }
}

async function startMcpToolBridge(): Promise<McpToolBridgeDef[]> {
  const servers = pluginResourceSpec.mcpServers ?? {}
  const defs: McpToolBridgeDef[] = []
  const seen = new Set<string>()
  mcpToolRegistry.length = 0
  mcpServerErrors.clear()
  let hasProxyServers = false
  for (const [serverKey, config] of Object.entries(servers)) {
    try {
      const handle = await connectMcpClient(config, serverKey)
      mcpClients.push(handle)
      const listed = await listMcpTools(handle)
      for (const tool of listed) {
        const toolName = toMcpToolName(serverKey, tool.name)
        if (seen.has(toolName)) continue
        seen.add(toolName)
        const entry: McpToolEntry = { bridgeName: toolName, serverKey, tool, handle, config }
        mcpToolRegistry.push(entry)
        if (config.expose === 'direct') {
          defs.push({
            name: toolName,
            label: tool.name,
            description: tool.description ?? `MCP tool from ${serverKey}`,
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            execute: async (_toolCallId, params, signal) => {
              const result = await trackMcpCall(
                callMcpTool(handle, tool.name, params, config.timeoutMs, signal)
              )
              return mapMcpToolResult(result)
            }
          })
        } else {
          hasProxyServers = true
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      mcpServerErrors.set(serverKey, message)
      console.error(`[worker] MCP server ${serverKey} unavailable: ${message}`)
    }
  }
  if (hasProxyServers) {
    defs.push(buildMcpProxyDef())
  }
  return defs
}

function resetMcpBridge(): void {
  for (const client of mcpClients) {
    void closeMcpClient(client)
  }
  mcpClients.length = 0
  mcpToolRegistry.length = 0
  mcpServerErrors.clear()
  mcpStartupPromise = undefined
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

/**
 * Proxy variables that were already set before this process touched anything.
 * PI's `applyHttpProxySettings` only fills these in when they are empty, so an
 * ambient value wins over the setting — captured once so the UI can say which
 * one is in charge instead of showing a field that loses silently.
 */
const ambientProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null

/** The proxy this worker installed itself, so clearing the setting can undo it. */
let installedProxy: string | null = null

/** PI's own settings path. Not derived outside the worker — the agent dir is PI's. */
async function kernelSettingsPath(): Promise<string> {
  const { getAgentDir } = await loadPi()
  return join(getAgentDir(), 'settings.json')
}

const DISPATCHER_MISSING =
  "The kernel's HTTP dispatcher could not be located inside the installed kernel package, so a proxy cannot be installed from here. The idle timeout and retry settings still apply — they go through the kernel's own settings."

async function networkStatus(): Promise<NetworkStatus> {
  const http = await loadKernelHttp()
  return http === null
    ? { dispatcher: 'unavailable', envProxy: ambientProxy, note: DISPATCHER_MISSING }
    : { dispatcher: 'installed', envProxy: ambientProxy }
}

/**
 * Make the stored network settings true *in this process*.
 *
 * PI only calls `applyHttpProxySettings`/`configureHttpDispatcher` from its CLI
 * entry point, which this app never runs, so the SDK path has no proxy at all —
 * Node's default dispatcher ignores the proxy environment variables. Everything
 * here is therefore done by hand, and the result is reported rather than assumed.
 */
async function applyNetwork(proxy: string, idleTimeoutMs: number): Promise<NetworkStatus> {
  const base = await networkStatus()
  const http = await loadKernelHttp()
  let status: NetworkStatus = base
  if (http !== null) {
    try {
      if (proxy.length > 0) {
        http.applyProxy(proxy)
        installedProxy = proxy
      } else if (installedProxy !== null) {
        // Only remove what we put there: a variable the user really exported must
        // survive clearing the setting.
        for (const name of ['HTTP_PROXY', 'HTTPS_PROXY'] as const) {
          if (process.env[name] === installedProxy) delete process.env[name]
        }
        installedProxy = null
      }
      // Re-created each time: the dispatcher reads the proxy variables and the
      // idle timeout at construction, so a change needs a new one.
      http.configureDispatcher(idleTimeoutMs)
    } catch (err) {
      status = {
        ...base,
        dispatcher: 'unavailable',
        note: `The kernel refused the network settings (${err instanceof Error ? err.message : String(err)}).`
      }
    }
  }
  // The file was already written; a *running* session only notices once its own
  // SettingsManager re-reads it, and it reads per request. Without this, a new
  // timeout or retry budget would sit on disk unused until the session is
  // re-attached — the same "written ≠ in effect" trap as a custom model.
  await reloadSessionSettings()
  return status
}

/**
 * Re-read the kernel settings for every attached session. Failures are per
 * session: one broken session must not stop the others from picking up a change.
 */
async function reloadSessionSettings(): Promise<void> {
  await Promise.all(
    [...sessions.values()].map(async (host) => {
      try {
        await host.session.settingsManager.reload()
      } catch {
        // A disposed session can throw here; nothing to report, nothing to fix.
      }
    })
  )
}

/**
 * Apply the stored proxy and idle timeout once, before the first session can
 * make a request. Doing it lazily (instead of in `applyNetwork`) means a proxy
 * saved in a previous run is already in force when the window reopens — a
 * setting that only works until you restart is not a setting.
 */
let networkBoot: Promise<void> | null = null
function ensureNetworkApplied(): Promise<void> {
  networkBoot ??= (async () => {
    let proxy = ''
    let idle = DEFAULT_HTTP_IDLE_TIMEOUT_MS
    try {
      // Same tolerant read the models service uses: the kernel's own file may
      // carry comments, and a hand-edited one must not silently disable this.
      const root = readJsonDocument(await kernelSettingsPath(), 'settings.json').root
      const stored = root.httpProxy
      if (typeof stored === 'string') proxy = stored.trim()
      const timeout = root.httpIdleTimeoutMs
      if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0) idle = timeout
    } catch {
      // No settings file yet, or unreadable — leave the process as it is.
    }
    try {
      await applyNetwork(proxy, idle)
    } catch {
      // applyNetwork already reports failures through its return value.
    }
  })()
  return networkBoot
}


const MEMORY_JUDGE_SYSTEM_PROMPT = [
  'You decide whether a new note duplicates an existing one.',
  'They are duplicates when a reader would act identically knowing either one.',
  'They are NOT duplicates merely for mentioning the same topic.',
  'Reply with only the number of the duplicate entry, or 0 if it is genuinely new.'
].join(' ')

/**
 * Same rule as the permission chain's classifier, for the same measured reason:
 * a reasoning model spends its whole budget thinking and returns no answer.
 *
 * Duplicated rather than shared — that helper belongs to another track's pending
 * work, and depending on it would tie this change to a landing order.
 * The model type is derived from the runtime itself so it tracks whatever the
 * kernel calls it, rather than a local alias that may move.
 */
type JudgeModel = Parameters<
  import('@earendil-works/pi-coding-agent').ModelRuntime['completeSimple']
>[0]

function pickJudgeModel(snapshot: readonly JudgeModel[]): JudgeModel | undefined {
  return snapshot.find((model) => (model as { reasoning?: boolean }).reasoning !== true) ?? snapshot[0]
}

/**
 * Duplicate decisions for memory cards — one small model call per candidate
 * batch, never for cards the rules already settled.
 *
 * Failures mean "no duplicate", i.e. the card gets written. Duplicates are
 * cheap to prune later; a fact the user loses because a judge was unavailable
 * is not.
 */
const DUPLICATE_COOLDOWN_MS = 60_000
let duplicateJudgeDisabledUntil = 0

async function judgeMemoryDuplicate(
  newText: string,
  candidates: string[]
): Promise<number | null> {
  if (candidates.length === 0) return null
  if (Date.now() < duplicateJudgeDisabledUntil) return null
  try {
    const runtime = await getModelRuntime()
    const model = pickJudgeModel(runtime.getAvailableSnapshot())
    if (!model) return null
    const prompt = buildJudgePrompt(newText, candidates)
    const reply = await runtime.completeSimple(
      model,
      {
        systemPrompt: MEMORY_JUDGE_SYSTEM_PROMPT,
        messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }]
      },
      { maxTokens: 8, temperature: 0 }
    )
    const blocks = Array.isArray(reply?.content) ? reply.content : []
    const text = String(blocks.map((block) => (block as { text?: unknown })?.text ?? '')).trim()
    if (!text) {
      duplicateJudgeDisabledUntil = Date.now() + DUPLICATE_COOLDOWN_MS
      return null
    }
    return parseJudgeReply(text, candidates.length)
  } catch {
    duplicateJudgeDisabledUntil = Date.now() + DUPLICATE_COOLDOWN_MS
    return null
  }
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

/**
 * Resource loaders are bound to a cwd and expensive to build: reload() resolves
 * the package graph, loads every extension module and re-reads the project
 * context files. That was ~4s per attach here — paid again for every New chat
 * and every switch to a session this worker had not attached yet.
 *
 * Sessions sharing a folder now share one loader. Different folders still get
 * their own, and reloadPlugins drops the whole cache because plugin-provided
 * extensions and skills are baked in at construction time.
 */
const resourceLoaders = new Map<string, Promise<DefaultResourceLoaderType>>()

/**
 * Hand-off slot for this turn's short-term recall.
 *
 * Main computes the hits (it owns the registry) and ships them with the prompt;
 * `before_agent_start` consumes them. There is no session identity in that
 * event, but there is also only one worker thread: the run that owns this slot
 * is the run whose `before_agent_start` is executing. `RECALL_TTL_MS` bounds the
 * window so a stalled prompt cannot season some later turn's context.
 */
const RECALL_TTL_MS = 5_000
let recallSlot: { hits: SessionSearchHit[]; at: number } | undefined

function consumeRecall(): SessionSearchHit[] {
  const slot = recallSlot
  if (slot === undefined) return []
  recallSlot = undefined
  return Date.now() - slot.at > RECALL_TTL_MS ? [] : slot.hits
}

async function acquireResourceLoader(
  cwd: string,
  mcpTools: McpToolBridgeDef[]
): Promise<DefaultResourceLoaderType> {
  const key = cwd.toLowerCase()
  const cached = resourceLoaders.get(key)
  if (cached) return cached
  const pending = (async () => {
    const { DefaultResourceLoader, getAgentDir } = await loadPi()
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      additionalExtensionPaths: pluginResourceSpec.extensionPaths,
      // User-level skills (agent-written via skill_manage) ride the same
      // additionalSkillPaths channel as plugin skills; the dir may not exist
      // until the first skill is written, hence the existsSync guard.
      additionalSkillPaths: [
        ...pluginResourceSpec.skillRoots,
        ...(existsSync(SKILLS_HOME) ? [SKILLS_HOME] : [])
      ],
      extensionFactories: [
        createSelfEvolutionExtension({
          cwd,
          onSkillsChanged: () => resourceLoaders.clear(),
          judgeDuplicate: judgeMemoryDuplicate,
          recallHistory: async (_prompt, limit) => consumeRecall().slice(0, limit)
        }),
        createCompactionRoutingExtension({
          resolveCompactionModel: async () =>
            resolveRoleModel(await getModelRuntime(), 'compaction'),
          getRuntime: () => getModelRuntime()
        }),
        createPluginBridgeFactory(pluginResourceSpec, undefined, hookDeps, { tools: mcpTools })
      ]
    })
    await resourceLoader.reload()
    return resourceLoader
  })()
  resourceLoaders.set(key, pending)
  // A failed build must not be cached — the next attach should retry cleanly.
  pending.catch(() => resourceLoaders.delete(key))
  return pending
}

/** Minimal shape of the V8 CPU profile we consume. */
interface CpuProfileNode {
  hitCount?: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}
interface CpuProfile {
  nodes: CpuProfileNode[]
}

/** Top self-time consumers, so a slow PI call can be attributed to a file:line. */
function reportProfile(label: string, prof: CpuProfile, top = 12): void {
  const self = new Map<string, number>()
  for (const node of prof.nodes) {
    const hits = node.hitCount ?? 0
    if (hits === 0) continue
    const { functionName, url, lineNumber } = node.callFrame
    const file = url ? url.replace(/^.*[\\/]/, '') : '(native)'
    const key = `${functionName || '(anonymous)'} @ ${file}:${lineNumber}`
    self.set(key, (self.get(key) ?? 0) + hits)
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
  console.log(`[perf:profile] ${label} ${JSON.stringify(rows)}`)
}

/**
 * Wrap a call in the V8 CPU profiler when FLEXAGENT_PERF=1, printing where the
 * self time went. Sampling interval is 1ms, so hit counts read as milliseconds.
 */
async function profiled<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (process.env.FLEXAGENT_PERF !== '1') return fn()
  const { Session: InspectorSession } = await import('node:inspector')
  const inspector = new InspectorSession()
  inspector.connect()
  const post = <R>(method: string): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      inspector.post(method, (err, res) => (err ? reject(err) : resolve(res as R)))
    })
  try {
    await post('Profiler.enable')
    await post('Profiler.start')
    const result = await fn()
    const { profile } = await post<{ profile: CpuProfile }>('Profiler.stop')
    reportProfile(label, profile)
    return result
  } finally {
    inspector.disconnect()
  }
}

async function attachSession(
  sessionId: SessionId,
  cwd: string,
  sessionManager: SessionManagerType,
  options: { applyChatRole?: boolean } = {}
): Promise<HostSession> {
  const perf = perfStart()
  // Before anything can open a socket: a proxy saved in a previous run has to be
  // in force for the MCP bridge and the model runtime alike. Resolves instantly
  // after the first call, so this is not an attach-time cost.
  await ensureNetworkApplied()
  perf.mark('network')
  const { createAgentSession } = await loadPi()
  perf.mark('loadPi')
  if (!mcpStartupPromise) mcpStartupPromise = startMcpToolBridge()
  const mcpTools = await mcpStartupPromise
  perf.mark('mcp')
  const resourceLoader = await acquireResourceLoader(cwd, mcpTools)
  perf.mark('resourceLoader')
  // createAgentSession would otherwise build its own ModelRuntime per attach
  // (measured ~1.7s). getDefaultAgentDir() === getAgentDir(), so the shared
  // instance resolves the same auth.json/models.json and can be reused, exactly
  // as PI's own service layer does across sessions.
  const modelRuntime = await getModelRuntime()
  perf.mark('getModelRuntime')
  // Only for a session that has no history yet: PI restores a transcript's own
  // model on attach, and a per-session switch the user made must win over the
  // role. Passing nothing leaves PI's `defaultProvider`/`defaultModel` in charge.
  const chatRoleModel = options.applyChatRole ? resolveRoleModel(modelRuntime, 'chat') : null
  perf.mark('resolveChatRole')
  const { session } = await profiled('createAgentSession', () =>
    createAgentSession({
      cwd,
      sessionManager,
      resourceLoader,
      modelRuntime,
      ...(chatRoleModel === null ? {} : { model: chatRoleModel })
    })
  )
  perf.mark('createAgentSession')
  await session.bindExtensions({ mode: 'print' })
  perf.mark('bindExtensions')
  perf.done('attachSession', { sessionId, cwd })
  const host: HostSession = {
    session,
    sessionId,
    cwd,
    unsubscribe: () => {},
    // Run-state authority (contract §3.2): only agent_start/agent_settled (plus
    // prompt-accept/abort below) may set runState and fan out run_state events.
    // Never seed from session.isStreaming — kernel run_state is the sole
    // runtime-state authority; PI transport state must not feed registry/fanOut/run_state.
    runState: 'idle',
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
  return host
}

async function handleRequest(req: WorkerRequest): Promise<unknown> {
  switch (req.type) {
    case 'listSessions': {
      return [...sessions.keys()]
    }
    case 'createSession': {
      const perf = perfStart()
      if (!req.cwd || !isAbsolute(req.cwd)) {
        throw new ContractError('INVALID_INPUT', 'cwd must be an absolute path')
      }
      if (sessions.has(req.sessionId)) {
        const existing = sessions.get(req.sessionId)!
        return { piSessionFile: existing.session.sessionFile }
      }
      const { SessionManager } = await loadPi()
      perf.mark('loadPi')
      const host = await attachSession(req.sessionId, req.cwd, SessionManager.create(req.cwd), {
        applyChatRole: true
      })
      perf.mark('attachSession')
      perf.done('createSession', { sessionId: req.sessionId, cwd: req.cwd })
      return { piSessionFile: host.session.sessionFile }
    }
    case 'openSession': {
      const perf = perfStart()
      const existing = sessions.get(req.sessionId)
      if (existing) {
        const messages = buildMessages(existing.session)
        perf.mark('buildMessages')
        perf.done('openSession', { sessionId: req.sessionId, warm: true, messages: messages.length })
        return { messages }
      }
      if (!req.piSessionFile) {
        perf.done('openSession', { sessionId: req.sessionId, warm: false, reason: 'no transcript file' })
        return { messages: [] }
      }
      const { SessionManager } = await loadPi()
      perf.mark('loadPi')
      const sessionManager = SessionManager.open(req.piSessionFile, undefined, req.cwd)
      perf.mark('sessionManager.open')
      const host = await attachSession(req.sessionId, req.cwd, sessionManager)
      perf.mark('attachSession')
      const messages = buildMessages(host.session)
      perf.mark('buildMessages')
      perf.done('openSession', { sessionId: req.sessionId, warm: false, messages: messages.length })
      return { messages }
    }
    case 'setSessionCwd': {
      const perf = perfStart()
      if (!req.cwd || !isAbsolute(req.cwd)) {
        throw new ContractError('INVALID_INPUT', 'cwd must be an absolute path')
      }
      const previous = requireSession(req.sessionId)
      if (previous.runState !== 'idle') {
        throw new ContractError(
          'SESSION_BUSY',
          'cannot change the workspace while a run is in flight'
        )
      }
      // PI keeps the transcript in a file and SessionManager.open accepts a cwd
      // override, so the session moves workspace with its history intact.
      // Rebuild the host against the new cwd: the resource loader reads
      // AGENTS.md/skills from it and tools resolve relative paths against it.
      const sessionFile = previous.session.sessionFile
      previous.unsubscribe()
      previous.session.dispose()
      sessions.delete(req.sessionId)
      perf.mark('disposePrevious')
      const { SessionManager } = await loadPi()
      const sessionManager =
        sessionFile === undefined
          ? SessionManager.create(req.cwd)
          : SessionManager.open(sessionFile, undefined, req.cwd)
      perf.mark('sessionManager.open')
      const host = await attachSession(req.sessionId, req.cwd, sessionManager)
      perf.mark('attachSession')
      perf.done('setSessionCwd', { sessionId: req.sessionId, cwd: req.cwd })
      return { piSessionFile: host.session.sessionFile }
    }
    case 'prompt': {
      const host = requireSession(req.sessionId)
      const text = req.text
      // Published for the before_agent_start that follows this prompt; consumed
      // there. Set before anything can await, so the run always sees it.
      recallSlot = req.recall === undefined ? undefined : { hits: req.recall, at: Date.now() }
      // Disposition authority (contract §2.1): the table keys on runState, and
      // host.runState is the origin of the run_state fanOut (setRunState →
      // kernel.runStates → registry projection → UI). Consume it directly;
      // never re-derive disposition from session.isStreaming (PI transport
      // state can diverge under steer/queue races).
      let disposition: PromptDisposition
      if (host.runState === 'idle') disposition = 'started'
      else if (req.disposition === 'queued') disposition = 'queued'
      else disposition = 'steering'

      // Deliberately distinct concept: PI transport-level admission control.
      // Kernel run_state is the UI/host authority; this PI check only decides
      // prompt() options (PI throws if streaming without streamingBehavior,
      // §2.1) and must never feed registry, fanOut, or run_state emission.
      const piStreamActive = host.session.isStreaming

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
        // Transport semantics unchanged: while PI streams, followUp-vs-steer is
        // the host-declared mode (req.disposition), independent of disposition.
        const opts = piStreamActive
          ? {
              streamingBehavior:
                req.disposition === 'queued' ? ('followUp' as const) : ('steer' as const),
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
      // A disposed session will not see another turn_end, and event handlers do
      // not run for a dispose forced from outside. Commit whatever it queued.
      flushPendingMemoryWrites()
      host.session.dispose()
      sessions.delete(req.sessionId)
      return undefined
    }
    case 'warmup': {
      // Prewarming is only worth anything when it happens strictly before the
      // user acts. This worker has a single thread, so a "warmup" that overlaps
      // a real request does not run in parallel — the two interleave and both
      // wall-clock times balloon (measured: getModelRuntime 1.7s -> 9.2s while
      // an attach was in flight). So: do nothing at all until the UI has been
      // quiet for a while, and bail out rather than compete.
      const perf = perfStart()
      if (!(await waitForQuiet(2000))) {
        perf.mark('idleWait')
        perf.done('warmup', { cwd: req.cwd, skipped: 'ui busy' })
        return undefined
      }
      perf.mark('idleWait')
      await loadPi()
      perf.mark('loadPi')
      await getModelRuntime()
      perf.mark('getModelRuntime')
      if (req.cwd) {
        if (!mcpStartupPromise) mcpStartupPromise = startMcpToolBridge()
        const mcpTools = await mcpStartupPromise
        perf.mark('mcp')
        // The loader build is the longest single piece; re-check before paying
        // for it in case the user came back while the rest was running.
        if (await waitForQuiet(1500)) {
          await acquireResourceLoader(req.cwd, mcpTools)
          perf.mark('resourceLoader')
        } else {
          perf.mark('resourceLoaderSkipped')
        }
      }
      perf.done('warmup', { cwd: req.cwd })
      return undefined
    }
    case 'listModels': {
      const perf = perfStart()
      const runtime = await getModelRuntime()
      perf.mark('getModelRuntime')
      const available = await runtime.getAvailable()
      perf.mark('getAvailable')
      perf.done('listModels')
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
    case 'reloadPlugins': {
      pluginResourceSpec = req.resourceSpec
      resetMcpBridge()
      // Plugin extensions, skills and MCP tools are baked into a loader at
      // construction, so every cached loader is stale by definition now.
      resourceLoaders.clear()
      return undefined
    }
    case 'reloadResources': {
      // User-level skills changed on disk (approved skill write or direct
      // skill_manage write). Loaders bake skills in at construction, so the
      // next attach rebuilds and picks them up.
      resourceLoaders.clear()
      return undefined
    }
    case 'modelsPath': {
      // Answer with PI's own path instead of letting main re-derive it: the
      // agent dir is configurable (PI_CODING_AGENT_DIR) and its default is
      // ~/.pi/agent, not anything FlexAgent owns.
      const { getAgentDir } = await loadPi()
      return { path: join(getAgentDir(), 'models.json') }
    }
    case 'reloadModels': {
      // models.json changed on disk. refresh() re-reads the file and recomposes
      // *in place*, which is the whole point: every attached session holds this
      // same ModelRuntime instance, so a fresh instance would leave them
      // resolving against the old model list until they were re-attached.
      // allowNetwork: false — a local edit must not wait on pi.dev.
      const runtime = await getModelRuntime()
      await runtime.refresh({
        // An empty list would compose nothing while config is re-read, so fall
        // back to a full rebuild instead of a half-applied refresh.
        ...(req.providers.length > 0 ? { providers: req.providers } : {}),
        allowNetwork: false
      })
      const { provider, id, present } = req.verify
      const resolved = runtime.getModel(provider, id) !== undefined
      if (resolved !== present) {
        return {
          error:
            runtime.getError() ??
            (present
              ? `The kernel did not register ${provider}/${id}.`
              : `The kernel still resolves ${provider}/${id} after removal.`)
        }
      }
      return undefined
    }
    case 'settingsPath': {
      // Same rule as modelsPath: the agent dir is PI's to define.
      const { getAgentDir } = await loadPi()
      return { path: join(getAgentDir(), 'settings.json') }
    }
    case 'resolveModelRoles': {
      const runtime = await getModelRuntime()
      const settingsFile = await kernelSettingsPath()
      return resolveRoles(runtime, settingsFile)
    }
    case 'networkStatus': {
      return networkStatus()
    }
    case 'applyNetwork': {
      return applyNetwork(req.proxy, req.idleTimeoutMs)
    }
    case 'sessionUsage': {
      const host = requireSession(req.sessionId)
      return buildUsageReport(req.sessionId, host.session.sessionManager.getEntries())
    }

    case 'shutdown': {
      // Nothing is guaranteed to fire another lifecycle event past this point:
      // commit every queued card before anything is torn down.
      flushPendingMemoryWrites()
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
      await settleHookRuns()
      await settleMcpCalls()
      for (const client of mcpClients) {
        try {
          await closeMcpClient(client)
        } catch {
        }
      }
      mcpClients.length = 0
      setTimeout(() => process.exit(0), 10)
      return undefined
    }
    default: {
      throw new ContractError('INVALID_INPUT', 'Unknown worker request')
    }
  }
}

port.on('message', (req: WorkerRequest) => {
  const isWarmup = req.type === 'warmup'
  if (!isWarmup) {
    // Warmup is speculative background work; everything else is the user waiting.
    lastUserRequestAt = Date.now()
    userRequestsInFlight += 1
  }
  void handleRequest(req)
    .then((result) => ok(req.requestId, result))
    .catch((err: unknown) => {
      if (err instanceof ContractError) {
        fail(req.requestId, err.code, err.message, err.details)
      } else {
        fail(req.requestId, 'KERNEL_INTERNAL', err instanceof Error ? err.message : String(err))
      }
    })
    .finally(() => {
      if (!isWarmup) userRequestsInFlight -= 1
    })
})
