import { mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import type { PluginHookContext, PluginResourceSpec } from '../shared/kernel-protocol'
import type { HookEntry, HookSourceDiagnosticCode } from './hookSources'
import type { HookTemplateContext } from './userConfig'
import type { HookRunOptions, HookRunResult } from './hooks/hookRunner'
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

export interface PluginHookDeps {
  parseHooksContent(
    content: string,
    sourcePath: string
  ): {
    entries: HookEntry[]
    diagnostics: Array<{ code: HookSourceDiagnosticCode; message: string }>
  }
  interpolate(template: string, context: HookTemplateContext): string
  runHook(options: HookRunOptions): Promise<HookRunResult>
}

function buildHookStdin(
  sourceEvent: MappedHookEvent,
  payload: Record<string, unknown>,
  cwd: string
): string {
  const input: Record<string, unknown> = {
    hook_event_name: sourceEvent,
    hookEventName: sourceEvent,
    cwd,
    timestamp: new Date().toISOString()
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
  return `${JSON.stringify(input)}\n`
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
            name: hookContext.pluginName
          }
        : undefined
    if (pluginInfo) {
      try {
        mkdirSync(pluginInfo.dataPath, { recursive: true })
      } catch {
      }
    }
    for (const entry of parsed.entries) {
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
          ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {})
        })
        for (const diag of result.diagnostics) {
          diagnostics.push({ code: diag.code, message: `${entry.event} hook: ${diag.message}` })
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
            message: `${entry.event} hook requested a block (not enforced in P2c): ${reason}`
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
