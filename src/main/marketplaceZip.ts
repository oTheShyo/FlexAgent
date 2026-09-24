import { createHash } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'path'
import { inflateRawSync } from 'zlib'
import { ContractError } from '../shared/contract'
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  fileExists
} from './marketplaceHelpers'

const ZIP_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024
const ZIP_EXTRACT_MAX_BYTES = 500 * 1024 * 1024
const ZIP_MAX_ENTRIES = 20_000
const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024
const ZIP_MAX_REDIRECTS = 5
const ZIP_DOWNLOAD_TIMEOUT_MS = 180_000
const ZIP_TEMP_PREFIX = 'flex-plugin-zip-'
const ZIP_DENIED_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie'
])
const ZIP_REQUIRED_SHA256_PATTERN = /^[a-f0-9]{64}$/u
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export interface ResolvedZipPluginSourceRoot {
  cleanup: () => Promise<void>
  path: string
}

interface ResolveZipPluginSourceInput {
  headers?: Record<string, string>
  path?: string
  sha256: string
  signal?: AbortSignal
  stripRoot?: boolean
  url: string
}

interface ResolveHttpZipSourceInput {
  headers?: Record<string, string>
  path?: string
  requireSingleRoot?: boolean
  sha256?: string
  signal?: AbortSignal
  stripRoot?: boolean
  url: string
}

export class PluginZipDownloadError extends Error {
  readonly status?: number
  readonly url: string

  constructor(message: string, url: string, status?: number) {
    super(message)
    this.name = 'PluginZipDownloadError'
    this.url = url
    if (status !== undefined) this.status = status
  }
}

interface ZipCentralEntry {
  compressedSize: number
  compressionMethod: number
  crc32: number
  externalFileAttributes: number
  flags: number
  localHeaderOffset: number
  fileName: string
  uncompressedSize: number
}

interface ZipExtractResult {
  topLevelSegments: Set<string>
}

type ZipEntryKind = 'directory' | 'file'

export async function resolveZipPluginSource(
  input: ResolveZipPluginSourceInput
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipSourceInput(input)
  return resolveHttpZipSource({
    headers: input.headers,
    path: input.path,
    sha256: input.sha256,
    signal: input.signal,
    stripRoot: input.stripRoot,
    url: input.url
  })
}

export async function resolveHttpZipSource(
  input: ResolveHttpZipSourceInput
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipDownloadUrl(input.url)
  validateZipHeaders(input.headers)
  if (input.path !== undefined) normalizeZipRelativePath(input.path)
  if (input.sha256 !== undefined && !ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      'Plugin zip source sha256 must be a 64 character hex string'
    )
  }
  const tempRoot = await mkdtemp(join(tmpdir(), ZIP_TEMP_PREFIX))
  const archivePath = join(tempRoot, 'source.zip')
  const extractRoot = join(tempRoot, 'extract')
  const cleanup = async (): Promise<void> => {
    await rm(tempRoot, { force: true, recursive: true })
  }

  try {
    throwIfAborted(input.signal)
    const zipBytes = await downloadZipArchive({
      headers: input.headers,
      signal: input.signal,
      url: input.url
    })
    const actualSha256 = createHash('sha256').update(zipBytes).digest('hex')
    if (input.sha256 !== undefined && actualSha256 !== input.sha256.toLowerCase()) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `Plugin zip sha256 mismatch: expected=${input.sha256.toLowerCase()}, actual=${actualSha256}`
      )
    }

    await writeFile(archivePath, zipBytes)
    const extracted = await extractZipArchive({
      archivePath,
      signal: input.signal,
      targetRoot: extractRoot
    })
    const pluginRoot = resolveZipRoot({
      extractRoot,
      path: input.path,
      requireSingleRoot: input.requireSingleRoot,
      stripRoot: input.stripRoot,
      topLevelSegments: extracted.topLevelSegments
    })
    return { cleanup, path: pluginRoot }
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup)
    throw appendPluginSourceCleanupError(error, cleanupError)
  }
}

export async function resolveLocalZipSource(
  input: { path?: string; stripRoot?: boolean },
  archiveFilePath: string
): Promise<ResolvedZipPluginSourceRoot> {
  if (input.path !== undefined) normalizeZipRelativePath(input.path)
  const tempRoot = await mkdtemp(join(tmpdir(), ZIP_TEMP_PREFIX))
  const extractRoot = join(tempRoot, 'extract')
  const cleanup = async (): Promise<void> => {
    await rm(tempRoot, { force: true, recursive: true })
  }
  try {
    const zipBytes = await readFile(archiveFilePath)
    await writeFile(join(tempRoot, 'source.zip'), zipBytes)
    const extracted = await extractZipArchive({
      archivePath: join(tempRoot, 'source.zip'),
      targetRoot: extractRoot
    })
    const pluginRoot = resolveZipRoot({
      extractRoot,
      path: input.path,
      stripRoot: input.stripRoot,
      topLevelSegments: extracted.topLevelSegments
    })
    return { cleanup, path: pluginRoot }
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup)
    throw appendPluginSourceCleanupError(error, cleanupError)
  }
}

export function isZipPluginUrlSource(
  source: unknown
): source is { source: 'url'; type: 'zip'; sha256: string; url: string } {
  return (
    typeof source === 'object' &&
    source !== null &&
    !Array.isArray(source) &&
    'source' in source &&
    (source as { source?: unknown }).source === 'url' &&
    (source as { type?: unknown }).type === 'zip' &&
    typeof (source as { url?: unknown }).url === 'string' &&
    typeof (source as { sha256?: unknown }).sha256 === 'string'
  )
}

export function readZipPluginSourceSha256(source: unknown): string | undefined {
  if (!isZipPluginUrlSource(source)) return undefined
  return source.sha256
}

function validateZipSourceInput(input: ResolveZipPluginSourceInput): void {
  validateZipDownloadUrl(input.url)
  if (!ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      'Plugin zip source sha256 must be a 64 character hex string'
    )
  }
  validateZipHeaders(input.headers)
  if (input.path !== undefined) {
    normalizeZipRelativePath(input.path)
  }
}

async function downloadZipArchive(input: {
  headers?: Record<string, string>
  signal?: AbortSignal
  url: string
}): Promise<Uint8Array> {
  let currentUrl = input.url
  let currentHeaders = input.headers
  for (let redirectCount = 0; redirectCount <= ZIP_MAX_REDIRECTS; redirectCount += 1) {
    throwIfAborted(input.signal)
    validateZipDownloadUrl(currentUrl)
    const timeout = AbortSignal.timeout(ZIP_DOWNLOAD_TIMEOUT_MS)
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout
    let response: Response
    try {
      response = await fetch(currentUrl, {
        headers: currentHeaders,
        method: 'GET',
        redirect: 'manual',
        signal
      })
    } catch (error) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `Failed to download plugin zip: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        throw new ContractError(
          'PLUGIN_DOWNLOAD_FAILED',
          `Plugin zip download redirect is missing Location header: ${currentUrl}`
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
      throw new PluginZipDownloadError(
        `Failed to download plugin zip: ${response.status} ${response.statusText}`,
        currentUrl,
        response.status
      )
    }
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > ZIP_DOWNLOAD_MAX_BYTES) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `Plugin zip download exceeds size limit: ${buffer.byteLength}/${ZIP_DOWNLOAD_MAX_BYTES}`
      )
    }
    return buffer
  }
  throw new ContractError(
    'PLUGIN_DOWNLOAD_FAILED',
    `Plugin zip download exceeded redirect limit: ${input.url}`
  )
}

function readCentralDirectory(buffer: Uint8Array): ZipCentralEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let eocdOffset = -1
  const searchStart = Math.max(0, buffer.byteLength - 22 - 65535)
  for (let i = buffer.byteLength - 22; i >= searchStart; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', 'Plugin zip end-of-central-directory not found')
  }
  const totalEntries = view.getUint16(eocdOffset + 10, true)
  const centralSize = view.getUint32(eocdOffset + 12, true)
  const centralOffset = view.getUint32(eocdOffset + 16, true)
  if (centralOffset + centralSize > buffer.byteLength) {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', 'Plugin zip central directory is out of bounds')
  }
  const decoder = new TextDecoder()
  const entries: ZipCentralEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ContractError('PLUGIN_DOWNLOAD_FAILED', 'Plugin zip central directory entry is invalid')
    }
    const flags = view.getUint16(offset + 8, true)
    const compressionMethod = view.getUint16(offset + 10, true)
    const crc32 = view.getUint32(offset + 16, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const externalFileAttributes = view.getUint32(offset + 38, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength)
    const fileName = decoder.decode(nameBytes)
    entries.push({
      compressedSize,
      compressionMethod,
      crc32,
      externalFileAttributes,
      flags,
      localHeaderOffset,
      fileName,
      uncompressedSize
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function extractZipArchive(input: {
  archivePath: string
  signal?: AbortSignal
  targetRoot: string
}): Promise<ZipExtractResult> {
  const targetRoot = resolve(input.targetRoot)
  await mkdir(targetRoot, { recursive: true })
  const raw = await readFile(input.archivePath)
  const buffer = new Uint8Array(raw)
  const entries = readCentralDirectory(buffer)
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Plugin zip has too many entries: ${entries.length}/${ZIP_MAX_ENTRIES}`
    )
  }
  const topLevelSegments = new Set<string>()
  let extractedBytes = 0

  for (const entry of entries) {
    throwIfAborted(input.signal)
    const normalizedPath = normalizeZipRelativePath(entry.fileName)
    topLevelSegments.add(normalizedPath.split('/')[0] ?? normalizedPath)
    const targetPath = resolveZipPathWithin(targetRoot, normalizedPath)
    const kind = classifyZipEntry(entry)
    if (kind === 'directory') {
      await mkdir(targetPath, { recursive: true })
      continue
    }
    if (entry.uncompressedSize > ZIP_MAX_SINGLE_FILE_BYTES) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `Plugin zip entry exceeds single file limit: ${entry.fileName}`
      )
    }
    const bytes = readZipEntryBytes(buffer, entry)
    extractedBytes += bytes.byteLength
    if (extractedBytes > ZIP_EXTRACT_MAX_BYTES) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `Plugin zip extracted content exceeds limit: ${extractedBytes}/${ZIP_EXTRACT_MAX_BYTES}`
      )
    }
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, bytes)
  }

  return { topLevelSegments }
}

function readZipEntryBytes(buffer: Uint8Array, entry: ZipCentralEntry): Uint8Array {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const localOffset = entry.localHeaderOffset
  if (localOffset + 30 > buffer.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Plugin zip local header is invalid: ${entry.fileName}`
    )
  }
  const nameLength = view.getUint16(localOffset + 26, true)
  const extraLength = view.getUint16(localOffset + 28, true)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.byteLength) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Plugin zip entry data is out of bounds: ${entry.fileName}`
    )
  }
  const compressed = buffer.subarray(dataStart, dataEnd)
  let out: Uint8Array
  if (entry.compressionMethod === 0) {
    out = compressed
  } else if (entry.compressionMethod === 8) {
    out = inflateRawSync(compressed)
  } else {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Unsupported plugin zip compression method ${entry.compressionMethod}: ${entry.fileName}`
    )
  }
  if (out.byteLength !== entry.uncompressedSize) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Plugin zip entry size mismatch: ${entry.fileName}`
    )
  }
  return out
}

function resolveZipRoot(input: {
  extractRoot: string
  path?: string
  requireSingleRoot?: boolean
  stripRoot?: boolean
  topLevelSegments: Set<string>
}): string {
  const extractRoot = resolve(input.extractRoot)
  if (input.requireSingleRoot && input.topLevelSegments.size !== 1) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Plugin zip must contain exactly one top-level directory: ${input.topLevelSegments.size}`
    )
  }
  if (input.path !== undefined) {
    const requested = resolveZipPathWithin(extractRoot, normalizeZipRelativePath(input.path))
    if (!directoryExists(requested)) {
      throw new ContractError(
        'PLUGIN_PATH_INVALID',
        `Plugin zip source subdirectory does not exist: ${input.path}`
      )
    }
    return requested
  }

  if (hasPluginManifest(extractRoot)) {
    return extractRoot
  }

  if (input.stripRoot !== false && input.topLevelSegments.size === 1) {
    const [segment] = [...input.topLevelSegments]
    if (segment) {
      const candidate = resolveZipPathWithin(extractRoot, segment)
      if (directoryExists(candidate)) return candidate
    }
  }

  if (!directoryExists(extractRoot)) {
    throw new ContractError('PLUGIN_PATH_INVALID', 'Plugin zip did not extract a plugin root directory')
  }
  return extractRoot
}

function hasPluginManifest(rootPath: string): boolean {
  return (
    fileExists(join(rootPath, '.flex-plugin', 'plugin.json')) ||
    fileExists(join(rootPath, '.zcode-plugin', 'plugin.json')) ||
    fileExists(join(rootPath, '.claude-plugin', 'plugin.json')) ||
    fileExists(join(rootPath, '.codex-plugin', 'plugin.json')) ||
    fileExists(join(rootPath, 'plugin.json'))
  )
}

function classifyZipEntry(entry: ZipCentralEntry): ZipEntryKind {
  const isDirectoryByName = entry.fileName.endsWith('/')
  if ((entry.flags & 0x1) !== 0) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Encrypted plugin zip entries are not supported: ${entry.fileName}`
    )
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  const fileType = unixMode & 0o170000
  if (fileType === 0o120000) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Plugin zip entry symlinks are not supported: ${entry.fileName}`
    )
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `Unsupported plugin zip entry type: ${entry.fileName}`
    )
  }
  if (fileType === 0o040000 || isDirectoryByName) return 'directory'
  return 'file'
}

function normalizeZipRelativePath(path: string): string {
  if (path.includes('\0')) {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `Unsafe plugin zip path: ${path}`)
  }
  const withoutTrailingSlash = path.replace(/\/+$/u, '')
  if (
    !withoutTrailingSlash ||
    path.includes('\\') ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    /^[a-zA-Z]:/u.test(path)
  ) {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `Unsafe plugin zip path: ${path}`)
  }
  const parts = withoutTrailingSlash.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `Unsafe plugin zip path: ${path}`)
  }
  return withoutTrailingSlash
}

function resolveZipPathWithin(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath)
  const target = resolve(root, ...relativePath.split('/'))
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `Unsafe plugin zip path: ${relativePath}`)
  }
  return target
}

function validateZipHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return
  for (const [key, value] of Object.entries(headers)) {
    if (ZIP_DENIED_HEADERS.has(key.toLowerCase())) {
      throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `Plugin zip source header is not allowed: ${key}`)
    }
    if (typeof value !== 'string') {
      throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `Plugin zip source header must be a string: ${key}`)
    }
  }
}

function validateZipDownloadUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ContractError('PLUGIN_SOURCE_INVALID', `Plugin zip source URL is invalid: ${value}`)
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return
  throw new ContractError('PLUGIN_SOURCE_INVALID', `Plugin zip source URL must be HTTPS: ${value}`)
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    isIpv4LoopbackHost(normalized)
  )
}

function isIpv4LoopbackHost(hostname: string): boolean {
  const match = /^127(?:\.(\d{1,3})){3}$/u.exec(hostname)
  if (!match) return false
  return hostname
    .split('.')
    .every((part) => Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255)
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('Plugin operation cancelled')
    error.name = 'AbortError'
    throw error
  }
}
