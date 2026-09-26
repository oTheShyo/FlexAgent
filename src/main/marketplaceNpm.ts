/**
 * npm/npx marketplace source — resolve a package from an npm registry into a
 * plain directory that the marketplace install pipeline can stage atomically
 * (issue 24, gap-audit B9).
 *
 * Flow mirrors the zip source: metadata → tarball download → integrity check →
 * extract → (optional) sub-path. Every stage lands in the observability
 * pipeline JSONL (`kind: 'marketplace'`) so a failed install is diagnosable to
 * the exact stage without rerunning anything.
 *
 * The registry base URL is overridable via FLEXAGENT_NPM_REGISTRY — both for
 * mirrors and for the acceptance harness, which serves the registry and
 * tarball from a local server. Trusting that override is deliberate: whoever
 * sets it owns the install source either way.
 */
import { createHash } from 'crypto'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { x as tarExtract } from 'tar'
import { ContractError } from '../shared/contract'
import { isRecord, resolveInside } from './marketplaceHelpers'
import { observePipeline } from './observability'

const NPM_DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const NPM_METADATA_TIMEOUT_MS = 30_000
const NPM_TARBALL_TIMEOUT_MS = 120_000
const NPM_TARBALL_MAX_BYTES = 200 * 1024 * 1024
const NPM_MAX_REDIRECTS = 5

export interface ResolvedNpmPackageSource {
  cleanup?: () => Promise<void>
  /** Resolved registry version (exact pick or dist-tags.latest). */
  version: string
  path: string
}

export interface NpmPackageSourceInput {
  /** npm package name, scoped names included (`@scope/name`). */
  package: string
  /** Sub-path inside the package that holds the plugin (optional). */
  path?: string
  signal?: AbortSignal
  /** Explicit version; when omitted the registry's dist-tags.latest is used. */
  version?: string
}

function npmRegistryBase(): string {
  const override = process.env.FLEXAGENT_NPM_REGISTRY?.trim()
  return override !== undefined && override.length > 0
    ? override.replace(/\/+$/u, '')
    : NPM_DEFAULT_REGISTRY
}

/**
 * Split `<name>[@<version>]` respecting scoped names: `@scope/name@1.2.3`
 * splits on the last `@` after the scope, `@scope/name` keeps the whole thing.
 */
export function parseNpmPackageSpec(raw: string): { name: string; version?: string } {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('@')) {
    const at = trimmed.lastIndexOf('@')
    if (at > 0) {
      const name = trimmed.slice(0, at)
      const version = trimmed.slice(at + 1)
      if (name.length > 0 && version.length > 0) return { name, version }
    }
    if (trimmed.length === 0) {
      throw new ContractError('PLUGIN_SOURCE_INVALID', 'npm source package name is empty')
    }
    return { name: trimmed }
  }
  const slash = trimmed.indexOf('/')
  if (slash < 0) {
    throw new ContractError('PLUGIN_SOURCE_INVALID', `npm source is not a valid scoped name: ${raw}`)
  }
  const at = trimmed.lastIndexOf('@')
  if (at > slash) {
    const name = trimmed.slice(0, at)
    const version = trimmed.slice(at + 1)
    if (name.length > 1 && version.length > 0) return { name, version }
  }
  return { name: trimmed }
}

function observeNpmStage(
  pkg: string,
  stage: string,
  ok: boolean,
  startedAt: number,
  note?: string
): void {
  observePipeline({
    kind: 'marketplace',
    stage: `npm ${pkg} ${stage}`,
    ok,
    durationMs: Date.now() - startedAt,
    ...(note === undefined ? {} : { note })
  })
}

function npmRegistryUrl(pkg: string): string {
  // Scoped names travel as @scope%2Fname on the registry.
  return `${npmRegistryBase()}/${pkg.replace('/', '%2F')}`
}

async function fetchJsonMetadata(
  pkg: string,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(NPM_METADATA_TIMEOUT_MS)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(npmRegistryUrl(pkg), {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      method: 'GET',
      redirect: 'follow',
      signal: composed
    })
  } catch (error) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `npm registry metadata fetch failed for ${pkg}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (response.status === 404) {
    throw new ContractError('PLUGIN_NOT_FOUND', `npm package not found: ${pkg}`)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `npm registry returned ${response.status} for ${pkg}`
    )
  }
  const parsed: unknown = await response.json()
  if (!isRecord(parsed)) {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `npm registry metadata is not an object: ${pkg}`)
  }
  return parsed
}

function pickVersion(
  pkg: string,
  metadata: Record<string, unknown>,
  requested: string | undefined
): { manifest: Record<string, unknown>; version: string } {
  const versions = metadata.versions
  if (!isRecord(versions)) {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `npm metadata has no versions map: ${pkg}`)
  }
  let picked = requested
  if (picked === undefined) {
    const distTags = metadata['dist-tags']
    picked =
      isRecord(distTags) && typeof distTags.latest === 'string'
        ? distTags.latest
        : undefined
  }
  if (picked === undefined || !isRecord(versions[picked])) {
    throw new ContractError(
      'PLUGIN_NOT_FOUND',
      `npm package ${pkg} has no version ${picked ?? '(latest)'}`
    )
  }
  return { manifest: versions[picked] as Record<string, unknown>, version: picked }
}

interface TarballTarget {
  integrity?: string
  url: string
}

function readTarballTarget(pkg: string, versionManifest: Record<string, unknown>): TarballTarget {
  const dist = versionManifest.dist
  if (!isRecord(dist) || typeof dist.tarball !== 'string') {
    throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `npm version manifest has no tarball: ${pkg}`)
  }
  return {
    ...(typeof dist.integrity === 'string' ? { integrity: dist.integrity } : {}),
    url: dist.tarball
  }
}

async function downloadNpmTarball(input: {
  signal: AbortSignal | undefined
  url: string
}): Promise<Uint8Array> {
  let currentUrl = input.url
  for (let redirects = 0; redirects <= NPM_MAX_REDIRECTS; redirects += 1) {
    input.signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(NPM_TARBALL_TIMEOUT_MS)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(currentUrl, { method: 'GET', redirect: 'manual', signal })
    } catch (error) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `npm tarball download failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new ContractError(
          'PLUGIN_DOWNLOAD_FAILED',
          `npm tarball redirect is missing Location header: ${currentUrl}`
        )
      }
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `npm tarball download returned ${response.status} for ${currentUrl}`
      )
    }
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > NPM_TARBALL_MAX_BYTES) {
      throw new ContractError(
        'PLUGIN_DOWNLOAD_FAILED',
        `npm tarball exceeds size limit: ${buffer.byteLength}/${NPM_TARBALL_MAX_BYTES}`
      )
    }
    return buffer
  }
  throw new ContractError(
    'PLUGIN_DOWNLOAD_FAILED',
    `npm tarball download exceeded redirect limit: ${input.url}`
  )
}

function verifyNpmIntegrity(tarball: Uint8Array, integrity: string | undefined, pkg: string): void {
  if (integrity === undefined) return
  const dash = integrity.indexOf('-')
  const algorithm = dash > 0 ? integrity.slice(0, dash) : ''
  const expected = dash > 0 ? integrity.slice(dash + 1) : ''
  if ((algorithm !== 'sha512' && algorithm !== 'sha256') || expected.length === 0) {
    // Registry sent an integrity format we don't understand; refuse rather
    // than silently installing unverified bytes.
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `npm integrity format unsupported for ${pkg}: ${integrity.slice(0, 16)}…`
    )
  }
  const actual = createHash(algorithm).update(tarball).digest('base64')
  if (actual !== expected) {
    throw new ContractError(
      'PLUGIN_DOWNLOAD_FAILED',
      `npm tarball integrity mismatch for ${pkg}: expected ${algorithm} ${expected}, got ${actual}`
    )
  }
}

export async function resolveNpmPackageSource(
  input: NpmPackageSourceInput
): Promise<ResolvedNpmPackageSource> {
  const { name, version: specVersion } = parseNpmPackageSpec(input.package)
  const requestedVersion = input.version ?? specVersion

  const resolveStarted = Date.now()
  const metadata = await fetchJsonMetadata(name, input.signal)
  const { manifest, version } = pickVersion(name, metadata, requestedVersion)
  const target = readTarballTarget(name, manifest)
  observeNpmStage(name, 'resolve', true, resolveStarted, `version ${version}`)

  const downloadStarted = Date.now()
  let tarball: Uint8Array
  try {
    tarball = await downloadNpmTarball({ signal: input.signal, url: target.url })
    verifyNpmIntegrity(tarball, target.integrity, name)
  } catch (error) {
    // Stage-level failure event so the pipeline log diagnoses the phase, not
    // just the outer install wrapper.
    observeNpmStage(
      name,
      'download+verify',
      false,
      downloadStarted,
      error instanceof Error ? error.message : String(error)
    )
    throw error
  }
  observeNpmStage(name, 'download+verify', true, downloadStarted, `${tarball.byteLength} bytes`)

  const extractStarted = Date.now()
  const workDir = await mkdtemp(join(tmpdir(), 'flex-npm-'))
  try {
    const tgzPath = join(workDir, 'package.tgz')
    await writeFile(tgzPath, tarball)
    // npm tarballs carry a single `package/` root; strip:1 lands the contents
    // directly in workDir, so the plugin root is workDir itself.
    await tarExtract({ cwd: workDir, file: tgzPath, strip: 1 })
    let root = resolve(workDir)
    if (input.path !== undefined && input.path.length > 0) {
      const sub = resolveInside(root, input.path)
      if (sub === null) {
        throw new ContractError(
          'PLUGIN_PATH_INVALID',
          `npm package sub-path escapes the package root: ${input.path}`
        )
      }
      root = sub
    }
    observeNpmStage(name, 'extract', true, extractStarted)
    return {
      cleanup: async () => {
        await rm(workDir, { recursive: true, force: true })
      },
      path: root,
      version
    }
  } catch (error) {
    observeNpmStage(name, 'extract', false, extractStarted, error instanceof Error ? error.message : String(error))
    await rm(workDir, { recursive: true, force: true })
    throw error
  }
}
