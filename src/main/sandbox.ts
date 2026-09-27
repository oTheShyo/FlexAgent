/**
 * Plugin / hook sandbox policy (ticket 22) — pure logic.
 *
 * Hooks and plugin extensions used to run with `shell: true` and the entire
 * parent environment. That is not a sandbox, it is a subprocess: a hook could
 * read every API key this process holds, and nothing recorded that it might
 * want to use the network.
 *
 * This module holds the policy — what a plugin is allowed to reach, what its
 * subprocess can see, and what a user must agree to first. It is deliberately
 * separated from `hookRunner` so the rules are testable without spawning
 * anything.
 *
 * **What is enforced, and what is not.** Enforced here: the environment a child
 * process inherits (allowlist, not inherit), the directory it starts in, and
 * whether it runs at all when it asks for more than it was granted. Not
 * enforced, and not pretended to be: the file reads a spawned process performs
 * afterwards. Windows gives Node no job object or AppContainer to put a child
 * inside, so "the hook may only touch the workspace" is enforced at the
 * boundaries this process controls and *declared* for everything past them.
 * That gap is written down rather than papered over.
 */
import { join, normalize, resolve, sep } from 'path'
import { homedir } from 'os'
import { readFileSync } from 'fs'
import { writeFileAtomically } from './marketplaceAtomic'
import { LEAST_PRIVILEGE, type FsScope, type PluginCapabilities } from '../shared/contract'

export type { FsScope, PluginCapabilities }

/**
 * Env keys a child process may see under `env: 'minimal'`.
 *
 * Deliberately narrow: `PATH`-family keys so the command can run at all, and
 * nothing that identifies the user or carries a credential. Everything a hook
 * legitimately needs about the project and its plugin arrives through the
 * documented `FLEX_*` overlay instead.
 */
const MINIMAL_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'TEMP',
  'TMP',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE'
] as const

export function defaultCapabilitiesFor(
  sourceKind: 'bundled' | 'local' | 'marketplace'
): PluginCapabilities {
  switch (sourceKind) {
    case 'marketplace':
      return { ...LEAST_PRIVILEGE }
    case 'bundled':
    case 'local':
    default:
      // Installed by hand or shipped by us: the workspace is the point, and the
      // environment is still not inherited — a hand-installed plugin is no more
      // entitled to this process's secrets than a downloaded one.
      return { fs: 'workspace', env: 'minimal', network: false }
  }
}

/**
 * The environment a subprocess is handed.
 *
 * `minimal` starts from the allowlist rather than from `process.env`, because
 * "copy everything then remove what we know is bad" only removes what we
 * already thought of.
 */
export function buildSandboxEnv(input: {
  capabilities: PluginCapabilities
  /** Extra vars (the documented FLEX_* and ZCODE_* overlay), applied last. */
  overlay?: Record<string, string>
  /** Only read when capabilities.env is 'inherit'. */
  parent?: Record<string, string | undefined>
}): Record<string, string> {
  if (input.capabilities.env === 'inherit') {
    const all: Record<string, string> = {}
    for (const [key, value] of Object.entries(input.parent ?? process.env)) {
      if (value !== undefined) all[key] = value
    }
    return { ...all, ...(input.overlay ?? {}) }
  }

  const minimal: Record<string, string> = {}
  const parent = input.parent ?? process.env
  for (const key of MINIMAL_ENV_KEYS) {
    const value = parent[key]
    if (typeof value === 'string' && value.length > 0) minimal[key] = value
  }
  return { ...minimal, ...(input.overlay ?? {}) }
}

/**
 * The directory a subprocess starts in — the first half of "file access is
 * limited", and the half this process can actually guarantee.
 */
export function resolveSandboxCwd(input: {
  capabilities: PluginCapabilities
  workspaceCwd: string
  pluginDataPath?: string
}): string {
  if (input.capabilities.fs === 'plugin-data') {
    return input.pluginDataPath ?? input.workspaceCwd
  }
  if (input.capabilities.fs === 'none') {
    return input.pluginDataPath ?? input.workspaceCwd
  }
  return input.workspaceCwd
}

/**
 * The roots a plugin's file access is bounded by, for the FS guard.
 *
 * `fs: 'none'` gets the plugin's own directories *not* added: it asked for no
 * files, and its own source is not a reason to hand it the disk.
 */
export function sandboxRoots(input: {
  capabilities: PluginCapabilities
  workspaceCwd: string
  pluginRoot?: string
  pluginDataPath?: string
}): string[] {
  const roots: string[] = []
  if (input.capabilities.fs === 'workspace') roots.push(normalize(resolve(input.workspaceCwd)))
  if (input.capabilities.fs !== 'none') {
    if (input.pluginRoot !== undefined) roots.push(normalize(resolve(input.pluginRoot)))
    if (input.pluginDataPath !== undefined) roots.push(normalize(resolve(input.pluginDataPath)))
  }
  return roots
}

/**
 * Whether `target` lies inside one of the roots.
 *
 * Used where this process does the reading on a plugin's behalf (plugin file
 * access through the bridge). A subprocess is not bound by this — see the note
 * at the top of the file.
 */
export function isPathAllowed(target: string, roots: readonly string[]): boolean {
  if (target.length === 0) return false
  const resolved = normalize(resolve(target))
  return roots.some((root) => resolved === root || resolved.startsWith(root + sep))
}

/** What to show a user before they enable a plugin. Plain, one line each. */
export function describeCapabilities(capabilities: PluginCapabilities): string[] {
  const lines: string[] = []
  lines.push(
    capabilities.fs === 'workspace'
      ? 'Read and write files in this project'
      : capabilities.fs === 'plugin-data'
        ? 'Read and write only its own data directory'
        : 'No file access'
  )
  lines.push(
    capabilities.env === 'minimal'
      ? 'Sees a minimal environment (no credentials)'
      : 'Sees the full environment, including credentials'
  )
  lines.push(capabilities.network ? 'May access the network' : 'No network access')
  return lines
}

/**
 * Anything a plugin declares beyond what its source already gets has to be
 * granted by a person. Default-never-ask is how a capability prompt becomes a
 * formality.
 */
export function needsConsent(
  declared: PluginCapabilities,
  baseline: PluginCapabilities
): boolean {
  return declared.network !== baseline.network || declared.env !== baseline.env || fsRank(declared.fs) > fsRank(baseline.fs)
}

function fsRank(scope: FsScope): number {
  return scope === 'none' ? 0 : scope === 'plugin-data' ? 1 : 2
}

/** Merge a partial manifest declaration over its source's defaults. */
export function mergeCapabilities(
  base: PluginCapabilities,
  declared: Partial<PluginCapabilities> | undefined
): PluginCapabilities {
  if (declared === undefined) return { ...base }
  return {
    fs: declared.fs ?? base.fs,
    env: declared.env ?? base.env,
    network: declared.network ?? base.network
  }
}

// ─── Grants ──────────────────────────────────────────────────────────────────

export interface PluginGrant {
  capabilities: PluginCapabilities
  grantedAt: number
  /** `default` = its source's baseline, never shown; `user` = explicitly agreed. */
  origin: 'default' | 'user'
}

/** Resolved per call so tests can point `FLEXAGENT_HOME` at a temp dir. */
function grantsFile(): string {
  return join(
    process.env.FLEXAGENT_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.flexagent'),
    'plugin-grants.json'
  )
}

interface GrantsShape {
  grants: Record<string, PluginGrant>
}

/**
 * Grants are cached, keyed by the home they were read from.
 *
 * The write is asynchronous (`writeFileAtomically`), and a hook can run in the
 * same tick as the grant that allows it — so the cache is what the process
 * believes, and the file is what survives a restart. Reading the file back
 * after every write would make a grant invisible until the next tick, which is
 * exactly the window in which it matters.
 */
let grantsCache: { home: string; grants: Record<string, PluginGrant> } | null = null

export function readGrants(): Record<string, PluginGrant> {
  const home = grantsFile()
  if (grantsCache !== null && grantsCache.home === home) return grantsCache.grants
  let grants: Record<string, PluginGrant> = {}
  try {
    const raw = JSON.parse(readFileSync(home, 'utf-8')) as GrantsShape
    grants = raw.grants ?? {}
  } catch {
    grants = {}
  }
  grantsCache = { home, grants }
  return grants
}

function writeGrants(grants: Record<string, PluginGrant>): void {
  grantsCache = { home: grantsFile(), grants }
  void writeFileAtomically(grantsFile(), JSON.stringify({ grants }, null, 2)).catch(() => {
    // Best-effort: an unwritable grants file must not cost the user a plugin.
    // The cache above already carries the decision for this run.
  })
}

export function grantCapabilities(
  pluginId: string,
  capabilities: PluginCapabilities,
  origin: 'default' | 'user' = 'user'
): PluginGrant {
  const grants = readGrants()
  const record: PluginGrant = { capabilities, grantedAt: Date.now(), origin }
  grants[pluginId] = record
  writeGrants(grants)
  return record
}

/** Forget a plugin's grant — it falls back to its source's baseline. */
export function revokeGrant(pluginId: string): void {
  const grants = readGrants()
  if (!(pluginId in grants)) return
  delete grants[pluginId]
  writeGrants(grants)
}

export function grantFor(pluginId: string): PluginGrant | undefined {
  return readGrants()[pluginId]
}

/** The capabilities a plugin actually runs with: its grant, or its baseline. */
export function effectiveCapabilities(
  pluginId: string,
  sourceKind: 'bundled' | 'local' | 'marketplace',
  declared: Partial<PluginCapabilities> | undefined
): PluginCapabilities {
  const baseline = defaultCapabilitiesFor(sourceKind)
  const wanted = mergeCapabilities(baseline, declared)
  const grant = grantFor(pluginId)
  // A grant can only ever be the whole request or the baseline: half-granted
  // capabilities need a UI to choose from, and this process has no such UI.
  if (grant !== undefined && (grant.origin === 'user' || !needsConsent(wanted, baseline))) {
    return grant.capabilities
  }
  return baseline
}

/**
 * Everything the UI needs to ask a person about one plugin in one call.
 *
 * `needsGrant` is what drives the prompt; `capabilities` is what the plugin
 * runs with *right now*, so the panel shows the consequences of refusing
 * rather than only the request.
 */
export interface CapabilityRequest {
  /** What it runs with today — the grant if there is one, else the baseline. */
  capabilities: PluginCapabilities
  /** What its manifest asked for. Absent = it asks for nothing. */
  declared?: Partial<PluginCapabilities>
  /** What it would run with if the request were granted as written. */
  requested: PluginCapabilities
  /** True when `requested` is more than its source already gives it. */
  needsGrant: boolean
  /** True when a person has already said yes (or no) to this. */
  granted: boolean
  /** One line per capability, for the consent panel. */
  lines: string[]
}

export function capabilityRequest(
  pluginId: string,
  sourceKind: 'bundled' | 'local' | 'marketplace',
  declared: Partial<PluginCapabilities> | undefined
): CapabilityRequest {
  const baseline = defaultCapabilitiesFor(sourceKind)
  const requested = mergeCapabilities(baseline, declared)
  const grant = grantFor(pluginId)
  return {
    capabilities: effectiveCapabilities(pluginId, sourceKind, declared),
    ...(declared !== undefined ? { declared } : {}),
    requested,
    needsGrant: needsConsent(requested, baseline),
    granted: grant !== undefined && grant.origin === 'user',
    lines: describeCapabilities(requested)
  }
}

/** Grant or refuse: `capabilities === null` revokes, back to the baseline. */
export function setCapabilities(
  pluginId: string,
  sourceKind: 'bundled' | 'local' | 'marketplace',
  capabilities: PluginCapabilities | null
): PluginCapabilities {
  if (capabilities === null) {
    revokeGrant(pluginId)
    return defaultCapabilitiesFor(sourceKind)
  }
  grantCapabilities(pluginId, capabilities)
  return capabilities
}
