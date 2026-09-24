import { spawn } from 'child_process'

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000
export const DEFAULT_HOOK_MAX_OUTPUT_BYTES = 32_768

export interface HookRunPlugin {
  rootPath: string
  dataPath: string
  id: string
  name: string
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
}

export type HookRunStatus = 'ok' | 'failed' | 'timeout' | 'killed' | 'spawn_error'

export interface HookRunDiagnostic {
  code: 'hook_timeout' | 'hook_spawn_error' | 'hook_exit_nonzero' | 'hook_output_invalid'
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
  const overlay = createHookEnvOverlay(options.plugin, options.cwd)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) env[key] = value
  }
  for (const [key, value] of Object.entries(overlay)) env[key] = value

  return new Promise<HookRunResult>((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      if (options.type === 'command') {
        child = spawn(options.command, {
          cwd: options.cwd,
          env,
          shell: options.shell ?? true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } else {
        child = spawn(options.command, options.args ?? [], {
          cwd: options.cwd,
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
            blockReason:
              trimForPreview(stderr) ?? trimForPreview(stdout) ?? 'Hook blocked execution'
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
