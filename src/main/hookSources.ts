import { existsSync, readFileSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import type { PluginCapabilities } from '../shared/contract'

export type HookSourceDiagnosticCode =
  | 'plugin_hook_read_failed'
  | 'plugin_hook_invalid'
  | 'plugin_component_path_invalid'
  | 'plugin_hook_duplicate'
  | 'plugin_unsupported_component'

export interface HookSourceDiagnostic {
  code: HookSourceDiagnosticCode
  severity: 'error' | 'warning'
  message: string
}

export interface HookSource {
  path: string
  content: string
}

export interface HookDiscoveryResult {
  sources: HookSource[]
  diagnostics: HookSourceDiagnostic[]
}

export interface HookEntry {
  event: string
  matcher?: string
  type: 'command' | 'process'
  command: string
  args?: string[]
  shell?: string | true
  timeoutMs?: number
  sourcePath: string
}

export interface HookParseResult {
  entries: HookEntry[]
  diagnostics: HookSourceDiagnostic[]
  /**
   * Ticket 22 (additive): what this hooks file asks for, declared next to the
   * hooks themselves. A file that declares nothing keeps the baseline for its
   * source — the migration path is opt-in per file, not a flag day.
   */
  capabilities?: Partial<PluginCapabilities>
}

export const STANDARD_HOOKS_PATH = join('hooks', 'hooks.json')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function resolveInside(rootPath: string, target: string): string | null {
  const resolved = resolve(rootPath, target)
  const rel = relative(rootPath, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return resolved
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readHookSourceFile(
  path: string,
  diagnostics: HookSourceDiagnostic[],
  seen: Set<string>
): HookSource | null {
  const real = realpathOrSelf(path)
  if (seen.has(real)) {
    diagnostics.push({
      code: 'plugin_hook_duplicate',
      severity: 'warning',
      message: `Duplicate plugin hooks file ignored: ${path}`
    })
    return null
  }
  try {
    const content = readFileSync(path, 'utf8')
    seen.add(real)
    return { path, content }
  } catch (error) {
    diagnostics.push({
      code: 'plugin_hook_read_failed',
      severity: 'error',
      message: error instanceof Error ? error.message : `Failed to read plugin hooks: ${path}`
    })
    return null
  }
}

export function discoverHookSources(input: {
  rootPath: string
  manifestPath?: string
  manifestHooks?: unknown
}): HookDiscoveryResult {
  const sources: HookSource[] = []
  const diagnostics: HookSourceDiagnostic[] = []
  const seen = new Set<string>()

  const standardPath = join(input.rootPath, STANDARD_HOOKS_PATH)
  if (existsSync(standardPath)) {
    const source = readHookSourceFile(standardPath, diagnostics, seen)
    if (source) sources.push(source)
  }

  if (input.manifestHooks === undefined || input.manifestHooks === null) {
    return { sources, diagnostics }
  }
  const specs = Array.isArray(input.manifestHooks)
    ? input.manifestHooks
    : [input.manifestHooks]
  for (const spec of specs) {
    if (typeof spec === 'string') {
      const target = resolveInside(input.rootPath, spec)
      if (target === null) {
        diagnostics.push({
          code: 'plugin_component_path_invalid',
          severity: 'error',
          message: `Plugin hooks path escapes plugin root: ${spec}`
        })
        continue
      }
      if (!existsSync(target)) {
        diagnostics.push({
          code: 'plugin_hook_read_failed',
          severity: 'error',
          message: `Plugin hooks file not found: ${spec}`
        })
        continue
      }
      const source = readHookSourceFile(target, diagnostics, seen)
      if (source) sources.push(source)
      continue
    }
    diagnostics.push({
      code: 'plugin_unsupported_component',
      severity: 'warning',
      message: 'Inline hook declarations are not supported; declare a hooks file path.'
    })
  }
  return { sources, diagnostics }
}

export function parseHooksContent(content: string, sourcePath: string): HookParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    return {
      entries: [],
      diagnostics: [
        {
          code: 'plugin_hook_read_failed',
          severity: 'error',
          message:
            error instanceof Error ? error.message : `Failed to read plugin hooks: ${sourcePath}`
        }
      ]
    }
  }
  return extractHookEntries(raw, sourcePath)
}

export function extractHookEntries(raw: unknown, sourcePath: string): HookParseResult {
  const diagnostics: HookSourceDiagnostic[] = []
  const entries: HookEntry[] = []
  const declared = isRecord(raw) && isRecord(raw.capabilities) ? readCapabilities(raw.capabilities) : undefined
  if (!isRecord(raw) || !isRecord(raw.hooks)) {
    diagnostics.push({
      code: 'plugin_hook_invalid',
      severity: 'error',
      message: 'Plugin hooks file must contain a hooks object'
    })
    return { entries, diagnostics, ...(declared !== undefined ? { capabilities: declared } : {}) }
  }
  const hooksRoot = raw.hooks
  for (const [event, groups] of Object.entries(hooksRoot)) {
    if (!Array.isArray(groups)) {
      diagnostics.push({
        code: 'plugin_hook_invalid',
        severity: 'error',
        message: `Plugin hooks for ${event} must be an array of matcher groups`
      })
      continue
    }
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) {
        diagnostics.push({
          code: 'plugin_hook_invalid',
          severity: 'error',
          message: `Invalid matcher group for ${event} in ${sourcePath}`
        })
        continue
      }
      let matcher: string | undefined
      if (group.matcher !== undefined) {
        if (typeof group.matcher !== 'string' || group.matcher.length === 0) {
          diagnostics.push({
            code: 'plugin_hook_invalid',
            severity: 'error',
            message: `Invalid matcher for ${event} in ${sourcePath}`
          })
          continue
        }
        matcher = group.matcher
      }
      for (const config of group.hooks) {
        const entry = parseHookConfig(event, matcher, config, sourcePath, diagnostics)
        if (entry) entries.push(entry)
      }
    }
  }
  return { entries, diagnostics, ...(declared !== undefined ? { capabilities: declared } : {}) }
}

/**
 * Read a declared capability block. Unknown values are dropped rather than
 * guessed: a declaration that cannot be read means "baseline", not "whatever".
 */
function readCapabilities(raw: Record<string, unknown>): Partial<PluginCapabilities> | undefined {
  const out: Partial<PluginCapabilities> = {}
  if (raw.fs === 'none' || raw.fs === 'plugin-data' || raw.fs === 'workspace') out.fs = raw.fs
  if (raw.env === 'minimal' || raw.env === 'inherit') out.env = raw.env
  if (raw.network === true) out.network = true
  return Object.keys(out).length > 0 ? out : undefined
}

function parseHookConfig(
  event: string,
  matcher: string | undefined,
  config: unknown,
  sourcePath: string,
  diagnostics: HookSourceDiagnostic[]
): HookEntry | null {
  const invalid = (message: string): null => {
    diagnostics.push({ code: 'plugin_hook_invalid', severity: 'error', message })
    return null
  }
  if (!isRecord(config)) {
    return invalid(`Hook config for ${event} in ${sourcePath} must be an object`)
  }
  if (config.enabled === false) return null
  const type = config.type
  if (type !== 'command' && type !== 'process') {
    return invalid(`Hook config for ${event} in ${sourcePath} must have type command or process`)
  }
  if (typeof config.command !== 'string' || config.command.length === 0) {
    return invalid(`Hook config for ${event} in ${sourcePath} must have a non-empty command`)
  }
  let args: string[] | undefined
  if (config.args !== undefined) {
    if (!isStringArray(config.args)) {
      return invalid(`Hook args for ${event} in ${sourcePath} must be an array of strings`)
    }
    args = config.args
  }
  let shell: string | true | undefined
  if (config.shell !== undefined) {
    if (config.shell === true || (typeof config.shell === 'string' && config.shell.length > 0)) {
      shell = config.shell
    } else {
      return invalid(`Hook shell for ${event} in ${sourcePath} must be true or a shell path`)
    }
  }
  if (config.async !== undefined && typeof config.async !== 'boolean') {
    return invalid(`Hook async for ${event} in ${sourcePath} must be a boolean`)
  }
  if (config.statusMessage !== undefined && typeof config.statusMessage !== 'string') {
    return invalid(`Hook statusMessage for ${event} in ${sourcePath} must be a string`)
  }
  let timeoutMs: number | undefined
  if (config.timeoutMs !== undefined) {
    if (
      typeof config.timeoutMs !== 'number' ||
      !Number.isFinite(config.timeoutMs) ||
      config.timeoutMs <= 0
    ) {
      return invalid(`Hook timeoutMs for ${event} in ${sourcePath} must be a positive number`)
    }
    timeoutMs = Math.max(1, Math.round(config.timeoutMs))
  } else if (type === 'command' && config.timeout !== undefined) {
    if (
      typeof config.timeout !== 'number' ||
      !Number.isFinite(config.timeout) ||
      config.timeout <= 0
    ) {
      return invalid(`Hook timeout for ${event} in ${sourcePath} must be a positive number`)
    }
    timeoutMs = Math.max(1, Math.round(config.timeout * 1000))
  }
  return {
    event,
    ...(matcher !== undefined ? { matcher } : {}),
    type,
    command: config.command,
    ...(args !== undefined ? { args } : {}),
    ...(shell !== undefined ? { shell } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    sourcePath
  }
}
