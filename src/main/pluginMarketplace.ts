import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { promisify } from 'util'
import {
  ContractError,
  type AddMarketplaceInput,
  type InstallFromMarketplaceInput,
  type MarketplaceInfo,
  type MarketplaceProgressEvent,
  type MarketplaceSearchInput,
  type MarketplaceSearchResult,
  type MarketplaceInstallSource,
  type PluginId,
  type PluginSummary
} from '../shared/contract'
import {
  activateDirectoryAtomically,
  recoverAtomicTargetSync,
  writeFileAtomically,
  type AtomicDirectoryActivation
} from './marketplaceAtomic'
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  createArchiveFetchError,
  createGitUnavailableError,
  directoryExists,
  fileExists,
  isCommandUnavailableError,
  isRecord,
  resolveInside,
  sanitizePluginId
} from './marketplaceHelpers'
import {
  resolveGitHubArchiveSource,
  shouldFallbackGitHubArchiveToGit
} from './marketplaceGithub'
import {
  PluginZipDownloadError,
  isZipPluginUrlSource,
  readZipPluginSourceSha256,
  resolveHttpZipSource,
  resolveLocalZipSource,
  resolveZipPluginSource,
  type ResolvedZipPluginSourceRoot
} from './marketplaceZip'
import { comparePluginUpdate } from './marketplaceVersionCompare'
import { resolveNpmPackageSource } from './marketplaceNpm'
import { observePipeline } from './observability'
import { countComponents, enumerateComponents, findManifestPath, parseManifest } from './pluginManifest'
import type { PluginRecord, PluginRegistry } from './pluginRegistry'

const execFileAsync = promisify(execFile)

const KNOWN_MARKETPLACES_FILE = 'known_marketplaces.json'
const MARKETPLACE_FILE = 'marketplace.json'
const MARKETPLACE_JSON_MAX_BYTES = 10 * 1024 * 1024
const MARKETPLACE_JSON_MAX_REDIRECTS = 5
const MARKETPLACE_JSON_TIMEOUT_MS = 180_000
const CLAUDE_MARKETPLACE_FILE = join('.claude-plugin', 'marketplace.json')
const FLEX_MARKETPLACE_FILE = join('.flex-plugin', 'marketplace.json')
const DEFAULT_VERSION = '0.0.0'
const GIT_CLONE_MAX_ATTEMPTS = 3
const GIT_COMMAND_TIMEOUT_MS = 90_000
const GIT_CLONE_RETRY_DELAY_MS = 1_000
const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

export type MarketplaceSource =
  | { source: 'url'; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: 'github'; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: 'git'; sparsePaths?: string[]; url: string }
  | { source: 'file'; path: string }
  | { source: 'directory'; path: string }

export interface PluginMarketplaceEntry {
  name: string
  category?: string
  description?: string
  version?: string
  source?: unknown
  dependencies?: string[]
  strict?: boolean
  tags?: string[]
  raw: Record<string, unknown>
}

export interface PluginMarketplaceManifest {
  name: string
  description?: string
  plugins: PluginMarketplaceEntry[]
  allowCrossMarketplaceDependenciesOn?: string[]
  pluginRoot?: string
  raw: Record<string, unknown>
}

export interface KnownMarketplaceRecord {
  id: string
  source: MarketplaceSource
  name: string
  description?: string
  addedAt: string
  lastUpdated?: string
  pluginCount: number
  cacheTransactionId?: string
}

interface LoadMarketplaceResult {
  cleanup?: () => Promise<void>
  manifest: PluginMarketplaceManifest
  sourceRoot?: string
}

interface ResolvedPluginSourceRoot {
  cleanup?: () => Promise<void>
  path: string
}

interface KnownMarketplaceActivation {
  finalize: () => void
  rollback: () => Promise<void>
}

interface MarketplaceServiceDeps {
  notify: () => void
  progress: (event: MarketplaceProgressEvent) => void
  reloadKernel: () => Promise<void>
  registry: PluginRegistry
  storageRoot: string
}

function throwIfPluginOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Plugin operation cancelled')
    error.name = 'AbortError'
    throw error
  }
}

/** Atomic directory swap with a pipeline event (docs/observability.md §5). */
async function activateAtomicallyObserved(
  stage: string,
  input: Parameters<typeof activateDirectoryAtomically>[0]
): Promise<AtomicDirectoryActivation> {
  const started = Date.now()
  try {
    const activation = await activateDirectoryAtomically(input)
    observePipeline({
      kind: 'marketplace',
      stage,
      ok: true,
      durationMs: Date.now() - started
    })
    return activation
  } catch (error) {
    observePipeline({
      kind: 'marketplace',
      stage,
      ok: false,
      durationMs: Date.now() - started,
      note: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

export async function parseMarketplaceSourceInput(input: string): Promise<MarketplaceSource> {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new ContractError('PLUGIN_SOURCE_INVALID', 'Marketplace source is empty')
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const { url, ref } = splitRef(trimmed)
    if (url.endsWith('.git') || url.includes('/_git/')) {
      return ref ? { source: 'git', url, ref } : { source: 'git', url }
    }
    const parsed = tryParseUrl(url)
    if (parsed && (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com')) {
      const match = parsed.pathname.match(/^\/([^/]+\/[^/]+?)(?:\/|\.git|$)/)
      if (match?.[1]) {
        const gitUrl = url.endsWith('.git') ? url : `${url}.git`
        return ref ? { source: 'git', url: gitUrl, ref } : { source: 'git', url: gitUrl }
      }
    }
    return { source: 'url', url }
  }

  if (isGitSshUrl(trimmed)) {
    const { url, ref } = splitRef(trimmed)
    return ref ? { source: 'git', url, ref } : { source: 'git', url }
  }

  const resolved = resolvePathInput(trimmed)
  if (resolved) {
    if (!existsSync(resolved))
      throw new ContractError(
        'PLUGIN_SOURCE_INVALID',
        `Marketplace source path does not exist: ${resolved}`
      )
    if (fileExists(resolved)) {
      if (!resolved.endsWith('.json')) {
        throw new ContractError(
          'PLUGIN_SOURCE_INVALID',
          `Marketplace file must be a .json file: ${resolved}`
        )
      }
      return { source: 'file', path: resolved }
    }
    if (directoryExists(resolved)) return { source: 'directory', path: resolved }
    throw new ContractError(
      'PLUGIN_SOURCE_INVALID',
      `Marketplace source path is not a file or directory: ${resolved}`
    )
  }

  if (trimmed.includes('/') && !trimmed.includes(':')) {
    const { url: repo, ref } = splitGitHubShorthand(trimmed)
    return ref ? { source: 'github', repo, ref } : { source: 'github', repo }
  }

  throw new ContractError('PLUGIN_SOURCE_INVALID', `Unsupported marketplace source: ${input}`)
}

export function loadKnownMarketplacesSync(storageRoot: string): KnownMarketplaceRecord[] {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE))
  if (!isRecord(parsed)) return []
  const value = parsed.marketplaces
  if (Array.isArray(value)) return value.filter(isKnownMarketplaceRecord)
  if (isRecord(value)) return Object.values(value).filter(isKnownMarketplaceRecord)
  return []
}

export function loadMarketplaceManifestSync(
  storageRoot: string,
  marketplace: string
): PluginMarketplaceManifest | null {
  const manifestPath = getMarketplaceManifestPath(storageRoot, marketplace)
  const readableDirectory = recoverAtomicTargetSync(dirname(manifestPath))
  const parsed = readJsonFileSync(join(readableDirectory, basename(manifestPath)))
  return parseMarketplaceManifest(parsed)
}

function getMarketplaceManifestPath(storageRoot: string, marketplace: string): string {
  return join(storageRoot, 'marketplaces', sanitizePluginId(marketplace), MARKETPLACE_FILE)
}

export async function addMarketplace(input: {
  signal?: AbortSignal
  source: MarketplaceSource
  storageRoot: string
}): Promise<KnownMarketplaceRecord> {
  throwIfPluginOperationAborted(input.signal)
  const operationSignal = input.signal
  let loaded: LoadMarketplaceResult | undefined
  let knownMarketplaceActivation: KnownMarketplaceActivation | undefined
  let marketplaceActivation: AtomicDirectoryActivation | undefined
  try {
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: operationSignal
    })
    throwIfPluginOperationAborted(operationSignal)
    if (loaded.sourceRoot) {
      marketplaceActivation = await stageMarketplaceDirectoryPlugins(
        loaded.sourceRoot,
        input.storageRoot,
        loaded.manifest.name,
        loaded.manifest.raw,
        operationSignal
      )
    } else {
      marketplaceActivation = await stageMarketplaceManifest(
        input.storageRoot,
        loaded.manifest.name,
        loaded.manifest.raw,
        operationSignal
      )
    }
    throwIfPluginOperationAborted(operationSignal)
    const now = new Date().toISOString()
    const record: KnownMarketplaceRecord = {
      id: loaded.manifest.name,
      source: input.source,
      name: loaded.manifest.name,
      ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
      addedAt: now,
      lastUpdated: now,
      pluginCount: loaded.manifest.plugins.length,
      ...(marketplaceActivation ? { cacheTransactionId: marketplaceActivation.transactionId } : {})
    }
    knownMarketplaceActivation = await upsertKnownMarketplace(input.storageRoot, record)
    if (marketplaceActivation) {
      throwIfPluginOperationAborted(operationSignal)
    }
    await marketplaceActivation?.finalize()
    knownMarketplaceActivation.finalize()
    return record
  } catch (error) {
    let rollbackError: unknown
    try {
      await knownMarketplaceActivation?.rollback()
    } catch (currentRollbackError) {
      rollbackError = currentRollbackError
    }
    try {
      if (rollbackError === undefined) {
        await marketplaceActivation?.rollback()
      } else {
        await marketplaceActivation?.finalize()
      }
    } catch (currentRollbackError) {
      rollbackError =
        rollbackError === undefined
          ? currentRollbackError
          : appendPluginSourceCleanupError(currentRollbackError, rollbackError)
    }
    throw appendPluginSourceCleanupError(error, rollbackError)
  } finally {
    await cleanupPluginSourceBestEffort(loaded?.cleanup)
  }
}

async function requestMarketplaceJson(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = MARKETPLACE_JSON_TIMEOUT_MS
): Promise<unknown> {
  let currentHeaders = headers
  let currentUrl = url
  for (let redirectCount = 0; redirectCount <= MARKETPLACE_JSON_MAX_REDIRECTS; redirectCount += 1) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(currentUrl, {
        ...(currentHeaders ? { headers: currentHeaders } : {}),
        method: 'GET',
        redirect: 'manual',
        signal: combined
      })
    } catch (error) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `Failed to fetch marketplace: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (isMarketplaceJsonRedirectStatus(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        throw new ContractError(
          'PLUGIN_DOWNLOAD_FAILED',
          `Marketplace redirect is missing Location header: ${currentUrl}`
        )
      }
      const redirectUrl = new URL(location, currentUrl)
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined
      }
      currentUrl = redirectUrl.toString()
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `Failed to fetch marketplace: ${response.status} ${response.statusText}`
      )
    }
    const text = await response.text()
    if (text.length > MARKETPLACE_JSON_MAX_BYTES) {
      throw new ContractError('PLUGIN_DOWNLOAD_FAILED', 'Marketplace JSON exceeds size limit')
    }
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `Marketplace JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  throw new ContractError(
    'PLUGIN_DOWNLOAD_FAILED',
    `Marketplace fetch exceeded redirect limit: ${url}`
  )
}

function isMarketplaceJsonRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function loadMarketplaceFromSource(
  source: MarketplaceSource,
  storageRoot: string,
  options: { persist: boolean; signal?: AbortSignal }
): Promise<LoadMarketplaceResult> {
  throwIfPluginOperationAborted(options.signal)
  switch (source.source) {
    case 'file': {
      const parsed = JSON.parse(await readFile(source.path, 'utf8')) as unknown
      return {
        manifest: parseRequiredMarketplaceManifest(parsed),
        sourceRoot: dirname(source.path)
      }
    }
    case 'directory': {
      const file = findMarketplaceManifestPath(source.path)
      if (!file)
        throw new ContractError(
          'PLUGIN_SOURCE_INVALID',
          `Marketplace manifest not found in directory: ${source.path}`
        )
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
      const manifest = parseRequiredMarketplaceManifest(parsed)
      if (options.persist) {
        const activation = await stageMarketplaceDirectoryPlugins(
          source.path,
          storageRoot,
          manifest.name,
          manifest.raw,
          options.signal
        )
        await activation.finalize()
      }
      return { manifest, sourceRoot: source.path }
    }
    case 'url': {
      const parsed = await requestMarketplaceJson(source.url, source.headers, options.signal)
      return { manifest: parseRequiredMarketplaceManifest(parsed) }
    }
    case 'github': {
      const resolved = await resolveRepositoryMarketplaceSource(
        `https://github.com/${source.repo}.git`,
        source.ref,
        source.sparsePaths,
        options.signal
      )
      const cleanup = resolved.cleanup
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path)
        if (!file)
          throw new ContractError(
            'PLUGIN_SOURCE_INVALID',
            `Marketplace manifest not found in GitHub repo: ${source.repo}`
          )
        const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
        const manifest = parseRequiredMarketplaceManifest(parsed)
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal
          )
          await activation.finalize()
        }
        return { cleanup, manifest, sourceRoot: resolved.path }
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup)
        throw appendPluginSourceCleanupError(error, cleanupError)
      }
    }
    case 'git': {
      const resolved = await resolveRepositoryMarketplaceSource(
        source.url,
        source.ref,
        source.sparsePaths,
        options.signal
      )
      const cleanup = resolved.cleanup
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path)
        if (!file)
          throw new ContractError(
            'PLUGIN_SOURCE_INVALID',
            `Marketplace manifest not found in git repo: ${source.url}`
          )
        const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
        const manifest = parseRequiredMarketplaceManifest(parsed)
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal
          )
          await activation.finalize()
        }
        return { cleanup, manifest, sourceRoot: resolved.path }
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup)
        throw appendPluginSourceCleanupError(error, cleanupError)
      }
    }
  }
}

async function resolveRepositoryMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal
): Promise<ResolvedPluginSourceRoot> {
  if (!sparsePaths?.length) {
    try {
      return await resolveGitHubArchiveSource({ pin: ref, signal, url })
    } catch (error) {
      if (!shouldFallbackGitHubArchiveToGit(error)) {
        throw createArchiveFetchError(url, error)
      }
    }
  }
  const dir = await cloneMarketplaceSource(url, ref, sparsePaths, signal)
  return {
    cleanup: async () => {
      await rm(dir, { force: true, recursive: true })
    },
    path: dir
  }
}

async function cloneMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flex-marketplace-src-'))
  const args = ['clone', '--depth', '1']
  if (ref) args.push('--branch', ref)
  if (sparsePaths?.length) args.push('--filter=blob:none', '--sparse')
  args.push(url, dir)
  try {
    await execGitCloneWithRetry(args, dir, signal)
    if (sparsePaths?.length) {
      await execGitCommand(['-C', dir, 'sparse-checkout', 'set', ...sparsePaths], signal)
    }
    return dir
  } catch (error) {
    await rm(dir, { force: true, recursive: true })
    throw error
  }
}

async function execGitCloneWithRetry(
  args: string[],
  targetDir: string,
  signal?: AbortSignal
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= GIT_CLONE_MAX_ATTEMPTS; attempt += 1) {
    try {
      throwIfPluginOperationAborted(signal)
      if (attempt > 1) {
        await rm(targetDir, { force: true, recursive: true })
        await mkdir(targetDir, { recursive: true })
      }
      await execGitCommand(args, signal)
      return
    } catch (error) {
      lastError = error
      if (attempt >= GIT_CLONE_MAX_ATTEMPTS || !isRetryableGitCloneError(error)) {
        throw error
      }
      await delay(GIT_CLONE_RETRY_DELAY_MS * attempt, signal)
    }
  }
  throw lastError
}

async function execGitCommand(args: string[], signal?: AbortSignal): Promise<void> {
  throwIfPluginOperationAborted(signal)
  try {
    const gitBinary = process.env.PLUGIN_GIT_BINARY?.trim() || 'git'
    await execFileAsync(gitBinary, args, {
      env: process.env,
      killSignal: 'SIGTERM',
      maxBuffer: 1024 * 1024 * 10,
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS
    })
  } catch (error) {
    if (isCommandUnavailableError(error)) {
      const source = args.find(
        (arg) => arg.includes('://') || arg.startsWith('git@') || arg.startsWith('git+')
      )
      throw createGitUnavailableError(source ?? args[args.length - 1] ?? 'Git operation')
    }
    throw error
  }
  throwIfPluginOperationAborted(signal)
}

function isRetryableGitCloneError(error: unknown): boolean {
  const output = getErrorOutput(error)
  return /RPC failed|Operation timed out|Recv failure|expected flush|early EOF|remote end hung up|HTTP\/2 stream|Connection reset|ETIMEDOUT|ECONNRESET|network timeout/iu.test(
    output
  )
}

function getErrorOutput(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : String(error)
  }
  const chunks = [
    error instanceof Error ? error.message : '',
    typeof error.stdout === 'string' ? error.stdout : '',
    typeof error.stderr === 'string' ? error.stderr : ''
  ]
  return chunks.filter(Boolean).join('\n')
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      const error = new Error('Plugin operation cancelled')
      error.name = 'AbortError'
      rejectDelay(error)
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      signal?.removeEventListener('abort', handleAbort)
    }
    const handleAbort = (): void => {
      cleanup()
      const error = new Error('Plugin operation cancelled')
      error.name = 'AbortError'
      rejectDelay(error)
    }
    timeout = setTimeout(() => {
      cleanup()
      resolveDelay()
    }, ms)
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

async function stageMarketplaceDirectoryPlugins(
  sourceDir: string,
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal
): Promise<AtomicDirectoryActivation> {
  throwIfPluginOperationAborted(signal)
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace))
  return activateAtomicallyObserved("stage marketplace", {
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest)
    },
    signal,
    sourcePath: sourceDir,
    targetPath: targetDir
  })
}

async function stageMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal
): Promise<AtomicDirectoryActivation> {
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace))
  return activateAtomicallyObserved("stage marketplace", {
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest)
    },
    signal,
    targetPath: targetDir
  })
}

async function upsertKnownMarketplace(
  storageRoot: string,
  record: KnownMarketplaceRecord
): Promise<KnownMarketplaceActivation> {
  const known = loadKnownMarketplacesSync(storageRoot)
  const index = known.findIndex((item) => item.id === record.id)
  const previous = index >= 0 ? known[index] : undefined
  if (index >= 0) {
    const { cacheTransactionId: _prevTx, ...successfulPrevious } = previous ?? record
    known[index] = {
      ...successfulPrevious,
      ...record,
      addedAt: previous?.addedAt ?? record.addedAt
    }
  } else {
    known.push(record)
  }
  await writeKnownMarketplaces(storageRoot, known)
  let settled = false
  return {
    finalize: () => {
      settled = true
    },
    rollback: async () => {
      if (settled) return
      const current = loadKnownMarketplacesSync(storageRoot)
      const currentIndex = current.findIndex((item) => item.id === record.id)
      const currentRecord = currentIndex >= 0 ? current[currentIndex] : undefined
      if (
        !currentRecord ||
        currentRecord.lastUpdated !== record.lastUpdated ||
        currentRecord.cacheTransactionId !== record.cacheTransactionId
      ) {
        throw new Error(
          `Cannot roll back marketplace authority after concurrent update: ${record.id}`
        )
      }
      if (previous) {
        current[currentIndex] = previous
      } else {
        current.splice(currentIndex, 1)
      }
      await writeKnownMarketplaces(storageRoot, current)
      settled = true
    }
  }
}

async function writeKnownMarketplaces(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[]
): Promise<void> {
  await writeJsonFile(join(storageRoot, KNOWN_MARKETPLACES_FILE), {
    version: 1,
    marketplaces
  })
}

export function writeKnownMarketplacesSync(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[]
): void {
  const path = join(storageRoot, KNOWN_MARKETPLACES_FILE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        marketplaces
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

function parseRequiredMarketplaceManifest(value: unknown): PluginMarketplaceManifest {
  const parsed = parseMarketplaceManifest(value)
  if (!parsed) throw new ContractError('PLUGIN_SOURCE_INVALID', 'Marketplace manifest is invalid')
  return parsed
}

export function parseMarketplaceManifest(value: unknown): PluginMarketplaceManifest | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!MARKETPLACE_NAME_PATTERN.test(name)) return null
  const rawPlugins = value.plugins
  const pluginEntries = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) =>
          isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName }
        )
      : []
  return normalizeMarketplaceManifest({
    ...value,
    name,
    plugins: pluginEntries,
    // A marketplace manifest on disk may carry a stray "raw" field; force it to
    // the parsed JSON so downstream staging never persists a bogus object.
    raw: value
  })
}

function normalizeMarketplaceManifest(
  value: PluginMarketplaceManifest | Record<string, unknown>
): PluginMarketplaceManifest {
  if (isPluginMarketplaceManifest(value)) return value
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const plugins = Array.isArray(value.plugins)
    ? value.plugins
        .filter(isRecord)
        .map((entry): PluginMarketplaceEntry | null => {
          const name = typeof entry.name === 'string' ? entry.name.trim() : ''
          if (name.length === 0) return null
          const dependencies = Array.isArray(entry.dependencies)
            ? entry.dependencies
                .map(normalizeDependencyRef)
                .filter((item): item is string => item !== null)
            : undefined
          const tags = Array.isArray(entry.tags)
            ? entry.tags.filter((item): item is string => typeof item === 'string')
            : undefined
          return {
            name,
            ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
            ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
            ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
            ...(entry.source !== undefined ? { source: entry.source } : {}),
            ...(dependencies ? { dependencies } : {}),
            ...(typeof entry.strict === 'boolean' ? { strict: entry.strict } : {}),
            ...(tags ? { tags } : {}),
            raw: entry
          }
        })
        .filter((entry): entry is PluginMarketplaceEntry => entry !== null)
    : []
  const allowCrossMarketplaceDependenciesOn = Array.isArray(
    value.allowCrossMarketplaceDependenciesOn
  )
    ? value.allowCrossMarketplaceDependenciesOn.filter(
        (item): item is string => typeof item === 'string'
      )
    : undefined
  return {
    name: String(value.name),
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : typeof metadata.description === 'string'
        ? { description: metadata.description }
        : {}),
    plugins,
    ...(allowCrossMarketplaceDependenciesOn ? { allowCrossMarketplaceDependenciesOn } : {}),
    ...(typeof metadata.pluginRoot === 'string' ? { pluginRoot: metadata.pluginRoot } : {}),
    raw: value
  }
}

function isPluginMarketplaceManifest(value: unknown): value is PluginMarketplaceManifest {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    MARKETPLACE_NAME_PATTERN.test(value.name) &&
    Array.isArray(value.plugins) &&
    isRecord(value.raw)
  )
}

function normalizeDependencyRef(value: unknown): string | null {
  if (typeof value === 'string') return value.replace(/@\^[^@]*$/u, '')
  if (!isRecord(value)) return null
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name) return null
  const marketplace = typeof value.marketplace === 'string' ? value.marketplace.trim() : ''
  return marketplace ? `${name}@${marketplace}` : name
}

function findMarketplaceManifestPath(rootPath: string, explicitPath?: string): string | null {
  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    FLEX_MARKETPLACE_FILE,
    CLAUDE_MARKETPLACE_FILE,
    MARKETPLACE_FILE
  ]
  for (const candidate of candidates) {
    const path = explicitPath && candidate === explicitPath ? candidate : resolveInside(rootPath, candidate)
    if (path && fileExists(path)) return path
  }
  return null
}

function readJsonFileSync(path: string): unknown {
  const readablePath = recoverAtomicTargetSync(path)
  try {
    return JSON.parse(readFileSync(readablePath, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function getPluginCacheDir(
  storageRoot: string,
  marketplace: string,
  name: string,
  version: string
): string {
  return join(
    storageRoot,
    'cache',
    sanitizePluginId(marketplace),
    sanitizePluginId(name),
    sanitizePluginId(version)
  )
}

export function getPluginDataDir(storageRoot: string, pluginId: string): string {
  return join(storageRoot, 'data', sanitizePluginId(pluginId))
}

function isKnownMarketplaceRecord(value: unknown): value is KnownMarketplaceRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.pluginCount === 'number' &&
    isRecord(value.source)
  )
}

export function parsePluginId(pluginId: string): { marketplace: string; name: string } {
  const at = pluginId.lastIndexOf('@')
  if (at <= 0 || at === pluginId.length - 1) {
    throw new ContractError(
      'PLUGIN_SOURCE_INVALID',
      `Plugin id must use <name>@<marketplace>: ${pluginId}`
    )
  }
  return {
    name: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1)
  }
}

function qualifyDependency(dependency: string, marketplace: string): string {
  return dependency.includes('@') ? dependency : `${dependency}@${marketplace}`
}

function resolvePathInput(input: string): string | null {
  if (
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('/') ||
    input.startsWith('~') ||
    /^[a-zA-Z]:[/\\]/.test(input)
  ) {
    return input.startsWith('~') ? join(process.env.HOME ?? '', input.slice(1)) : resolve(input)
  }
  return null
}

function splitRef(input: string): { ref?: string; url: string } {
  const index = input.lastIndexOf('#')
  if (index < 0) return { url: input }
  return { url: input.slice(0, index), ref: input.slice(index + 1) }
}

function splitGitHubShorthand(input: string): { ref?: string; url: string } {
  const hash = input.lastIndexOf('#')
  const at = input.lastIndexOf('@')
  const index = Math.max(hash, at)
  if (index <= 0) return { url: input }
  return { url: input.slice(0, index), ref: input.slice(index + 1) }
}

function isGitSshUrl(input: string): boolean {
  return /^[a-zA-Z0-9._-]+@[^:]+:.+/.test(input)
}

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input)
  } catch {
    return null
  }
}

function resolveDependencyClosure(input: {
  allowCrossMarketplaces: ReadonlySet<string>
  marketplace: string
  name: string
  storageRoot: string
}): string[] {
  const rootId = `${input.name}@${input.marketplace}`
  const closure: string[] = []
  const visiting: string[] = []
  const visited = new Set<string>()

  const walk = (pluginId: string, requiredBy: string): void => {
    const { marketplace, name } = parsePluginId(pluginId)
    if (marketplace !== input.marketplace && !input.allowCrossMarketplaces.has(marketplace)) {
      throw new ContractError(
        'PLUGIN_SOURCE_INVALID',
        `Cross-marketplace dependency is blocked: ${pluginId} required by ${requiredBy}`
      )
    }
    if (visiting.includes(pluginId)) {
      throw new ContractError(
        'PLUGIN_SOURCE_INVALID',
        `Plugin dependency cycle: ${[...visiting, pluginId].join(' -> ')}`
      )
    }
    if (visited.has(pluginId)) return
    const manifest = loadMarketplaceManifestSync(input.storageRoot, marketplace)
    if (!manifest)
      throw new ContractError(
        'PLUGIN_NOT_FOUND',
        `Marketplace not found for dependency: ${marketplace}`
      )
    const entry = manifest.plugins.find((plugin) => plugin.name === name)
    if (!entry)
      throw new ContractError(
        'PLUGIN_NOT_FOUND',
        `Dependency not found: ${pluginId} required by ${requiredBy}`
      )
    visiting.push(pluginId)
    for (const dependency of entry.dependencies ?? []) {
      walk(qualifyDependency(dependency, marketplace), pluginId)
    }
    visiting.pop()
    visited.add(pluginId)
    closure.push(pluginId)
  }

  walk(rootId, rootId)
  return closure
}

function readPluginSourceIdentityPin(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined
  const zipSha256 = readZipPluginSourceSha256(source)
  if (zipSha256) return zipSha256
  if (typeof source.sha === 'string') return source.sha
  if (typeof source.commit === 'string') return source.commit
  return undefined
}

function readRequiredPluginSourceString(
  source: Record<string, unknown>,
  field: string,
  label: string
): string {
  const value = source[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(
      'PLUGIN_SOURCE_INVALID',
      `Plugin ${label} source requires a non-empty ${field}`
    )
  }
  return value
}

function readOptionalZipPluginSourcePath(source: Record<string, unknown>): string | undefined {
  if (source.path === undefined) return undefined
  if (typeof source.path === 'string') return source.path
  throw new ContractError('PLUGIN_SOURCE_INVALID', 'Plugin zip source path must be a string')
}

function readOptionalZipPluginSourceStripRoot(
  source: Record<string, unknown>
): boolean | undefined {
  if (source.stripRoot === undefined) return undefined
  if (typeof source.stripRoot === 'boolean') return source.stripRoot
  throw new ContractError('PLUGIN_SOURCE_INVALID', 'Plugin zip source stripRoot must be a boolean')
}

function readPluginSourceHeaders(
  source: Record<string, unknown>
): Record<string, string> | undefined {
  if (source.headers === undefined) return undefined
  if (!isRecord(source.headers)) {
    throw new ContractError('PLUGIN_SOURCE_INVALID', 'Plugin zip source headers must be an object')
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(source.headers)) {
    if (typeof value !== 'string') {
      throw new ContractError(
        'PLUGIN_SOURCE_INVALID',
        `Plugin zip source header must be a string: ${key}`
      )
    }
    headers[key] = value
  }
  return headers
}

function readRequiredZipPluginSourceSha256(source: Record<string, unknown>): string {
  if (typeof source.sha256 === 'string') return source.sha256
  throw new ContractError('PLUGIN_SOURCE_INVALID', 'Plugin zip source sha256 is required')
}

async function resolveGitPluginSource(input: {
  path?: string
  ref?: string
  signal?: AbortSignal
  sha?: string
  url: string
}): Promise<ResolvedPluginSourceRoot> {
  const dir = await clonePluginSource(input.url, input.ref, input.sha, input.signal)
  const cleanup = async (): Promise<void> => {
    await rm(dir, { force: true, recursive: true })
  }
  if (!input.path) return { cleanup, path: dir }
  throwIfPluginOperationAborted(input.signal)
  const subdir = resolveInside(dir, input.path)
  if (!subdir || !directoryExists(subdir)) {
    const primaryError = new ContractError(
      'PLUGIN_PATH_INVALID',
      `Plugin source subdirectory does not exist: ${input.path}`
    )
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup)
    throw appendPluginSourceCleanupError(primaryError, cleanupError)
  }
  return { cleanup, path: subdir }
}

async function resolveRepositoryPluginSource(input: {
  path?: string
  ref?: string
  signal?: AbortSignal
  sha?: string
  url: string
}): Promise<ResolvedPluginSourceRoot> {
  try {
    return await resolveGitHubArchiveSource({
      path: input.path,
      pin: input.sha ?? input.ref,
      signal: input.signal,
      url: input.url
    })
  } catch (error) {
    if (!shouldFallbackGitHubArchiveToGit(error)) {
      throw createArchiveFetchError(input.url, error)
    }
  }
  return resolveGitPluginSource(input)
}

async function clonePluginSource(
  url: string,
  ref: string | undefined,
  sha?: string,
  signal?: AbortSignal
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flex-plugin-src-'))
  const args = ['clone']
  if (!sha) args.push('--depth', '1')
  if (ref) args.push('--branch', ref)
  args.push(url, dir)
  try {
    await execGitCloneWithRetry(args, dir, signal)
    if (sha) await execGitCommand(['-C', dir, 'checkout', sha], signal)
    return dir
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(async () => {
      await rm(dir, { force: true, recursive: true })
    })
    throw appendPluginSourceCleanupError(error, cleanupError)
  }
}

function resolveMarketplacePluginBaseDir(
  marketplaceDir: string,
  manifest: PluginMarketplaceManifest | null
): string {
  const pluginRoot = manifest?.pluginRoot
  if (!pluginRoot) return marketplaceDir
  const resolved = resolveInside(marketplaceDir, pluginRoot)
  return resolved && directoryExists(resolved) ? resolved : marketplaceDir
}

async function ensureMarketplaceEntryManifest(input: {
  entry: PluginMarketplaceEntry
  target: string
}): Promise<void> {
  if (findManifestPath(input.target)) return
  if (input.entry.strict !== false) return
  const manifestDir = join(input.target, '.claude-plugin')
  await mkdir(manifestDir, { recursive: true })
  await writeJsonFile(
    join(manifestDir, 'plugin.json'),
    createManifestFromMarketplaceEntry(input.entry)
  )
}

function createManifestFromMarketplaceEntry(
  entry: PluginMarketplaceEntry
): Record<string, unknown> {
  const raw = { ...entry.raw }
  delete raw.source
  delete raw.category
  delete raw.tags
  delete raw.strict
  return {
    ...raw,
    name: entry.name,
    version: entry.version ?? DEFAULT_VERSION
  }
}

async function resolvePluginSourceRoot(input: {
  entry: PluginMarketplaceEntry
  manifest?: PluginMarketplaceManifest
  marketplace: string
  signal?: AbortSignal
  sourceRoot?: string
  storageRoot: string
}): Promise<ResolvedPluginSourceRoot> {
  throwIfPluginOperationAborted(input.signal)
  const source = input.entry.source
  const marketplaceDir =
    input.sourceRoot ?? dirname(getMarketplaceManifestPath(input.storageRoot, input.marketplace))
  const manifest =
    input.manifest ?? loadMarketplaceManifestSync(input.storageRoot, input.marketplace)
  const pluginBaseDir = resolveMarketplacePluginBaseDir(marketplaceDir, manifest)
  if (typeof source === 'string') {
    const local = resolveInside(pluginBaseDir, source.replace(/^\.\//, ''))
    if (local && directoryExists(local)) return { path: local }
    const fallback = resolve(source)
    if (directoryExists(fallback)) return { path: fallback }
    throw new ContractError(
      'PLUGIN_SOURCE_INVALID',
      `Unsupported or missing plugin source: ${source}`
    )
  }
  if (isRecord(source)) {
    const sourceKind = typeof source.source === 'string' ? source.source : ''
    if (sourceKind === 'directory') {
      const path = resolve(readRequiredPluginSourceString(source, 'path', 'directory path'))
      if (directoryExists(path)) return { path }
      throw new ContractError(
        'PLUGIN_PATH_INVALID',
        `Plugin source directory does not exist: ${path}`
      )
    }
    if (sourceKind === 'github') {
      const repo = readRequiredPluginSourceString(source, 'repo', 'GitHub repo')
      const url = `https://github.com/${repo}.git`
      return resolveRepositoryPluginSource({
        path: typeof source.path === 'string' ? source.path : undefined,
        ref: typeof source.ref === 'string' ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url
      })
    }
    if (sourceKind === 'git') {
      return resolveRepositoryPluginSource({
        path: typeof source.path === 'string' ? source.path : undefined,
        ref: typeof source.ref === 'string' ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: readRequiredPluginSourceString(source, 'url', 'Git URL')
      })
    }
    if (sourceKind === 'url') {
      const url = readRequiredPluginSourceString(source, 'url', 'URL')
      const sourceType = typeof source.type === 'string' ? source.type : ''
      if (sourceType === 'zip') {
        return resolveZipPluginSource({
          headers: readPluginSourceHeaders(source),
          path: readOptionalZipPluginSourcePath(source),
          sha256: readRequiredZipPluginSourceSha256(source),
          signal: input.signal,
          stripRoot: readOptionalZipPluginSourceStripRoot(source),
          url
        })
      }
      if (sourceType && sourceType !== 'git') {
        throw new ContractError('PLUGIN_SOURCE_INVALID', `Unsupported plugin source: url:${sourceType}`)
      }
      return resolveRepositoryPluginSource({
        path: typeof source.path === 'string' ? source.path : undefined,
        ref: typeof source.ref === 'string' ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url
      })
    }
    if (sourceKind === 'git-subdir') {
      return resolveRepositoryPluginSource({
        path: readRequiredPluginSourceString(source, 'path', 'git-subdir path'),
        ref: typeof source.ref === 'string' ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: normalizeGitUrl(readRequiredPluginSourceString(source, 'url', 'git-subdir URL'))
      })
    }
    if (sourceKind === 'npm' || sourceKind === 'npx') {
      // npx is an alias: both resolve a registry package to a directory and
      // hand it to the same atomic staging as every other source kind.
      const pkg = readRequiredPluginSourceString(source, 'package', 'npm package name')
      const resolved = await resolveNpmPackageSource({
        package: pkg,
        signal: input.signal,
        ...(typeof source.path === 'string' && source.path.length > 0
          ? { path: source.path }
          : {}),
        ...(typeof source.version === 'string' && source.version.length > 0
          ? { version: source.version }
          : {})
      })
      try {
        const root = resolved.path
        if (!directoryExists(root)) {
          throw new ContractError(
            'PLUGIN_SOURCE_INVALID',
            `npm package did not yield a usable directory: ${pkg}@${resolved.version}`
          )
        }
        return { cleanup: resolved.cleanup, path: root }
      } catch (error) {
        await resolved.cleanup?.()
        throw error
      }
    }
    if (sourceKind === 'pip') {
      throw new ContractError('PLUGIN_SOURCE_INVALID', `Unsupported plugin source: ${sourceKind}`)
    }
    throw new ContractError(
      'PLUGIN_SOURCE_INVALID',
      `Plugin source is invalid or unsupported for ${input.entry.name}@${input.marketplace}: ${sourceKind || 'missing kind'}`
    )
  }
  const localByName = join(pluginBaseDir, input.entry.name)
  if (directoryExists(localByName)) return { path: localByName }
  throw new ContractError(
    'PLUGIN_SOURCE_INVALID',
    `Plugin source is not supported for ${input.entry.name}@${input.marketplace}`
  )
}

function normalizeGitUrl(value: string): string {
  if (/^[^/]+\/[^/]+$/u.test(value) && !value.includes(':')) {
    return `https://github.com/${value}.git`
  }
  return value
}

function resolveInstalledPluginVersion(rootPath: string, entry: PluginMarketplaceEntry): string {
  const manifestPath = findManifestPath(rootPath)
  if (manifestPath) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
      if (
        isRecord(parsed) &&
        typeof parsed.version === 'string' &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version
      }
    } catch {
    }
  }
  return entry.version ?? DEFAULT_VERSION
}

function summarizeRecord(
  rec: PluginRecord,
  description?: string,
  counts: PluginSummary['componentCounts'] = {}
): PluginSummary {
  return {
    id: rec.id,
    name: rec.name,
    version: rec.version,
    ...(description !== undefined ? { description } : {}),
    enabled: rec.enabled,
    source: { kind: rec.sourceKind, label: rec.sourceLabel },
    componentCounts: counts
  }
}

function toSummary(rec: PluginRecord, description?: string): PluginSummary {
  const manifestPath = findManifestPath(rec.rootPath)
  if (!manifestPath) return summarizeRecord(rec, description)
  try {
    const manifest = parseManifest(manifestPath)
    const enumeration = enumerateComponents(rec.rootPath, manifest)
    return summarizeRecord(rec, description ?? manifest.description, countComponents(enumeration.components))
  } catch {
    return summarizeRecord(rec, description)
  }
}

function toMarketplaceInfo(record: KnownMarketplaceRecord): MarketplaceInfo {
  return {
    id: record.id,
    name: record.name,
    ...(record.description !== undefined ? { description: record.description } : {}),
    source: describeMarketplaceSource(record.source),
    pluginCount: record.pluginCount,
    addedAt: record.addedAt,
    ...(record.lastUpdated !== undefined ? { lastUpdated: record.lastUpdated } : {})
  }
}

function describeMarketplaceSource(source: MarketplaceSource): string {
  switch (source.source) {
    case 'url':
      return source.url
    case 'github':
      return source.ref ? `${source.repo}#${source.ref}` : source.repo
    case 'git':
      return source.ref ? `${source.url}#${source.ref}` : source.url
    case 'file':
    case 'directory':
      return source.path
  }
}

async function cacheMarketplacePlugin(input: {
  entry: PluginMarketplaceEntry
  marketplace: string
  signal?: AbortSignal
  sourceRootPath?: string
  storageRoot: string
  preResolved?: ResolvedPluginSourceRoot
}): Promise<{ activation?: AtomicDirectoryActivation; target: string; version: string }> {
  throwIfPluginOperationAborted(input.signal)
  const sourceRoot =
    input.preResolved ??
    (await resolvePluginSourceRoot({
      entry: input.entry,
      marketplace: input.marketplace,
      signal: input.signal,
      ...(input.sourceRootPath ? { sourceRoot: input.sourceRootPath } : {}),
      storageRoot: input.storageRoot
    }))
  let version: string
  let target: string
  let activation: AtomicDirectoryActivation | undefined
  try {
    if (isZipPluginUrlSource(input.entry.source)) {
      assertZipPluginInstallRoot(sourceRoot.path, input.entry, input.marketplace)
    }
    version = resolveInstalledPluginVersion(sourceRoot.path, input.entry)
    target = getPluginCacheDir(input.storageRoot, input.marketplace, input.entry.name, version)
    if (resolve(sourceRoot.path) !== resolve(target)) {
      throwIfPluginOperationAborted(input.signal)
      activation = await activateAtomicallyObserved("activate plugin", {
        prepare: async (stagedPath) => {
          await ensureMarketplaceEntryManifest({ entry: input.entry, target: stagedPath })
        },
        signal: input.signal,
        sourcePath: sourceRoot.path,
        targetPath: target
      })
    } else {
      await ensureMarketplaceEntryManifest({ entry: input.entry, target })
    }
  } finally {
    await cleanupPluginSourceBestEffort(sourceRoot.cleanup)
  }
  return {
    ...(activation ? { activation } : {}),
    target,
    version
  }
}

function assertZipPluginInstallRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
  marketplace: string
): void {
  const manifestPath = findManifestPath(rootPath)
  const pluginId = `${entry.name}@${marketplace}`
  if (!manifestPath) {
    if (entry.strict === false) return
    throw new ContractError('PLUGIN_MANIFEST_INVALID', `Plugin manifest not found: ${pluginId}`)
  }
  const manifest = parseManifest(manifestPath)
  if (manifest.name !== entry.name) {
    throw new ContractError(
      'PLUGIN_MANIFEST_INVALID',
      `Plugin manifest name '${manifest.name}' does not match marketplace entry '${entry.name}'`
    )
  }
}

export interface MarketplaceServiceOptions {
  registry: PluginRegistry
  storageRoot: string
  notify: () => void
  reloadKernel: () => Promise<void>
  onProgress?: (event: MarketplaceProgressEvent) => void
}

export class MarketplaceService {
  private readonly registry: PluginRegistry
  private readonly storageRoot: string
  private readonly notify: () => void
  private readonly reloadKernel: () => Promise<void>
  private readonly emitProgress: (event: MarketplaceProgressEvent) => void

  constructor(options: MarketplaceServiceOptions) {
    this.registry = options.registry
    this.storageRoot = options.storageRoot
    this.notify = options.notify
    this.reloadKernel = options.reloadKernel
    this.emitProgress = options.onProgress ?? (() => undefined)
  }

  list(): MarketplaceInfo[] {
    return loadKnownMarketplacesSync(this.storageRoot).map(toMarketplaceInfo)
  }

  async addMarketplace(input: AddMarketplaceInput): Promise<MarketplaceInfo> {
    const source = await parseMarketplaceSourceInput(input.source)
    this.emitProgress({ phase: 'resolve', source: input.source })
    try {
      const record = await addMarketplace({
        source,
        storageRoot: this.storageRoot
      })
      this.emitProgress({ phase: 'done', source: input.source })
      return toMarketplaceInfo(record)
    } catch (error) {
      this.emitProgress({
        phase: 'error',
        source: input.source,
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  search(input: MarketplaceSearchInput): MarketplaceSearchResult[] {
    const known = loadKnownMarketplacesSync(this.storageRoot)
    const query = (input.query ?? '').trim().toLowerCase()
    const installedRecords = this.registry.list()
    const results: MarketplaceSearchResult[] = []
    for (const marketplace of known) {
      if (input.marketplace && marketplace.id !== input.marketplace) continue
      const manifest = loadMarketplaceManifestSync(this.storageRoot, marketplace.id)
      if (!manifest) continue
      for (const entry of manifest.plugins) {
        if (query) {
          const haystack = [
            entry.name,
            entry.description ?? '',
            ...(entry.tags ?? [])
          ]
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(query)) continue
        }
        const pluginId = `${entry.name}@${marketplace.id}`
        const installed = installedRecords.find(
          (rec) => rec.id === pluginId || rec.name === entry.name
        )
        const installedVersion = installed?.version
        const update =
          installed && entry.version
            ? comparePluginUpdate({
                installedVersion,
                installedSha: undefined,
                latestVersion: entry.version,
                latestSha: undefined
              })
            : 'none'
        results.push({
          marketplace: marketplace.id,
          name: entry.name,
          ...(entry.version !== undefined ? { version: entry.version } : {}),
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
          installed: Boolean(installed),
          ...(installedVersion !== undefined ? { installedVersion } : {}),
          ...(update === 'update-available' ? { updateAvailable: true } : {})
        })
      }
    }
    return results
  }

  async installFromMarketplace(input: InstallFromMarketplaceInput): Promise<PluginSummary> {
    // Whole-run pipeline event (docs/observability.md): per-stage events come
    // from the resolvers and the observed atomic activations underneath.
    const started = Date.now()
    try {
      const summary = await this.installFromMarketplaceInner(input)
      observePipeline({
        kind: 'marketplace',
        stage: 'install',
        ok: true,
        durationMs: Date.now() - started,
        note: summary.id
      })
      return summary
    } catch (error) {
      observePipeline({
        kind: 'marketplace',
        stage: 'install',
        ok: false,
        durationMs: Date.now() - started,
        note: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  private async installFromMarketplaceInner(
    input: InstallFromMarketplaceInput
  ): Promise<PluginSummary> {
    const source = input.source
    const overwrite = input.overwrite === true
    if (source.kind === 'entry') {
      return this.installEntry({
        marketplace: source.marketplace,
        name: source.name,
        overwrite
      })
    }
    if (source.kind === 'path') {
      return this.installFromPath(source.path, overwrite)
    }
    if (source.kind === 'url') {
      return this.installFromUrl(source.url, overwrite)
    }
    throw new ContractError('PLUGIN_SOURCE_INVALID', 'Unsupported marketplace install source')
  }

  private async installFromPath(path: string, overwrite: boolean): Promise<PluginSummary> {
    this.emitProgress({ phase: 'resolve', source: path })
    if (!existsSync(path)) {
      throw new ContractError('PLUGIN_PATH_INVALID', `Plugin path does not exist: ${path}`)
    }
    const stats = statSync(path)
    if (stats.isFile() && path.toLowerCase().endsWith('.zip')) {
      const resolved = await resolveLocalZipSource({}, path)
      try {
        return await this.installFromResolvedRoot(resolved.path, {
          cleanup: resolved.cleanup,
          label: 'Marketplace',
          overwrite,
          sourceDisplay: path
        })
      } catch (error) {
        await cleanupPluginSourceBestEffort(resolved.cleanup)
        throw error
      }
    }
    if (!stats.isDirectory()) {
      throw new ContractError('PLUGIN_PATH_INVALID', `Plugin path is not a directory: ${path}`)
    }
    return this.installFromResolvedRoot(path, {
      label: 'Marketplace',
      overwrite,
      sourceDisplay: path
    })
  }

  private async installFromUrl(url: string, overwrite: boolean): Promise<PluginSummary> {
    this.emitProgress({ phase: 'resolve', source: url })
    let resolved: ResolvedPluginSourceRoot
    const parsed = parseDirectUrlSource(url)
    try {
      if (parsed.kind === 'zip') {
        resolved = await resolveHttpZipSource({
          url: parsed.url,
          ...(parsed.sha256 ? { sha256: parsed.sha256 } : {})
        })
      } else if (parsed.kind === 'github') {
        resolved = await resolveRepositoryPluginSource({ url: parsed.url, ref: parsed.ref })
      } else {
        throw new ContractError('PLUGIN_SOURCE_INVALID', `Unsupported plugin URL source: ${url}`)
      }
    } catch (error) {
      if (error instanceof ContractError) throw error
      if (error instanceof PluginZipDownloadError) {
        throw new ContractError(
          'PLUGIN_DOWNLOAD_FAILED',
          `Failed to download plugin zip: ${error.message}`,
          { status: error.status, url: error.url }
        )
      }
      throw createArchiveFetchError(url, error)
    }
    try {
      return await this.installFromResolvedRoot(resolved.path, {
        cleanup: resolved.cleanup,
        label: 'Marketplace',
        overwrite,
        sourceDisplay: url
      })
    } catch (error) {
      await cleanupPluginSourceBestEffort(resolved.cleanup)
      throw error
    }
  }

  private async installFromResolvedRoot(
    rootPath: string,
    options: {
      cleanup?: () => Promise<void>
      label: string
      marketplace?: string
      overwrite: boolean
      sourceDisplay: string
    }
  ): Promise<PluginSummary> {
    try {
      const manifestPath = findManifestPath(rootPath)
      if (!manifestPath) {
        throw new ContractError(
          'PLUGIN_MANIFEST_INVALID',
          `No plugin.json found under ${rootPath}`
        )
      }
      const manifest = parseManifest(manifestPath)
      if (!PLUGIN_NAME_PATTERN.test(manifest.name)) {
        throw new ContractError(
          'PLUGIN_MANIFEST_INVALID',
          `Invalid plugin name: ${manifest.name}`
        )
      }
      const marketplace = options.marketplace ?? 'marketplace'
      const id = `${manifest.name}@${marketplace}`
      const existingByName = this.registry.list().find((rec) => rec.name === manifest.name)
      const existing = this.registry.get(id) ?? existingByName
      if (existing && !options.overwrite) {
        throw new ContractError('PLUGIN_ALREADY_INSTALLED', `Plugin already installed: ${existing.id}`)
      }
      const version = manifest.version
      const target = getPluginCacheDir(this.storageRoot, marketplace, manifest.name, version)
      this.emitProgress({
        phase: 'extract',
        source: options.sourceDisplay,
        pluginId: id
      })
      let activation: AtomicDirectoryActivation | undefined
      if (resolve(rootPath) !== resolve(target)) {
        activation = await activateAtomicallyObserved("activate plugin", {
          prepare: async (stagedPath) => {
            await ensureMarketplaceEntryManifest({
              entry: {
                name: manifest.name,
                ...(manifest.version ? { version: manifest.version } : {}),
                raw: {}
              },
              target: stagedPath
            })
          },
          sourcePath: rootPath,
          targetPath: target
        })
      }
      const previous = existing
      if (previous) this.registry.remove(previous.id)
      const rec: PluginRecord = {
        id,
        name: manifest.name,
        version,
        rootPath: target,
        enabled: true,
        sourceKind: 'marketplace',
        sourceLabel: options.label,
        installedAt: previous?.installedAt ?? Date.now()
      }
      try {
        this.registry.add(rec)
      } catch (error) {
        if (previous) this.registry.add(previous)
        if (activation) await activation.rollback()
        throw error
      }
      if (activation) await activation.finalize()
      this.emitProgress({ phase: 'install', source: options.sourceDisplay, pluginId: id })
      this.notify()
      await this.reloadKernel()
      this.emitProgress({ phase: 'done', source: options.sourceDisplay, pluginId: id })
      return toSummary(rec, manifest.description)
    } finally {
      await cleanupPluginSourceBestEffort(options.cleanup)
    }
  }

  private async installEntry(input: {
    marketplace: string
    name: string
    overwrite: boolean
  }): Promise<PluginSummary> {
    this.emitProgress({ phase: 'resolve', source: `${input.name}@${input.marketplace}` })
    const rootManifest = loadMarketplaceManifestSync(this.storageRoot, input.marketplace)
    if (!rootManifest) {
      throw new ContractError(
        'PLUGIN_NOT_FOUND',
        `Marketplace not found: ${input.marketplace}`
      )
    }
    const allowCross = new Set(rootManifest.allowCrossMarketplaceDependenciesOn ?? [])
    const closure = resolveDependencyClosure({
      allowCrossMarketplaces: allowCross,
      marketplace: input.marketplace,
      name: input.name,
      storageRoot: this.storageRoot
    })
    const rootId = `${input.name}@${input.marketplace}`
    const activations: AtomicDirectoryActivation[] = []
    const addedRecords: PluginRecord[] = []
    let rootSummary: PluginSummary | undefined
    try {
      for (const pluginId of closure) {
        const { marketplace, name } = parsePluginId(pluginId)
        const manifest = loadMarketplaceManifestSync(this.storageRoot, marketplace)
        if (!manifest) throw new ContractError('PLUGIN_NOT_FOUND', `Marketplace not found: ${marketplace}`)
        const entry = manifest.plugins.find((plugin) => plugin.name === name)
        if (!entry) throw new ContractError('PLUGIN_NOT_FOUND', `Plugin not found: ${pluginId}`)
        const isRoot = pluginId === rootId
        if (!isRoot && this.registry.get(pluginId)) continue
        if (isRoot) {
          const existingByName = this.registry.list().find((rec) => rec.name === name)
          const existing = this.registry.get(pluginId) ?? existingByName
          if (existing && !input.overwrite) {
            throw new ContractError('PLUGIN_ALREADY_INSTALLED', `Plugin already installed: ${existing.id}`)
          }
        }
        this.emitProgress({ phase: 'download', source: pluginId, pluginId })
        const cached = await cacheMarketplacePlugin({
          entry,
          marketplace,
          storageRoot: this.storageRoot
        })
        if (cached.activation) activations.push(cached.activation)
        const previous = this.registry.get(pluginId)
        if (previous) this.registry.remove(previous.id)
        const version = cached.version
        const description = entry.description
        const rec: PluginRecord = {
          id: pluginId,
          name,
          version,
          rootPath: cached.target,
          enabled: true,
          sourceKind: 'marketplace',
          sourceLabel: marketplace,
          installedAt: previous?.installedAt ?? Date.now()
        }
        this.registry.add(rec)
        addedRecords.push(rec)
        if (isRoot) rootSummary = toSummary(rec, description)
      }
      this.notify()
      await this.reloadKernel()
      this.emitProgress({ phase: 'done', pluginId: rootId })
      if (!rootSummary) {
        throw new ContractError('PLUGIN_NOT_FOUND', `Plugin not found: ${rootId}`)
      }
      return rootSummary
    } catch (error) {
      for (const activation of activations.reverse()) {
        try {
          await activation.rollback()
        } catch {
        }
      }
      for (const rec of addedRecords.reverse()) {
        try {
          this.registry.remove(rec.id)
        } catch {
        }
      }
      this.emitProgress({
        phase: 'error',
        pluginId: rootId,
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
}

function parseDirectUrlSource(url: string): {
  kind: 'github' | 'zip'
  ref?: string
  sha256?: string
  url: string
} {
  const { url: cleanUrl, ref } = splitRef(url.trim())
  const parsedUrl = tryParseUrl(cleanUrl)
  const pathEndsWithZip = (parsedUrl?.pathname ?? cleanUrl).toLowerCase().endsWith('.zip')
  if (pathEndsWithZip) {
    const shaMatch = /[?&]sha256=([a-f0-9]{64})/i.exec(cleanUrl)
    return {
      kind: 'zip',
      ...(ref ? { ref } : {}),
      ...(shaMatch?.[1] ? { sha256: shaMatch[1].toLowerCase() } : {}),
      url: cleanUrl
    }
  }
  if (parsedUrl && (parsedUrl.hostname === 'github.com' || parsedUrl.hostname === 'www.github.com')) {
    const match = parsedUrl.pathname.match(/^\/([^/]+\/[^/]+?)(?:\/|\.git|$)/)
    if (match?.[1]) {
      const gitUrl = cleanUrl.endsWith('.git') ? cleanUrl : `https://github.com/${match[1]}.git`
      return { kind: 'github', ...(ref ? { ref } : {}), url: gitUrl }
    }
  }
  if (cleanUrl.endsWith('.git')) {
    return { kind: 'github', ...(ref ? { ref } : {}), url: cleanUrl }
  }
  throw new ContractError('PLUGIN_SOURCE_INVALID', `Unsupported plugin URL source: ${url}`)
}
