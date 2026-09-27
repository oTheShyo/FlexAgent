import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { normalize, resolve } from 'path'
import {
  buildSandboxEnv,
  isPathAllowed,
  mergeCapabilities,
  resolveSandboxCwd,
  sandboxRoots
} from '../sandbox'
import type { PluginCapabilities } from '../../shared/contract'

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000
export const DEFAULT_HOOK_MAX_OUTPUT_BYTES = 32_768

export interface HookRunPlugin {
  rootPath: string
  dataPath: string
  id: string
  name: string
  /** Ticket 22: what this plugin was granted. Absent = legacy, inherit. */
  capabilities?: PluginCapabilities
}

export interface HookRunOptions {
  type: 'command' | 'process'
  command: string
  args?: string[]
  shell?: string | true
  cwd: string
  plugin?: HookRunPlugin
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
  maxOutputBytes?: number
  /**
   * Ticket 22. The capability set this run executes under. Absent means
   * "before this existed" — full environment, caller's cwd — which keeps every
   * existing hook working while new grants opt in.
   */
  capabilities?: PluginCapabilities
  /** What the hook's own manifest asked for; refused when it exceeds the grant. */
  declared?: Partial<PluginCapabilities>
}

export type HookRunStatus =
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'killed'
  | 'spawn_error'
  /** Ticket 22: asked for more than it was granted, so it never started. */
  | 'sandbox_denied'

export interface HookRunDiagnostic {
  code:
    | 'hook_timeout'
    | 'hook_spawn_error'
    | 'hook_exit_nonzero'
    | 'hook_output_invalid'
    | 'sandbox_denied'
    | 'sandbox_boundary'
  message: string
}

export interface HookRunResult {
  status: HookRunStatus
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
  output?: Record<string, unknown>
  blockRequested: boolean
  blockReason?: string
  diagnostics: HookRunDiagnostic[]
}

export function resolveHookTimeoutMs(
  hook: { type: 'command' | 'process'; timeoutMs?: number; timeout?: number },
  defaultTimeoutMs: number = DEFAULT_HOOK_TIMEOUT_MS
): number {
  const timeoutMs =
    hook.timeoutMs ??
    (hook.type === 'command' && hook.timeout !== undefined
      ? hook.timeout * 1000
      : defaultTimeoutMs)
  return Math.max(1, Math.round(timeoutMs))
}

export function createHookEnvOverlay(
  plugin: HookRunPlugin | undefined,
  cwd: string
): Record<string, string> {
  const set: Record<string, string> = {
    CLAUDE_PROJECT_DIR: cwd,
    ZCODE_PROJECT_DIR: cwd,
    FLEX_PROJECT_DIR: cwd
  }
  if (plugin) {
    set.CLAUDE_PLUGIN_DATA = plugin.dataPath
    set.CLAUDE_PLUGIN_ROOT = plugin.rootPath
    set.ZCODE_PLUGIN_DATA = plugin.dataPath
    set.ZCODE_PLUGIN_ID = plugin.id
    set.ZCODE_PLUGIN_NAME = plugin.name
    set.ZCODE_PLUGIN_ROOT = plugin.rootPath
    set.FLEX_PLUGIN_DATA = plugin.dataPath
    set.FLEX_PLUGIN_ID = plugin.id
    set.FLEX_PLUGIN_NAME = plugin.name
    set.FLEX_PLUGIN_ROOT = plugin.rootPath
  }
  return set
}

function trimForPreview(value: string, maxLength = 4000): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength)}...`
}

function parseHookStdout(stdout: string): {
  output?: Record<string, unknown>
  invalid?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed || !trimmed.startsWith('{')) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { invalid: 'Hook stdout JSON must be an object' }
  }
  const record = parsed as Record<string, unknown>
  if (record.continue !== undefined && typeof record.continue !== 'boolean') {
    return { invalid: 'Hook stdout field "continue" must be a boolean' }
  }
  if (record.reason !== undefined && typeof record.reason !== 'string') {
    return { invalid: 'Hook stdout field "reason" must be a string' }
  }
  if (record.stopReason !== undefined && typeof record.stopReason !== 'string') {
    return { invalid: 'Hook stdout field "stopReason" must be a string' }
  }
  if (
    record.decision !== undefined &&
    record.decision !== 'approve' &&
    record.decision !== 'block'
  ) {
    return { invalid: 'Hook stdout field "decision" must be "approve" or "block"' }
  }
  if (record.additionalContext !== undefined && typeof record.additionalContext !== 'string') {
    return { invalid: 'Hook stdout field "additionalContext" must be a string' }
  }
  if (record.additional_context !== undefined && typeof record.additional_context !== 'string') {
    return { invalid: 'Hook stdout field "additional_context" must be a string' }
  }
  if (record.systemMessage !== undefined && typeof record.systemMessage !== 'string') {
    return { invalid: 'Hook stdout field "systemMessage" must be a string' }
  }
  return { output: record }
}

/** True when `granted` covers everything `wanted` asks for. */
function grantedCovers(wanted: PluginCapabilities, granted: PluginCapabilities): boolean {
  if (wanted.network && !granted.network) return false
  if (wanted.env === 'inherit' && granted.env !== 'inherit') return false
  const rank: Record<PluginCapabilities['fs'], number> = {
    none: 0,
    'plugin-data': 1,
    workspace: 2
  }
  return rank[wanted.fs] <= rank[granted.fs]
}

/**
 * Whether a hook is about to reach into the workspace it was not granted
 * (ticket 22).
 *
 * Deliberately narrow, because the broad version is not enforceable: a hook
 * normally runs `/usr/bin/node` or `C:\\…\\node.exe`, which is outside every
 * root we could name, so "the program must live inside the sandbox" would
 * reject every hook that ever worked. What *can* be judged before the process
 * exists is the opposite question — is something in the hook's command line a
 * file that lies inside the workspace, when the workspace is not part of its
 * grant? That is the crossing worth naming.
 *
 * `type: 'command'` is skipped: the string goes to a shell, and guessing which
 * token is a path there would produce refusals nobody can act on.
 */
export function boundaryViolation(input: {
  type: 'command' | 'process'
  command: string
  args?: string[]
  cwd: string
  workspaceCwd: string
  capabilities: PluginCapabilities
}): string | null {
  if (input.capabilities.fs === 'workspace') return null
  if (input.type !== 'process') return null
  const workspace = normalize(resolve(input.workspaceCwd))
  for (const token of [input.command, ...(input.args ?? [])]) {
    if (!token.includes('/') && !token.includes('\\')) continue
    let target: string
    try {
      target = resolve(input.cwd, token)
    } catch {
      continue
    }
    if (!existsSync(target)) continue
    if (isPathAllowed(target, [workspace])) {
      return `hook runs ${target}, inside the workspace its ${input.capabilities.fs} scope does not cover`
    }
  }
  return null
}

/**
 * The pre-sandbox environment (ticket 22): everything, plus the overlay.
 *
 * Kept for hooks that carry no capability set — one written before this
 * existed. Silently narrowing the environment of a working hook would break it
 * under the guise of securing it; the migration is opt-in per grant.
 */
function legacyEnv(options: HookRunOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) env[key] = value
  }
  return env
}

function killHookProcess(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.on('error', () => {})
        killer.unref?.()
      } catch {
        try {
          child.kill()
        } catch {
        }
      }
      return
    }
    try {
      child.kill()
    } catch {
    }
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const sigkill = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
    }
  }, 1500)
  sigkill.unref?.()
}

function baseResult(
  partial: Partial<HookRunResult> & { status: HookRunStatus; blockRequested: boolean }
): HookRunResult {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 0,
    diagnostics: [],
    ...partial
  }
}

export async function runHook(options: HookRunOptions): Promise<HookRunResult> {
  const timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS))
  const maxOutputBytes = Math.max(
    1,
    Math.round(options.maxOutputBytes ?? DEFAULT_HOOK_MAX_OUTPUT_BYTES)
  )
  const startedAt = Date.now()

  // Ticket 22: a hook that asks for more than it was granted does not run.
  // Refusing here is the only place the answer can still be no — once the child
  // exists, the parent has no say in what it reaches for.
  const caps = options.capabilities
  const wanted = mergeCapabilities(caps ?? { fs: 'workspace', env: 'inherit', network: false }, options.declared)
  if (caps !== undefined && !grantedCovers(wanted, caps)) {
    return baseResult({
      status: 'sandbox_denied',
      blockRequested: false,
      durationMs: Date.now() - startedAt,
      diagnostics: [
        {
          code: 'sandbox_denied',
          message: `hook asks for ${JSON.stringify(wanted)} but was granted ${JSON.stringify(caps)}`
        }
      ]
    })
  }

  const overlay = {
    ...createHookEnvOverlay(options.plugin, options.cwd),
    ...(options.env ?? {})
  }
  const env =
    caps === undefined
      ? { ...legacyEnv(options), ...overlay }
      : buildSandboxEnv({ capabilities: caps, overlay })

  // File scope decides where the child starts. It cannot decide where the child
  // goes afterwards — see the note at the top of sandbox.ts.
  const cwd =
    caps === undefined
      ? options.cwd
      : resolveSandboxCwd({
          capabilities: caps,
          workspaceCwd: options.cwd,
          ...(options.plugin !== undefined ? { pluginDataPath: options.plugin.dataPath } : {})
        })

  if (caps !== undefined) {
    const boundary = boundaryViolation({
      type: options.type,
      command: options.command,
      ...(options.args !== undefined ? { args: options.args } : {}),
      cwd,
      workspaceCwd: options.cwd,
      capabilities: caps
    })
    if (boundary !== null) {
      return baseResult({
        status: 'sandbox_denied',
        blockRequested: false,
        durationMs: Date.now() - startedAt,
        diagnostics: [{ code: 'sandbox_boundary', message: boundary }]
      })
    }
  }

  return new Promise<HookRunResult>((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      if (options.type === 'command') {
        child = spawn(options.command, {
          cwd,
          env,
          shell: options.shell ?? true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } else {
        child = spawn(options.command, options.args ?? [], {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      }
    } catch (error) {
      resolvePromise(
        baseResult({
          status: 'spawn_error',
          blockRequested: false,
          durationMs: Date.now() - startedAt,
          diagnostics: [
            {
              code: 'hook_spawn_error',
              message: error instanceof Error ? error.message : String(error)
            }
          ]
        })
      )
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutLen = 0
    let stderrLen = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let spawnError: Error | null = null
    let settled = false

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLen >= maxOutputBytes) {
        stdoutTruncated = true
        return
      }
      const remaining = maxOutputBytes - stdoutLen
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining))
        stdoutLen = maxOutputBytes
        stdoutTruncated = true
      } else {
        stdoutChunks.push(chunk)
        stdoutLen += chunk.length
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen >= maxOutputBytes) {
        stderrTruncated = true
        return
      }
      const remaining = maxOutputBytes - stderrLen
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining))
        stderrLen = maxOutputBytes
        stderrTruncated = true
      } else {
        stderrChunks.push(chunk)
        stderrLen += chunk.length
      }
    })
    child.stdin?.on('error', () => {})
    if (options.stdin !== undefined && options.stdin !== '') {
      try {
        child.stdin?.write(options.stdin)
      } catch {
      }
    }
    try {
      child.stdin?.end()
    } catch {
    }

    const timer = setTimeout(() => {
      timedOut = true
      killHookProcess(child)
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (error: Error) => {
      spawnError = error
      if (child.pid === undefined && !settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise(
          baseResult({
            status: 'spawn_error',
            blockRequested: false,
            durationMs: Date.now() - startedAt,
            diagnostics: [{ code: 'hook_spawn_error', message: error.message }]
          })
        )
      }
    })

    child.on('close', (code: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      const durationMs = Date.now() - startedAt
      const truncated = stdoutTruncated || stderrTruncated
      if (spawnError) {
        resolvePromise(
          baseResult({
            status: 'spawn_error',
            exitCode: code,
            signal,
            stdout,
            stderr,
            truncated,
            durationMs,
            blockRequested: false,
            diagnostics: [{ code: 'hook_spawn_error', message: spawnError.message }]
          })
        )
        return
      }
      if (timedOut) {
        resolvePromise(
          baseResult({
            status: 'timeout',
            exitCode: code,
            signal,
            stdout,
            stderr,
            truncated,
            durationMs,
            blockRequested: false,
            diagnostics: [
              { code: 'hook_timeout', message: `Hook timed out after ${timeoutMs}ms` }
            ]
          })
        )
        return
      }
      if (code === 0) {
        const parsed = parseHookStdout(stdout)
        if (parsed.invalid !== undefined) {
          resolvePromise(
            baseResult({
              status: 'failed',
              exitCode: code,
              signal,
              stdout,
              stderr,
              truncated,
              durationMs,
              blockRequested: false,
              diagnostics: [{ code: 'hook_output_invalid', message: parsed.invalid }]
            })
          )
          return
        }
        resolvePromise(
          baseResult({
            status: 'ok',
            exitCode: code,
            signal,
            stdout,
            stderr,
            truncated,
            durationMs,
            blockRequested: false,
            ...(parsed.output !== undefined ? { output: parsed.output } : {})
          })
        )
        return
      }
      if (code === 2) {
        // A vetoing hook states its reason as JSON on stdout — the parsed reason
        // is the model-facing text; raw stderr/stdout is only the fallback.
        const parsed = parseHookStdout(stdout)
        const parsedReason =
          parsed.output !== undefined && typeof parsed.output.reason === 'string'
            ? parsed.output.reason
            : parsed.output !== undefined && typeof parsed.output.stopReason === 'string'
              ? parsed.output.stopReason
              : undefined
        resolvePromise(
          baseResult({
            status: 'ok',
            exitCode: code,
            signal,
            stdout,
            stderr,
            truncated,
            durationMs,
            blockRequested: true,
            ...(parsed.output !== undefined ? { output: parsed.output } : {}),
            blockReason:
              parsedReason ??
              trimForPreview(stderr) ??
              trimForPreview(stdout) ??
              'Hook blocked execution'
          })
        )
        return
      }
      resolvePromise(
        baseResult({
          status: code === null ? 'killed' : 'failed',
          exitCode: code,
          signal,
          stdout,
          stderr,
          truncated,
          durationMs,
          blockRequested: false,
          diagnostics: [
            {
              code: 'hook_exit_nonzero',
              message:
                trimForPreview(stderr) ?? `Hook process exited with status ${String(code)}`
            }
          ]
        })
      )
    })
  })
}
