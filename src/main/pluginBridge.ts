import { mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import type { PluginHookContext, PluginResourceSpec } from '../shared/kernel-protocol'
import type { HookEntry, HookSourceDiagnosticCode } from './hookSources'
import type { HookTemplateContext } from './userConfig'
import type { HookRunOptions, HookRunPlugin, HookRunResult } from './hooks/hookRunner'
import {
  aggregatePermissionDecisions,
  parseHookDecision,
  type HookPermissionVote
} from './hookDecisions'
import { defaultCapabilitiesFor, effectiveCapabilities, mergeCapabilities } from './sandbox'
import type { PluginCapabilities } from '../shared/contract'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  InlineExtension
} from '@earendil-works/pi-coding-agent'

export interface PluginBridgeDiagnostic {
  code:
    | 'command_dir_missing'
    | 'command_unreadable'
    | 'command_duplicate'
    | HookSourceDiagnosticCode
    | 'plugin_unsupported_hook'
    | 'hook_interpolation_failed'
    | 'hook_block_ignored'
    | 'hook_timeout'
    | 'hook_spawn_error'
    | 'hook_exit_nonzero'
    | 'hook_output_invalid'
    /** Ticket 22: refused before it started, or reported a boundary crossing. */
    | 'sandbox_denied'
    | 'sandbox_boundary'
  message: string
}

export interface BridgeCommandFrontmatter {
  name?: string
  description?: string
}

export interface ParsedBridgeCommand {
  frontmatter: BridgeCommandFrontmatter
  body: string
}

export interface BridgePiApi {
  registerCommand(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
    }
  ): void
  registerTool?(tool: McpToolBridgeDef): void
  sendUserMessage(content: string): void
  getCommands?: () => Array<{ name: string }>
}

export interface McpToolBridgeResult {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
}

export interface McpToolBridgeDef {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown
  ) => Promise<McpToolBridgeResult>
}

export interface PluginMcpDeps {
  tools: McpToolBridgeDef[]
}

export type BridgeHookOn = (
  event: string,
  handler: (payload: unknown, ctx: unknown) => void
) => void

export interface BridgeFsRead {
  isDirectory(path: string): boolean
  listMarkdownFiles(dir: string): string[]
  readFile(path: string): string
}

export interface PluginBridgeResult {
  registered: string[]
  diagnostics: PluginBridgeDiagnostic[]
}

export function parseCommandMarkdown(content: string): ParsedBridgeCommand {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }
  const frontmatter: BridgeCommandFrontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (kv[1] === 'name') frontmatter.name = value
    else if (kv[1] === 'description') frontmatter.description = value
  }
  return { frontmatter, body: match[2] }
}

export const nodeBridgeFsRead: BridgeFsRead = {
  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  listMarkdownFiles(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  },
  readFile(path: string): string {
    return readFileSync(path, 'utf8')
  }
}

export function registerPluginCommands(
  spec: PluginResourceSpec,
  pi: BridgePiApi,
  fsRead: BridgeFsRead = nodeBridgeFsRead,
  diagnostics: PluginBridgeDiagnostic[] = []
): PluginBridgeResult {
  const registered: string[] = []
  const taken = new Set<string>()
  try {
    for (const existing of pi.getCommands?.() ?? []) taken.add(existing.name)
  } catch {
    taken.clear()
  }
  for (const dir of spec.commands) {
    if (!fsRead.isDirectory(dir)) {
      diagnostics.push({ code: 'command_dir_missing', message: `Command dir not found: ${dir}` })
      continue
    }
    for (const file of fsRead.listMarkdownFiles(dir)) {
      const full = join(dir, file)
      let content: string
      try {
        content = fsRead.readFile(full)
      } catch {
        diagnostics.push({ code: 'command_unreadable', message: `Cannot read command file: ${full}` })
        continue
      }
      const parsed = parseCommandMarkdown(content)
      const stem = file.endsWith('.md') ? file.slice(0, -3) : file
      const name = (parsed.frontmatter.name ?? stem).trim() || stem
      if (taken.has(name)) {
        diagnostics.push({
          code: 'command_duplicate',
          message: `Skipped duplicate command "${name}" from ${full}`
        })
        continue
      }
      taken.add(name)
      const description = parsed.frontmatter.description
      const body = parsed.body
      const options: {
        description?: string
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
      } = {
        handler: async (_args: string, _ctx: ExtensionCommandContext): Promise<void> => {
          pi.sendUserMessage(body.split('$ARGUMENTS').join(_args))
        }
      }
      if (description !== undefined) options.description = description
      pi.registerCommand(name, options)
      registered.push(name)
    }
  }
  return { registered, diagnostics }
}

export const HOOK_EVENT_MAP = {
  SessionStart: 'session_start',
  SessionEnd: 'session_shutdown',
  PreCompact: 'session_before_compact',
  PostCompact: 'session_compact',
  SessionCompact: 'session_compact',
  PreToolUse: 'tool_execution_start',
  PostToolUse: 'tool_execution_end'
} as const

export type MappedHookEvent = keyof typeof HOOK_EVENT_MAP

export function isMappedHookEvent(event: string): event is MappedHookEvent {
  return Object.prototype.hasOwnProperty.call(HOOK_EVENT_MAP, event)
}

export function matchesHookMatcher(
  matchValue: string | undefined,
  matcher: string | undefined
): boolean {
  if (!matcher || matcher === '*') return true
  if (!matchValue) return false
  if (/^[a-zA-Z0-9_|]+$/u.test(matcher)) {
    return matcher.split('|').includes(matchValue)
  }
  try {
    return new RegExp(matcher).test(matchValue)
  } catch {
    return false
  }
}

/**
 * A hook entry registered for an enforcement-capable event (ticket 13).
 * PreToolUse and UserPromptSubmit have no fire-and-forget kernel event that
 * could block, so they are checked synchronously at the enforcement points
 * (worker `beforeToolCall` / prompt handler) instead of `pi.on`.
 */
export interface RegisteredHookCheck {
  event: EnforcedHookEvent
  /** Tool-name filter: exact `a|b` list, regex, or `*`/undefined = all. */
  matcher?: string
  entry: HookEntry
  plugin: HookRunPlugin | undefined
  hookContext?: PluginHookContext
  /** Ticket 22: what this specific hook runs under. Absent = pre-sandbox legacy. */
  capabilities?: PluginCapabilities
}

export interface PluginHookDeps {
  parseHooksContent(
    content: string,
    sourcePath: string
  ): {
    entries: HookEntry[]
    diagnostics: Array<{ code: HookSourceDiagnosticCode; message: string }>
    /** Ticket 22: what this hooks file asks for, if it declares anything. */
    capabilities?: Partial<PluginCapabilities>
  }
  interpolate(template: string, context: HookTemplateContext): string
  runHook(options: HookRunOptions): Promise<HookRunResult>
  /** Mutated by registerPluginHooks; read by runPreToolUseHooks at each tool call. */
  preToolUseChecks: RegisteredHookCheck[]
  /** Mutated by registerPluginHooks; read by runPromptSubmitHooks at each prompt. */
  promptSubmitChecks: RegisteredHookCheck[]
  /** Mutated by registerPluginHooks; read by runStopHooks when a turn settles (ticket 14). */
  stopChecks: RegisteredHookCheck[]
  /** Mutated by registerPluginHooks; read where the chain would ask the user (ticket 14). */
  permissionRequestChecks: RegisteredHookCheck[]
}

function buildHookStdin(
  sourceEvent: string,
  payload: Record<string, unknown>,
  cwd: string
): string {
  const input: Record<string, unknown> = {
    hook_event_name: sourceEvent,
    hookEventName: sourceEvent,
    cwd,
    timestamp: new Date().toISOString()
  }
  if (typeof payload.prompt === 'string') {
    input.prompt = payload.prompt
  }
  if (typeof payload.toolName === 'string') {
    input.tool_name = payload.toolName
    input.tool_input = payload.args
    input.tool_use_id = payload.toolCallId
    input.toolName = payload.toolName
    input.toolInput = payload.args
    input.toolCallId = payload.toolCallId
  }
  if (sourceEvent === 'PostToolUse') {
    input.tool_response = payload.result
    input.toolResponse = payload.result
    input.is_error = payload.isError === true
  }
  // Stop (ticket 14): without the turn's last message a hook can only guess
  // whether the work is finished, which is the whole judgement it exists for.
  if (sourceEvent === 'Stop') {
    input.stop_hook_active = payload.stop_hook_active === true
    if (typeof payload.last_assistant_message === 'string') {
      input.last_assistant_message = payload.last_assistant_message
      input.lastAssistantMessage = payload.last_assistant_message
    }
  }
  return `${JSON.stringify(input)}\n`
}

export interface HookCheckResult {
  blocked: boolean
  /** Veto/block reason — reaches the model (PreToolUse) or user (UserPromptSubmit). */
  reason?: string
  /** UserPromptSubmit only: hook-provided context appended to the outgoing prompt. */
  additionalContext?: string
  diagnostics: string[]
}

/** Events the worker awaits at an enforcement point rather than firing and forgetting. */
export type EnforcedHookEvent = 'PreToolUse' | 'UserPromptSubmit' | 'Stop' | 'PermissionRequest'

/** One check's outcome: the raw run plus the block/context reading of its output. */
interface SingleHookOutcome {
  result: HookRunResult
  blocked: boolean
  reason?: string
  /** Context the hook asked to add (UserPromptSubmit). */
  context?: string
  /** Skipped by matcher or failed interpolation — not an outcome at all. */
  skipped: boolean
}

async function runOneHookCheck(
  deps: PluginHookDeps,
  check: RegisteredHookCheck,
  input: {
    event: EnforcedHookEvent
    payload: Record<string, unknown>
    matchValue: string | undefined
    cwd: string
  },
  diagnostics: string[]
): Promise<SingleHookOutcome> {
  const skipped: SingleHookOutcome = {
    result: {
      status: 'ok',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
      blockRequested: false,
      diagnostics: []
    },
    blocked: false,
    skipped: true
  }
  if (check.matcher !== undefined && !matchesHookMatcher(input.matchValue, check.matcher)) {
    return skipped
  }
  const templateContext: HookTemplateContext = {
    values: check.hookContext?.userConfig ?? {},
    sensitiveKeys: check.hookContext?.sensitiveKeys ?? [],
    ...(check.plugin !== undefined ? { plugin: check.plugin } : {}),
    projectDir: input.cwd
  }
  let command: string
  let args: string[] | undefined
  try {
    command = deps.interpolate(check.entry.command, templateContext)
    if (check.entry.args !== undefined) {
      args = check.entry.args.map((arg) => deps.interpolate(arg, templateContext))
    }
  } catch (error) {
    diagnostics.push(
      `${check.event} hook interpolation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return skipped
  }
  const result = await deps.runHook({
    type: check.entry.type,
    command,
    ...(args !== undefined ? { args } : {}),
    ...(check.entry.shell !== undefined ? { shell: check.entry.shell } : {}),
    cwd: input.cwd,
    stdin: buildHookStdin(input.event, input.payload, input.cwd),
    ...(check.plugin !== undefined ? { plugin: check.plugin } : {}),
    ...(check.capabilities !== undefined ? { capabilities: check.capabilities } : {}),
    ...(check.hookContext?.declaredCapabilities !== undefined
      ? { declared: check.hookContext.declaredCapabilities }
      : {}),
    ...(check.entry.timeoutMs !== undefined ? { timeoutMs: check.entry.timeoutMs } : {})
  })
  for (const diag of result.diagnostics) {
    diagnostics.push(`${check.event} hook [${diag.code}]: ${diag.message}`)
  }
  const blocked =
    result.blockRequested ||
    result.output?.continue === false ||
    result.output?.decision === 'block'
  const reason =
    result.blockReason ??
    (typeof result.output?.reason === 'string' ? result.output.reason : undefined) ??
    (typeof result.output?.stopReason === 'string' ? result.output.stopReason : undefined)
  const raw = result.output?.additionalContext ?? result.output?.additional_context
  return {
    result,
    blocked,
    ...(reason !== undefined ? { reason } : {}),
    ...(typeof raw === 'string' && raw.trim().length > 0 ? { context: raw } : {}),
    skipped: false
  }
}

async function runHookChecks(
  deps: PluginHookDeps,
  checks: RegisteredHookCheck[],
  input: {
    event: EnforcedHookEvent
    payload: Record<string, unknown>
    matchValue: string | undefined
    cwd: string
  }
): Promise<HookCheckResult> {
  const diagnostics: string[] = []
  const contexts: string[] = []
  for (const check of checks) {
    const outcome = await runOneHookCheck(deps, check, input, diagnostics)
    if (outcome.skipped) continue
    if (outcome.blocked) {
      return { blocked: true, reason: outcome.reason ?? 'blocked by hook', diagnostics }
    }
    if (outcome.context !== undefined) contexts.push(outcome.context)
  }
  return {
    blocked: false,
    ...(contexts.length > 0 ? { additionalContext: contexts.join('\n\n') } : {}),
    diagnostics
  }
}

export async function runPreToolUseHooks(
  deps: PluginHookDeps,
  input: { toolName: string; args: unknown; toolCallId: string; cwd: string }
): Promise<HookCheckResult> {
  return runHookChecks(deps, deps.preToolUseChecks, {
    event: 'PreToolUse',
    payload: { toolName: input.toolName, args: input.args, toolCallId: input.toolCallId },
    matchValue: input.toolName,
    cwd: input.cwd
  })
}

export async function runPromptSubmitHooks(
  deps: PluginHookDeps,
  input: { prompt: string; cwd: string }
): Promise<HookCheckResult> {
  return runHookChecks(deps, deps.promptSubmitChecks, {
    event: 'UserPromptSubmit',
    payload: { prompt: input.prompt },
    matchValue: undefined,
    cwd: input.cwd
  })
}

/**
 * Stop (ticket 14): the model is about to end its turn. A hook may block with a
 * reason — "no test command and no result yet" — and the worker sends the model
 * round again with that reason. The ceiling on consecutive blocks lives in
 * `hookDecisions.ts`, because the loop that enforces it must be testable
 * without spawning a process.
 */
export async function runStopHooks(
  deps: PluginHookDeps,
  input: { cwd: string; lastAssistantText?: string }
): Promise<HookCheckResult> {
  return runHookChecks(deps, deps.stopChecks, {
    event: 'Stop',
    payload: {
      stop_hook_active: true,
      ...(input.lastAssistantText !== undefined
        ? { last_assistant_message: input.lastAssistantText }
        : {})
    },
    matchValue: undefined,
    cwd: input.cwd
  })
}

/**
 * PermissionRequest (ticket 14): fires only where the chain would have asked
 * the human, and answers on their behalf. Every check runs — unlike the block
 * semantics there is no early return, because a refusal from the third hook
 * must be able to outrank an allowance from the first.
 */
export async function runPermissionRequestHooks(
  deps: PluginHookDeps,
  input: { toolName: string; args: unknown; toolCallId: string; cwd: string }
): Promise<{
  decision: HookPermissionVote | undefined
  reason?: string
  diagnostics: string[]
}> {
  const diagnostics: string[] = []
  const votes: (HookPermissionVote | undefined)[] = []
  let firstReason: string | undefined

  for (const check of deps.permissionRequestChecks) {
    const outcome = await runOneHookCheck(
      deps,
      check,
      {
        event: 'PermissionRequest',
        payload: {
          toolName: input.toolName,
          args: input.args,
          toolCallId: input.toolCallId
        },
        matchValue: input.toolName,
        cwd: input.cwd
      },
      diagnostics
    )
    if (outcome.skipped) continue
    const { decision, reason } = parseHookDecision(outcome.result.output)
    // A hook that blocks outright (exit 2, or an explicit block decision) meant
    // to refuse, whether or not it also wrote JSON: an exit code is not an
    // afterthought, and reading it as "no vote" would let the tool through.
    if (outcome.blocked && (decision === undefined || decision === 'deny')) {
      votes.push('deny')
      if (firstReason === undefined) firstReason = outcome.reason ?? reason
      continue
    }
    votes.push(decision)
    if (decision !== undefined && reason !== undefined && firstReason === undefined) {
      firstReason = reason
    }
  }

  return {
    decision: aggregatePermissionDecisions(votes),
    ...(firstReason !== undefined ? { reason: firstReason } : {}),
    diagnostics
  }
}

export function registerPluginHooks(
  spec: PluginResourceSpec,
  on: BridgeHookOn,
  fsRead: BridgeFsRead,
  deps: PluginHookDeps,
  diagnostics: PluginBridgeDiagnostic[] = []
): { registered: number; diagnostics: PluginBridgeDiagnostic[] } {
  const contexts: Record<string, PluginHookContext> = spec.hookContexts ?? {}
  const seenUnsupported = new Set<string>()
  let registered = 0
  for (const hooksPath of spec.hooks) {
    let content: string
    try {
      content = fsRead.readFile(hooksPath)
    } catch {
      diagnostics.push({
        code: 'plugin_hook_read_failed',
        message: `Cannot read hooks file: ${hooksPath}`
      })
      continue
    }
    const parsed = deps.parseHooksContent(content, hooksPath)
    for (const diag of parsed.diagnostics) {
      diagnostics.push({ code: diag.code, message: diag.message })
    }
    const hookContext = contexts[hooksPath]
    const pluginInfo =
      hookContext !== undefined
        ? {
            rootPath: hookContext.pluginRoot,
            dataPath: spec.pluginStorageRoot
              ? join(spec.pluginStorageRoot, 'data', hookContext.pluginId)
              : join(hookContext.pluginRoot, '.flex-plugin', 'data'),
            id: hookContext.pluginId,
            name: hookContext.pluginName,
            // Ticket 22: the grant decides the environment and the starting
            // directory. A marketplace plugin nobody blessed gets its own data
            // directory and no credential-bearing environment.
            capabilities: effectiveCapabilities(
              hookContext.pluginId,
              hookContext.sourceKind ?? 'local',
              hookContext.declaredCapabilities
            )
          }
        : undefined
    if (pluginInfo) {
      try {
        mkdirSync(pluginInfo.dataPath, { recursive: true })
      } catch {
      }
    }
    // Ticket 22: a plugin hook takes its grant; a project hooks file takes the
    // local baseline merged with whatever it declared. Either way the hook runs
    // in a child process with an allowlisted environment instead of inheriting
    // every credential this process holds.
    const hookCapabilities =
      pluginInfo?.capabilities ??
      mergeCapabilities(defaultCapabilitiesFor('local'), parsed.capabilities)
    const hookDeclared = hookContext?.declaredCapabilities ?? parsed.capabilities

    for (const entry of parsed.entries) {
      // Enforcement-capable events (ticket 13): registered as checks the worker
      // awaits at the enforcement points, not fire-and-forget kernel events.
      // Enforcement-capable events: registered as checks the worker awaits at
      // the enforcement points, not fire-and-forget kernel events. Ticket 14
      // added Stop and PermissionRequest to the two from ticket 13.
      if (
        entry.event === 'PreToolUse' ||
        entry.event === 'UserPromptSubmit' ||
        entry.event === 'Stop' ||
        entry.event === 'PermissionRequest'
      ) {
        const check: RegisteredHookCheck = {
          event: entry.event,
          ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
          entry,
          plugin: pluginInfo,
          ...(hookContext !== undefined ? { hookContext } : {}),
          capabilities: hookCapabilities
        }
        switch (entry.event) {
          case 'PreToolUse':
            deps.preToolUseChecks.push(check)
            break
          case 'UserPromptSubmit':
            deps.promptSubmitChecks.push(check)
            break
          case 'Stop':
            deps.stopChecks.push(check)
            break
          default:
            deps.permissionRequestChecks.push(check)
            break
        }
        registered += 1
        continue
      }
      if (!isMappedHookEvent(entry.event)) {
        seenUnsupported.add(entry.event)
        continue
      }
      const sourceEvent: MappedHookEvent = entry.event
      const kernelEvent = HOOK_EVENT_MAP[sourceEvent]
      on(kernelEvent, async (rawPayload, rawCtx) => {
        const payload =
          rawPayload !== null && typeof rawPayload === 'object'
            ? (rawPayload as Record<string, unknown>)
            : {}
        const ctx = rawCtx !== null && typeof rawCtx === 'object'
          ? (rawCtx as { cwd?: string })
          : {}
        const cwd =
          typeof ctx.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : process.cwd()
        const matchValue =
          typeof payload.toolName === 'string' ? payload.toolName : undefined
        if (entry.matcher !== undefined && !matchesHookMatcher(matchValue, entry.matcher)) {
          return
        }
        const templateContext: HookTemplateContext = {
          values: hookContext?.userConfig ?? {},
          sensitiveKeys: hookContext?.sensitiveKeys ?? [],
          ...(pluginInfo !== undefined ? { plugin: pluginInfo } : {}),
          projectDir: cwd
        }
        let command: string
        let args: string[] | undefined
        try {
          command = deps.interpolate(entry.command, templateContext)
          if (entry.args !== undefined) {
            args = entry.args.map((arg) => deps.interpolate(arg, templateContext))
          }
        } catch (error) {
          diagnostics.push({
            code: 'hook_interpolation_failed',
            message: `${entry.event} hook interpolation failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          })
          return
        }
        const result = await deps.runHook({
          type: entry.type,
          command,
          ...(args !== undefined ? { args } : {}),
          ...(entry.shell !== undefined ? { shell: entry.shell } : {}),
          cwd,
          stdin: buildHookStdin(sourceEvent, payload, cwd),
          ...(pluginInfo !== undefined ? { plugin: pluginInfo } : {}),
          capabilities: hookCapabilities,
          ...(hookDeclared !== undefined ? { declared: hookDeclared } : {}),
          ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {})
        })
        for (const diag of result.diagnostics) {
          diagnostics.push({
            code: diag.code,
            message: `${entry.event} hook [${diag.code}]: ${diag.message}`
          })
        }
        const outputContinue = result.output?.continue
        const outputDecision = result.output?.decision
        if (
          result.blockRequested ||
          outputContinue === false ||
          outputDecision === 'block'
        ) {
          const reason =
            result.blockReason ??
            (typeof result.output?.reason === 'string' ? result.output.reason : undefined) ??
            (typeof result.output?.stopReason === 'string'
              ? result.output.stopReason
              : undefined) ??
            'block requested by hook'
          diagnostics.push({
            code: 'hook_block_ignored',
            message: `${entry.event} hook requested a block (observed only — this event has no enforcement point): ${reason}`
          })
        }
      })
      registered += 1
    }
  }
  if (seenUnsupported.size > 0) {
    diagnostics.push({
      code: 'plugin_unsupported_hook',
      message: `Hook event(s) not executable by this kernel: ${[...seenUnsupported]
        .sort()
        .join(', ')}`
    })
  }
  return { registered, diagnostics }
}

export function createPluginBridgeFactory(
  spec: PluginResourceSpec,
  diagnostics?: PluginBridgeDiagnostic[],
  hookDeps?: PluginHookDeps,
  mcpDeps?: PluginMcpDeps
): InlineExtension {
  return {
    name: 'flex-plugin-bridge',
    factory: (pi: ExtensionAPI): void => {
      registerPluginCommands(spec, pi, nodeBridgeFsRead, diagnostics)
      if (hookDeps) {
        registerPluginHooks(
          spec,
          (event, handler) => {
            pi.on(event as 'session_start', handler)
          },
          nodeBridgeFsRead,
          hookDeps,
          diagnostics
        )
      }
      if (mcpDeps) {
        for (const tool of mcpDeps.tools) {
          pi.registerTool?.({
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            execute: (toolCallId, params, signal, onUpdate, ctx) =>
              tool.execute(toolCallId, params, signal, onUpdate, ctx)
          })
        }
      }
    }
  }
}
