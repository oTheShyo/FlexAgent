import { existsSync, readFileSync } from 'fs'
import { chmod } from 'fs/promises'
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
import {
  CredentialError,
  UNREADABLE_MARK,
  decryptSecret,
  encryptSecret,
  isEnvelope,
  vaultAlgorithm
} from './security/credentialVault'

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

/**
 * The secret-bearing field of a stored config, per transport: an `http` server
 * carries its credential in `headers`, a `stdio` server exports one to the
 * child process as `env`. Both are `{ [name]: string }` all the way up to the
 * IPC payload, so both are sealed value-by-value rather than as one map.
 */
interface SecretField {
  field: 'env' | 'headers'
  values: Record<string, string>
}

function secretFields(config: UserMcpServerConfig): SecretField[] {
  if (config.type === 'stdio') {
    return config.env === undefined ? [] : [{ field: 'env', values: config.env }]
  }
  return config.headers === undefined ? [] : [{ field: 'headers', values: config.headers }]
}

/**
 * Seal every plaintext secret in place, and report how many were sealed. Applied
 * to *every* write, so a plaintext value can only ever live in memory that is
 * about to be sealed — there is no second code path that could still write one.
 */
function sealConfig(config: UserMcpServerConfig): number {
  let sealed = 0
  for (const { field, values } of secretFields(config)) {
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      // The marker is not a secret. Re-sealing it would hide the fact that
      // something is wrong behind a value that looks like a real credential.
      if (isEnvelope(value) || value === UNREADABLE_MARK) {
        next[key] = value
        continue
      }
      next[key] = encryptSecret(value)
      sealed += 1
    }
    if (field === 'env' && config.type === 'stdio') config.env = next
    else config.headers = next
  }
  return sealed
}

/**
 * Open every secret in a config that just came off disk. Returns how much work
 * the caller has to do: `legacy` values were plaintext and need re-sealing,
 * `failed` values are unreadable and were replaced by the marker.
 *
 * `strict` decides what an unreadable value costs. The editing paths (`save`,
 * `remove`, `toggle`) use it and fail: writing a server whose token comes back
 * as a marker is a lie the user discovers later, from the server refusing to
 * connect. The display path and the worker-facing merge use the relaxed mode:
 * the entry survives, the console says which one, and `UNREADABLE_MARK` is
 * visible in the value. Losing the entry would be the one outcome nobody can
 * recover from without a backup.
 */
function openSecrets(
  config: UserMcpServerConfig,
  where: string,
  strict: boolean
): { config: UserMcpServerConfig; legacy: number; failed: number } {
  let legacy = 0
  let failed = 0
  for (const { field, values } of secretFields(config)) {
    const opened: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      if (!isEnvelope(value)) {
        // Plaintext on disk is a pre-vault file. Keep using it — it is the only
        // copy that exists — and let the caller re-seal it on the next write.
        legacy += 1
        opened[key] = value
        continue
      }
      try {
        opened[key] = decryptSecret(value, `${where} ${field}.${key}`)
      } catch (err) {
        failed += 1
        opened[key] = UNREADABLE_MARK
        // Names the entry, never the value: this line is console output, and a
        // console is where secrets end up in a bug report.
        const reason = err instanceof Error ? err.message : String(err)
        console.error(
          `[credential-vault] ${where} ${field}.${key} is unreadable (${reason}); ` +
            `the entry is kept, the value replaced by ${UNREADABLE_MARK}`
        )
        if (strict) throw asServiceError(err)
      }
    }
    if (field === 'env' && config.type === 'stdio') config.env = opened
    else config.headers = opened
  }
  return { config, legacy, failed }
}

/** A credential failure is the user's to act on, so it leaves as a ContractError. */
function asServiceError(err: unknown): ContractError {
  if (err instanceof CredentialError) {
    return new ContractError('KERNEL_INTERNAL', err.message)
  }
  return new ContractError('KERNEL_INTERNAL', err instanceof Error ? err.message : String(err))
}

function logMigration(file: string, migrated: number, failed: number): void {
  const alg = vaultAlgorithm()
  console.info(
    `[credential-vault] migrated ${file}: ${migrated} plaintext value(s) re-sealed with ${alg}` +
      (failed > 0 ? `, ${failed} value(s) still unreadable` : '')
  )
}

/** Structural validation shared by file loads (lenient → skip) and saves (strict → throw). */
function validateConfig(raw: unknown, strict: boolean): UserMcpServerConfig {
  if (!isRecord(raw)) {
    if (strict) throw new ContractError('INVALID_INPUT', 'config must be an object')
    throw new ContractError('INVALID_INPUT', 'config must be an object')
  }
  const type =
    raw.type === 'http' ? 'http' : raw.type === 'stdio' ? 'stdio' : raw.type === 'sse' ? 'sse' : undefined
  if (type === undefined) {
    throw new ContractError('INVALID_INPUT', 'config.type must be "stdio", "http" or "sse"')
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
              throw new ContractError('INVALID_INPUT', `${type} server requires "url"`)
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
  const file = mcpFilePath()
  // Sealed on the way out, sorted for a stable diff — no write in this process
  // can reach the file with a plaintext value in it.
  const mcpServers: Record<string, UserMcpServerConfig> = {}
  for (const name of Object.keys(servers).sort()) {
    sealConfig(servers[name])
    mcpServers[name] = servers[name]
  }
  try {
    await writeFileAtomically(file, JSON.stringify({ mcpServers }, null, 2) + '\n')
  } catch (err) {
    throw new ContractError(
      'KERNEL_INTERNAL',
      `Failed to write mcp.json: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  // Best effort, and deliberately outside the write above: the encryption is
  // what makes the file safe to share, the mode is a second line of defence
  // that must not be able to fail a save.
  try {
    await chmod(file, 0o600)
  } catch {
    /* Windows ignores POSIX modes; nothing else to do. */
  }
}

interface LoadedServers {
  servers: Record<string, UserMcpServerConfig>
  /** Plaintext values that were opened and need a re-seal. */
  migrated: number
  failed: number
}

/** Parse + open everything. Synchronous because `mergeUserMcpIntoSpec` is. */
function readServers(strict: boolean): LoadedServers {
  const file = mcpFilePath()
  if (!existsSync(file)) return { servers: {}, migrated: 0, failed: 0 }
  let entries: Record<string, UserMcpServerConfig>
  try {
    entries = parseFile(readFileSync(file, 'utf8'))
  } catch {
    // A file the kernel-shaped loader also treats leniently: an unparsable
    // mcp.json reads as "nothing configured" rather than as a dialog box.
    // Pre-existing behaviour, out of scope here — the vault only adds failures
    // it is asked to raise about values it can actually decode.
    return { servers: {}, migrated: 0, failed: 0 }
  }
  const servers: Record<string, UserMcpServerConfig> = {}
  let migrated = 0
  let failed = 0
  for (const [name, config] of Object.entries(entries)) {
    const opened = openSecrets(config, `mcp server "${name}"`, strict)
    migrated += opened.legacy
    failed += opened.failed
    servers[name] = opened.config
  }
  return { servers, migrated, failed }
}

/**
 * Read, and on a legacy file migrate in place.
 *
 * Migration is the one-way door the acceptance criterion asks for: the plaintext
 * is opened only so it can be immediately re-sealed and overwritten, so a file
 * that was ever plaintext is plaintext-free after its first read. If the
 * overwrite itself fails we do not throw — the values are already usable in
 * memory and the file on disk is still the one that was configured, which is
 * strictly better than refusing to start.
 */
async function loadServers(strict: boolean): Promise<LoadedServers> {
  const loaded = readServers(strict)
  if (loaded.migrated > 0) {
    try {
      await persist(loaded.servers)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        `[credential-vault] migration could not rewrite ${mcpFilePath()} (${reason}); ` +
          'the plaintext values stay usable in memory until the next save'
      )
    }
    logMigration(mcpFilePath(), loaded.migrated, loaded.failed)
  }
  return loaded
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
  /**
   * Async so a legacy file is migrated on the read the user actually performs:
   * `guard()` unwraps the promise, so the IPC contract and the renderer's data
   * are both unchanged.
   */
  async list(): Promise<UserMcpServerSummary[]> {
    return summarize((await loadServers(false)).servers)
  }

  async save(input: UserMcpSaveInput): Promise<UserMcpServerSummary[]> {
    if (input === null || typeof input !== 'object') {
      throw new ContractError('INVALID_INPUT', 'expected { name, config }')
    }
    const name = requireName(input.name)
    const config = validateConfig(input.config, true)
    // Strict: an edit that cannot be read back must not be written.
    const { servers } = await loadServers(true)
    servers[name] = config
    await persist(servers)
    return summarize(servers)
  }

  async remove(name: string): Promise<UserMcpServerSummary[]> {
    const key = requireName(name)
    const { servers } = await loadServers(true)
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
    const { servers } = await loadServers(true)
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
  const loaded = readServers(false)
  // Fire-and-forget: the spec has to be built synchronously and the plaintext
  // is already open, so a legacy file only needs its on-disk copy tidied. A
  // failure here costs nothing — the next save rewrites it anyway.
  if (loaded.migrated > 0) {
    const file = mcpFilePath()
    void persist(loaded.servers).catch(() => {
      console.error(`[credential-vault] could not re-seal ${file}`)
    })
    logMigration(file, loaded.migrated, loaded.failed)
  }
  const servers = loaded.servers
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
