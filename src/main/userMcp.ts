import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ContractError } from '../shared/contract'
import type {
  UserMcpSaveInput,
  UserMcpServerConfig,
  UserMcpServerSummary
} from '../shared/contract'
import type { PluginMcpServerConfig, PluginResourceSpec } from '../shared/kernel-protocol'
import { writeFileAtomically } from './marketplaceAtomic'

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

function mcpFilePath(): string {
  return join(homedir(), '.flexagent', 'mcp.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new ContractError('INVALID_INPUT', `"${field}" must be an object`)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new ContractError('INVALID_INPUT', `"${field}.${key}" must be a string`)
    }
    out[key] = entry
  }
  return out
}

/** Structural validation shared by file loads (lenient → skip) and saves (strict → throw). */
function validateConfig(raw: unknown, strict: boolean): UserMcpServerConfig {
  if (!isRecord(raw)) {
    if (strict) throw new ContractError('INVALID_INPUT', 'config must be an object')
    throw new ContractError('INVALID_INPUT', 'config must be an object')
  }
  const type = raw.type === 'http' ? 'http' : raw.type === 'stdio' ? 'stdio' : undefined
  if (type === undefined) {
    throw new ContractError('INVALID_INPUT', 'config.type must be "stdio" or "http"')
  }
  const expose = raw.expose === 'direct' ? 'direct' : raw.expose === 'proxy' ? 'proxy' : undefined
  if (raw.expose !== undefined && expose === undefined) {
    throw new ContractError('INVALID_INPUT', 'config.expose must be "proxy" or "direct"')
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new ContractError('INVALID_INPUT', 'config.enabled must be a boolean')
  }
  if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== 'number' || raw.timeoutMs <= 0)) {
    throw new ContractError('INVALID_INPUT', 'config.timeoutMs must be a positive number')
  }
  if (raw.envInherit !== undefined && typeof raw.envInherit !== 'boolean') {
    throw new ContractError('INVALID_INPUT', 'config.envInherit must be a boolean')
  }
  const args =
    raw.args === undefined
      ? undefined
      : Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string')
        ? (raw.args as string[])
        : undefined
  if (raw.args !== undefined && args === undefined) {
    throw new ContractError('INVALID_INPUT', 'config.args must be a string array')
  }
  const config: UserMcpServerConfig = {
    type,
    ...('enabled' in raw ? { enabled: raw.enabled as boolean } : {}),
    ...(expose !== undefined ? { expose } : {}),
    ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs as number } : {}),
    ...(raw.envInherit !== undefined ? { envInherit: raw.envInherit as boolean } : {}),
    ...(type === 'stdio'
      ? {
          command: (() => {
            if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
              throw new ContractError('INVALID_INPUT', 'stdio server requires "command"')
            }
            return raw.command
          })(),
          ...(args !== undefined ? { args } : {}),
          ...(typeof raw.cwd === 'string' && raw.cwd.length > 0 ? { cwd: raw.cwd } : {}),
          // Nested, not spread: spreading put every env key at the top level of
          // the config (and wrote `Authorization: Bearer …` into mcp.json as a
          // stray top-level field), so the values were never read back as
          // `config.env` and never reached the server.
          ...(raw.env !== undefined ? { env: stringMap(raw.env, 'config.env') ?? {} } : {})
        }
      : {
          url: (() => {
            if (typeof raw.url !== 'string' || raw.url.length === 0) {
              throw new ContractError('INVALID_INPUT', 'http server requires "url"')
            }
            try {
              const parsed = new URL(raw.url)
              if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error('bad protocol')
              }
              return raw.url
            } catch {
              throw new ContractError('INVALID_INPUT', 'config.url must be a valid http(s) URL')
            }
          })(),
          ...(raw.headers !== undefined
            ? { headers: stringMap(raw.headers, 'config.headers') ?? {} }
            : {})
        })
  }
  return config
}

function parseFile(raw: string): Record<string, UserMcpServerConfig> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ContractError(
      'INVALID_INPUT',
      `mcp.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`
    )
  }
  if (!isRecord(parsed)) throw new ContractError('INVALID_INPUT', 'mcp.json root must be an object')
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const out: Record<string, UserMcpServerConfig> = {}
  for (const [name, entry] of Object.entries(servers)) {
    if (!NAME_RE.test(name)) continue
    try {
      out[name] = validateConfig(entry, false)
    } catch {
      continue
    }
  }
  return out
}

async function persist(servers: Record<string, UserMcpServerConfig>): Promise<void> {
  try {
    await writeFileAtomically(
      mcpFilePath(),
      JSON.stringify({ mcpServers: sortServers(servers) }, null, 2) + '\n'
    )
  } catch (err) {
    throw new ContractError(
      'KERNEL_INTERNAL',
      `Failed to write mcp.json: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

function sortServers(servers: Record<string, UserMcpServerConfig>): Record<string, UserMcpServerConfig> {
  const out: Record<string, UserMcpServerConfig> = {}
  for (const name of Object.keys(servers).sort()) out[name] = servers[name]
  return out
}

function loadServers(): Record<string, UserMcpServerConfig> {
  const file = mcpFilePath()
  if (!existsSync(file)) return {}
  try {
    return parseFile(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function summarize(servers: Record<string, UserMcpServerConfig>): UserMcpServerSummary[] {
  return Object.entries(servers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => ({ name, config }))
}

function requireName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new ContractError('INVALID_INPUT', 'name must match [a-zA-Z0-9_-]{1,64}')
  }
  return name
}

export class UserMcpService {
  list(): UserMcpServerSummary[] {
    return summarize(loadServers())
  }

  async save(input: UserMcpSaveInput): Promise<UserMcpServerSummary[]> {
    if (input === null || typeof input !== 'object') {
      throw new ContractError('INVALID_INPUT', 'expected { name, config }')
    }
    const name = requireName(input.name)
    const config = validateConfig(input.config, true)
    const servers = loadServers()
    servers[name] = config
    await persist(servers)
    return summarize(servers)
  }

  async remove(name: string): Promise<UserMcpServerSummary[]> {
    const key = requireName(name)
    const servers = loadServers()
    if (!(key in servers)) {
      throw new ContractError('USER_MCP_NOT_FOUND', `Unknown MCP server: ${key}`)
    }
    delete servers[key]
    await persist(servers)
    return summarize(servers)
  }

  async toggle(name: string, enabled: boolean): Promise<UserMcpServerSummary[]> {
    const key = requireName(name)
    if (typeof enabled !== 'boolean') {
      throw new ContractError('INVALID_INPUT', 'enabled must be a boolean')
    }
    const servers = loadServers()
    const existing = servers[key]
    if (!existing) {
      throw new ContractError('USER_MCP_NOT_FOUND', `Unknown MCP server: ${key}`)
    }
    servers[key] = { ...existing, enabled }
    await persist(servers)
    return summarize(servers)
  }
}

/** Convert one stored entry to the worker-facing shape (no plugin interpolation). */
function toPluginConfig(config: UserMcpServerConfig): PluginMcpServerConfig {
  const expose = config.expose === 'direct' ? ({ expose: 'direct' } as const) : {}
  const inherit = config.envInherit === true ? ({ envInherit: true } as const) : {}
  if (config.type === 'http') {
    return {
      type: 'http',
      url: config.url ?? '',
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      env: {},
      ...expose,
      ...inherit,
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {})
    }
  }
  return {
    type: 'stdio',
    command: config.command ?? '',
    ...(config.args !== undefined && config.args.length > 0 ? { args: config.args } : {}),
    env: { ...(config.env ?? {}) },
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...expose,
    ...inherit,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {})
  }
}

/**
 * Merge enabled user-level servers into a resource spec under the
 * `user:<name>` namespace (plugins use `plugin:<name>:<server>`).
 * Mutates and returns the spec.
 */
export function mergeUserMcpIntoSpec(spec: PluginResourceSpec): PluginResourceSpec {
  const servers = loadServers()
  for (const [name, config] of Object.entries(servers)) {
    if (config.enabled === false) continue
    if (spec.mcpServers === undefined) spec.mcpServers = {}
    spec.mcpServers[`user:${name}`] = toPluginConfig(config)
  }
  return spec
}

/** True when a bridge server key was contributed by the user-level file. */
export function isUserMcpKey(key: string): boolean {
  return key.startsWith('user:')
}
