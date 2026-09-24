import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { cp, mkdir, readFile, readdir, rename, rm } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, relative, resolve, sep } from 'path'
import {
  ContractError,
  type AddSkillHubInput,
  type SkillHubEntry,
  type SkillHubInfo,
  type SkillProvenance,
  type SkillSummary,
  type InstallSkillSource
} from '../../shared/contract'
import { cleanupPluginSourceBestEffort } from '../marketplaceHelpers'
import {
  PluginZipDownloadError,
  resolveHttpZipSource,
  type ResolvedZipPluginSourceRoot
} from '../marketplaceZip'
import { listUserSkillDirs, readSkillMeta, SKILLS_HOME } from './skillManage'
import {
  computeTreeHash,
  isReinstallable,
  PROVENANCE_FILE,
  readProvenance,
  writeProvenance
} from './skillProvenance'

/**
 * Skill Hub (v1.8): browsable remote skill catalogs + local-folder loading.
 *
 * Mirrors the WorkBuddy/Claude marketplace UX at skill granularity:
 * - a built-in hub (anthropics/skills, GitHub directory mode) works out of the box
 * - users can register their own hubs: a GitHub repo (`github:owner/repo`) or a
 *   JSON index (`https://…/skills.json` → `{ skills: [{ name, description, source }] }`)
 * - installing resolves the source (GitHub zipball / https zip / local folder),
 *   validates the SKILL.md frontmatter, and atomically swaps it into
 *   `~/.flexagent/skills/<name>`
 */

const HUBS_FILE = join(homedir(), '.flexagent', 'skillhubs.json')
const BROWSE_TTL_MS = 10 * 60 * 1000
const BROWSE_CACHE_MAX = 20
const MAX_ENTRIES_PER_HUB = 60
const MAX_SCAN_DEPTH = 4
const FETCH_TIMEOUT_MS = 15_000

const BUILTIN_HUB: SkillHubInfo = {
  id: 'official',
  name: 'Official',
  url: 'github:anthropics/skills',
  builtIn: true,
  skillCount: 0
}

const HUB_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u
const UA = 'FlexAgent-SkillHub-Installer'

interface StoredHub {
  id: string
  name: string
  url: string
}

// ─── Source-string grammar ────────────────────────────────────────────────────

interface ParsedGithubSource {
  kind: 'github'
  owner: string
  repo: string
  ref?: string
  path?: string
}

interface ParsedZipSource {
  kind: 'zip'
  url: string
}

type ParsedSource = ParsedGithubSource | ParsedZipSource

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/u

/** `github:owner/repo[@ref][/sub/path]` — also accepts a full https github.com URL. */
export function parseSkillSource(raw: string): ParsedSource {
  const value = raw.trim()
  if (value.length === 0) {
    throw new ContractError('SKILL_SOURCE_INVALID', 'Skill source is empty')
  }
  let rest = value
  if (rest.startsWith('github:')) {
    // Shorthand `github:owner/repo[@ref][/path]` — parsed directly (not via
    // URL) so the `@ref` segment survives; `@v1/sub/dir` means ref=v1, path=sub/dir.
    let body = rest.slice('github:'.length)
    let refTail = ''
    const at = body.indexOf('@')
    if (at >= 0) {
      refTail = body.slice(at + 1)
      body = body.slice(0, at)
    }
    const parts = body.split('/').filter(Boolean)
    const owner = parts[0] ?? ''
    const repo = (parts[1] ?? '').replace(/\.git$/u, '')
    if (parts.length < 2 || !GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo)) {
      throw new ContractError('SKILL_SOURCE_INVALID', `Invalid GitHub repository: ${value}`)
    }
    const tailParts = refTail.split('/').filter(Boolean)
    const ref = tailParts[0] || undefined
    const pathTail = tailParts.slice(1).join('/')
    const path = [...parts.slice(2), ...(pathTail !== '' ? [pathTail] : [])].join('/') || undefined
    return {
      kind: 'github',
      owner,
      repo,
      ...(ref !== undefined ? { ref } : {}),
      ...(path !== undefined ? { path } : {})
    }
  }
  if (rest.startsWith('https://')) {
    let url: URL
    try {
      url = new URL(rest)
    } catch {
      throw new ContractError('SKILL_SOURCE_INVALID', `Skill source is not a valid URL: ${value}`)
    }
    const host = url.hostname.toLowerCase()
    const segments = url.pathname.split('/').filter(Boolean)
    if ((host === 'github.com' || host === 'www.github.com') && segments.length >= 2) {
      const owner = segments[0] ?? ''
      const repo = (segments[1] ?? '').replace(/\.git$/u, '')
      if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo)) {
        throw new ContractError('SKILL_SOURCE_INVALID', `Invalid GitHub repository: ${value}`)
      }
      // `github.com/owner/repo/tree/<ref>[/more/path…]`
      if (segments[2] === 'tree' && segments.length >= 4) {
        const ref = segments[3] ?? ''
        const path = segments.slice(4).join('/') || undefined
        return { kind: 'github', owner, repo, ref: ref || undefined, path }
      }
      // `github:owner/repo[/sub/path]` shorthand — @ref is the only ref form,
      // so any extra segments are a sub-path.
      if (segments.length > 2) {
        return { kind: 'github', owner, repo, path: segments.slice(2).join('/') }
      }
      // Query/hash forms are tolerated and dropped.
      return { kind: 'github', owner, repo }
    }
    if (url.pathname.toLowerCase().endsWith('.zip')) {
      return { kind: 'zip', url: rest }
    }
    throw new ContractError(
      'SKILL_SOURCE_INVALID',
      `Unsupported skill source: ${value} (use github:owner/repo[/path], a github.com tree URL, or an https .zip URL)`
    )
  }
  throw new ContractError(
    'SKILL_SOURCE_INVALID',
    `Unsupported skill source: ${value} (use github:owner/repo[/path] or an https .zip URL)`
  )
}

/** Canonical installable source string for a hub entry. */
function sourceToString(parsed: ParsedGithubSource): string {
  const ref = parsed.ref !== undefined ? `@${parsed.ref}` : ''
  const path = parsed.path !== undefined && parsed.path.length > 0 ? `/${parsed.path}` : ''
  return `github:${parsed.owner}/${parsed.repo}${ref}${path}`
}

// ─── Hub persistence ─────────────────────────────────────────────────────────

function readStoredHubs(): StoredHub[] {
  try {
    if (!existsSync(HUBS_FILE)) return []
    const raw = JSON.parse(readFileSync(HUBS_FILE, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is StoredHub =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as StoredHub).id === 'string' &&
        typeof (entry as StoredHub).url === 'string'
    )
  } catch {
    return []
  }
}

export function listSkillHubs(): SkillHubInfo[] {
  const stored = readStoredHubs().map((hub) => ({
    id: hub.id,
    name: hub.name,
    url: hub.url,
    builtIn: false,
    skillCount: browseCache.get(hub.id)?.entries.length ?? 0
  }))
  return [
    { ...BUILTIN_HUB, skillCount: browseCache.get(BUILTIN_HUB.id)?.entries.length ?? 0 },
    ...stored
  ]
}

export function addSkillHub(input: AddSkillHubInput): SkillHubInfo {
  const name = input.name.trim().toLowerCase()
  if (!HUB_ID_PATTERN.test(name)) {
    throw new ContractError(
      'INVALID_INPUT',
      `Hub id must match ${HUB_ID_PATTERN.source}: ${input.name}`
    )
  }
  if (name === BUILTIN_HUB.id) {
    throw new ContractError('INVALID_INPUT', `Hub id "${name}" is reserved`)
  }
  parseHubUrl(input.url) // validate early
  const stored = readStoredHubs()
  if (stored.some((hub) => hub.id === name)) {
    stored.splice(
      stored.findIndex((hub) => hub.id === name),
      1
    )
  }
  stored.push({ id: name, name, url: input.url.trim() })
  persistHubs(stored)
  return { id: name, name, url: input.url.trim(), builtIn: false, skillCount: 0 }
}

export function removeSkillHub(id: string): void {
  if (id === BUILTIN_HUB.id) {
    throw new ContractError('INVALID_INPUT', 'The built-in hub cannot be removed')
  }
  const stored = readStoredHubs()
  const next = stored.filter((hub) => hub.id !== id)
  if (next.length === stored.length) {
    throw new ContractError('SKILL_HUB_UNAVAILABLE', `Unknown skill hub: ${id}`)
  }
  persistHubs(next)
  browseCache.delete(id)
}

function persistHubs(hubs: StoredHub[]): void {
  writeFileSync(HUBS_FILE, `${JSON.stringify(hubs, null, 2)}\n`, 'utf8')
}

/** Split a hub url into github-dir mode, normalized (JSON hubs end in .json and skip this). */
function parseHubUrl(url: string): ParsedGithubSource {
  const parsed = parseSkillSource(url)
  if (parsed.kind === 'zip') {
    throw new ContractError(
      'SKILL_SOURCE_INVALID',
      `Hub url must be a GitHub repo or a .json index, not a zip: ${url}`
    )
  }
  return parsed
}

// ─── Browse ───────────────────────────────────────────────────────────────────

interface BrowseCacheEntry {
  entries: SkillHubEntry[]
  fetchedAt: number
}

const browseCache = new Map<string, BrowseCacheEntry>()

export async function browseSkillHub(id?: string): Promise<SkillHubEntry[]> {
  const hubs = id === undefined ? listSkillHubs() : listSkillHubs().filter((hub) => hub.id === id)
  if (id !== undefined && hubs.length === 0) {
    throw new ContractError('SKILL_HUB_UNAVAILABLE', `Unknown skill hub: ${id}`)
  }
  const installed = new Set(listUserSkillDirs().map((skill) => skill.name))
  const results: SkillHubEntry[] = []
  for (const hub of hubs) {
    const cached = browseCache.get(hub.id)
    if (cached !== undefined && Date.now() - cached.fetchedAt < BROWSE_TTL_MS) {
      // Installed flags must reflect installs/uninstalls that happened after
      // this cache entry was fetched.
      for (const entry of cached.entries) entry.installed = installed.has(entry.name)
      results.push(...cached.entries)
      continue
    }
    const entries = await fetchHubEntries(hub)
    for (const entry of entries) {
      entry.installed = installed.has(entry.name)
    }
    browseCache.set(hub.id, { entries, fetchedAt: Date.now() })
    if (browseCache.size > BROWSE_CACHE_MAX) {
      const oldest = browseCache.keys().next().value
      if (oldest !== undefined) browseCache.delete(oldest)
    }
    results.push(...entries)
  }
  return results
}

async function fetchHubEntries(hub: SkillHubInfo): Promise<SkillHubEntry[]> {
  if (hub.url.toLowerCase().endsWith('.json')) {
    return fetchJsonHubEntries(hub)
  }
  return fetchGithubRepoEntries(hub, parseHubUrl(hub.url))
}

async function fetchJsonHubEntries(hub: SkillHubInfo): Promise<SkillHubEntry[]> {
  const raw = await fetchText(hub.url)
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new ContractError('SKILL_HUB_UNAVAILABLE', `Hub index is not valid JSON: ${hub.url}`)
  }
  const skills = (doc as { skills?: unknown }).skills
  if (!Array.isArray(skills)) {
    throw new ContractError('SKILL_HUB_UNAVAILABLE', `Hub index has no "skills" array: ${hub.url}`)
  }
  const out: SkillHubEntry[] = []
  for (const item of skills.slice(0, MAX_ENTRIES_PER_HUB)) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { name?: unknown; description?: unknown; source?: unknown }
    if (typeof record.name !== 'string' || typeof record.source !== 'string') continue
    parseSkillSource(record.source) // validate early so install never surprises
    out.push({
      hub: hub.id,
      name: record.name,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      source: record.source,
      installed: false
    })
  }
  return out
}

/**
 * GitHub repo hub: ONE codeload zipball per browse, then scan locally.
 *
 * Deliberately avoids api.github.com — its anonymous quota is 60 req/h, which a
 * couple of browses exhaust (everything 403s for the rest of the hour).
 * codeload.github.com serves the same archive unauthenticated and unmetered.
 */
async function fetchGithubRepoEntries(
  hub: SkillHubInfo,
  parsed: ParsedGithubSource
): Promise<SkillHubEntry[]> {
  const prefix =
    parsed.path !== undefined && parsed.path.length > 0
      ? `${parsed.path.replace(/\/+$/u, '')}/`
      : ''
  const { root, release } = await acquireRepoZipball(parsed)
  try {
    const dirs = (await collectSkillDirs(root, prefix)).slice(0, MAX_ENTRIES_PER_HUB)
    const out: SkillHubEntry[] = []
    for (const dir of dirs) {
      const meta = parseFrontmatterFields(await readFileOptional(join(root, dir, 'SKILL.md')))
      const fullPath = `${prefix}${dir}`
      const name = meta.name ?? dir.split('/').pop() ?? dir
      pushUnique(out, {
        hub: hub.id,
        name,
        ...(meta.description !== undefined ? { description: meta.description } : {}),
        source: sourceToString({ ...parsed, path: fullPath }),
        installed: false,
        ...(dir !== name ? { label: dir } : {})
      })
    }
    return out
  } finally {
    release()
  }
}

async function readFileOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** Every directory containing a SKILL.md, relative to root, under `prefix`. */
async function collectSkillDirs(root: string, prefix: string): Promise<string[]> {
  const out: string[] = []
  const start = prefix.length > 0 ? join(root, prefix) : root
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_ENTRIES_PER_HUB) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      const rel = relative(start, dir)
      if (rel.length > 0) out.push(rel.split(sep).join('/'))
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules') continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(start, 0)
  return out
}

interface CachedRepo {
  root: string
  cleanup: () => Promise<void>
  expiresAt: number
  refs: number
  /** Ref spec the download actually resolved (`refs/heads/main`, …). */
  resolvedRef: string
}

const REPO_CACHE_TTL_MS = 15 * 60 * 1000
const repoCache = new Map<string, CachedRepo>()

/**
 * Whole-repo zipball, reused across browse → install.
 *
 * Downloading `anthropics/skills` takes tens of seconds, and installing right
 * after browsing should not pay for it twice. Entries are refcounted and cleaned
 * up once idle (any one checkout costs tens of MB, so nothing lives forever).
 */
async function acquireRepoZipball(
  parsed: ParsedGithubSource
): Promise<{ root: string; resolvedRef: string; release: () => void }> {
  const key = `${parsed.owner}/${parsed.repo}@${parsed.ref ?? 'default'}`
  const cached = repoCache.get(key)
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    cached.refs += 1
    return {
      root: cached.root,
      resolvedRef: cached.resolvedRef,
      release: () => {
        cached.refs -= 1
        if (cached.refs <= 0) evictRepo(key)
      }
    }
  }
  const resolved = await resolveRepoZipball(parsed)
  const entry: CachedRepo = {
    root: resolved.path,
    cleanup: resolved.cleanup,
    expiresAt: Date.now() + REPO_CACHE_TTL_MS,
    refs: 1,
    resolvedRef: resolved.resolvedRef
  }
  repoCache.set(key, entry)
  return {
    root: entry.root,
    resolvedRef: entry.resolvedRef,
    release: () => {
      entry.refs -= 1
      if (entry.refs <= 0) evictRepo(key)
    }
  }
}

function evictRepo(key: string): void {
  const entry = repoCache.get(key)
  if (entry === undefined || entry.refs > 0) return
  repoCache.delete(key)
  void cleanupPluginSourceBestEffort(entry.cleanup)
}

/**
 * One-out-of-three stays-soft retry for transport failures.
 *
 * Downloads here fail intermittently even when the network looks healthy —
 * undici's connect attempts get reset/timeout (10 s default) while curl to the
 * same URL succeeds. Only network-level failures are retried; HTTP status
 * errors (404/403 rate limiting) propagate so the caller's own semantics hold.
 */
async function retryTransient<T>(label: string, run: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      const status = error instanceof PluginZipDownloadError ? error.status : undefined
      const http = typeof status === 'number'
      if (http) throw error
      if (attempt === MAX_ATTEMPTS) break
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)))
      console.warn(`[skillHub] ${label}: attempt ${attempt} failed, retrying`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed: ${String(lastError)}`)
}

/**
 * codeload zipball for a repo, trying plausible ref locations. `refs/heads/HEAD`
 * does not exist there, hence main → master, and heads → tags → bare sha for an
 * explicit ref.
 */
interface ResolvedGithubZipball extends ResolvedZipPluginSourceRoot {
  /** Which codeload candidate URL won (`refs/heads/main`, `refs/tags/v2`, …). */
  resolvedRef: string
}

async function resolveRepoZipball(
  parsed: ParsedGithubSource
): Promise<ResolvedGithubZipball> {
  const ref = parsed.ref
  if (ref !== undefined && !GITHUB_SEGMENT.test(ref)) {
    throw new ContractError('SKILL_SOURCE_INVALID', `Invalid git ref in skill source: ${ref}`)
  }
  const candidates =
    ref === undefined
      ? ['refs/heads/main', 'refs/heads/master']
      : [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]
  let lastError: unknown = null
  for (const suffix of candidates) {
    const url = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/zip/${suffix}`
    try {
      const resolved = await retryTransient(`codeload ${suffix}`, () =>
        resolveHttpZipSource({
          headers: { 'User-Agent': UA },
          requireSingleRoot: true,
          stripRoot: true,
          url
        })
      )
      return { ...resolved, resolvedRef: suffix }
    } catch (error) {
      if (error instanceof PluginZipDownloadError && (error.status === 403 || error.status === 404)) {
        lastError = error
        continue
      }
      throw error
    }
  }
  throw new ContractError(
    'SKILL_HUB_UNAVAILABLE',
    `Cannot download ${parsed.owner}/${parsed.repo}${ref !== undefined ? `@${ref}` : ''}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  )
}

function pushUnique(out: SkillHubEntry[], entry: SkillHubEntry): void {
  if (!out.some((existing) => existing.name === entry.name)) out.push(entry)
}

/** Path join that refuses to escape `root`. */
function resolveInsideLocal(root: string, rawPath: string): string | null {
  if (rawPath.includes('..')) return null
  const joined = resolve(root, rawPath)
  const rel = relative(root, joined)
  if (rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))) return joined
  return null
}

function parseFrontmatterFields(raw: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw)
  if (match === null) return {}
  const lines = (match[1] ?? '').split(/\r?\n/u)
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/u.exec(lines[i] ?? '')
    if (kv === null) continue
    const key = kv[1] ?? ''
    if (key !== 'name' && key !== 'description') continue
    if (out[key as 'name' | 'description'] !== undefined) continue
    let value = (kv[2] ?? '').trim()
    if (/^[>|][+-]?\d*$/u.test(value)) {
      // YAML block scalar (`>` folded / `|` literal): collect the indented body.
      const parts: string[] = []
      i++
      while (i < lines.length) {
        const line = lines[i] ?? ''
        if (line.trim().length > 0 && !/^\s/u.test(line)) break
        parts.push(line.trim())
        i++
      }
      value = parts.filter(Boolean).join(' ')
    } else {
      value = value.replace(/^['"]|['"]$/gu, '')
    }
    if (value.length > 0) out[key] = value
  }
  return out
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const MAX_ATTEMPTS = 3
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { headers, signal: controller.signal })
      if (!response.ok) {
        if (response.status === 404) {
          throw new ContractError('SKILL_SOURCE_INVALID', `Not found (404): ${url}`)
        }
        throw new ContractError(
          'SKILL_HUB_UNAVAILABLE',
          `HTTP ${response.status} fetching ${url}${
            response.status === 403 ? ' (GitHub rate limit?)' : ''
          }`
        )
      }
      return await response.text()
    } catch (error) {
      lastError = error
      if (error instanceof ContractError) throw error
      if (attempt === MAX_ATTEMPTS) break
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)))
      console.warn(`[skillHub] fetch ${url}: attempt ${attempt} failed, retrying`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new ContractError(
    'SKILL_HUB_UNAVAILABLE',
    `Failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

// ─── Install / uninstall ──────────────────────────────────────────────────────

export async function installSkill(
  source: InstallSkillSource,
  overwrite = false
): Promise<SkillSummary> {
  let root: string | null = null
  let cleanup: (() => Promise<void>) | null = null
  let cleanupRef: (() => void) | null = null
  let provenance: SkillProvenance | undefined
  try {
    if (source.kind === 'folder') {
      const folder = resolve(source.folderPath)
      if (!existsSync(join(folder, 'SKILL.md'))) {
        throw new ContractError(
          'SKILL_SOURCE_INVALID',
          `Not a skill folder (no SKILL.md): ${folder}`
        )
      }
      root = folder
      provenance = { kind: 'folder', folderPath: folder, installedAt: Date.now() }
    } else {
      let rawSource: string
      if (source.kind === 'hub') {
        const entries = await browseSkillHub(source.hub)
        const entry = entries.find((candidate) => candidate.name === source.name)
        if (entry === undefined) {
          throw new ContractError(
            'SKILL_SOURCE_INVALID',
            `Skill "${source.name}" not found in hub "${source.hub}"`
          )
        }
        rawSource = entry.source
        provenance = {
          kind: 'hub',
          hub: source.hub,
          hubEntry: source.name,
          source: entry.source,
          installedAt: Date.now()
        }
      } else {
        rawSource = source.source
        provenance = { kind: 'source', source: rawSource, installedAt: Date.now() }
      }
      const parsed = parseSkillSource(rawSource)
      let resolved: ResolvedZipPluginSourceRoot
      if (parsed.kind === 'github') {
        // Whole-repo codeload zipball (unmetered, reused from a recent browse),
        // then the skill subdir inside it.
        const { root: repoRoot, resolvedRef, release } = await acquireRepoZipball(parsed)
        cleanupRef = release
        let selected = repoRoot
        if (parsed.path !== undefined && parsed.path.length > 0) {
          const subdir = resolveInsideLocal(repoRoot, parsed.path)
          if (subdir === null || !existsSync(subdir)) {
            throw new ContractError(
              'SKILL_SOURCE_INVALID',
              `Skill path does not exist in ${parsed.owner}/${parsed.repo}: ${parsed.path}`
            )
          }
          selected = subdir
        }
        resolved = { cleanup: async () => {}, path: selected }
        provenance = {
          ...provenance,
          ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}),
          resolvedRef
        }
      } else {
        resolved = await retryTransient(`zip source ${parsed.url}`, () =>
          resolveHttpZipSource({ url: parsed.url })
        )
      }
      root = resolved.path
      cleanup = resolved.cleanup
      if (!existsSync(join(root, 'SKILL.md'))) {
        throw new ContractError(
          'SKILL_SOURCE_INVALID',
          'Source archive does not contain a SKILL.md at its root (multi-skill repositories need a path to one skill)'
        )
      }
    }

    const meta = readSkillMeta(root)
    const name = meta.name !== undefined && SKILL_NAME_PATTERN.test(meta.name)
      ? meta.name
      : basename(root).replace(/[^a-zA-Z0-9._-]/gu, '-')
    if (name.length === 0 || name === '.' || name === '..') {
      throw new ContractError('SKILL_SOURCE_INVALID', 'Cannot derive a skill name from the source')
    }

    await mkdir(SKILLS_HOME, { recursive: true })
    await sweepStaleStaging()
    const target = join(SKILLS_HOME, name)
    const targetExists = existsSync(target)
    if (targetExists && !overwrite) {
      throw new ContractError(
        'SKILL_ALREADY_INSTALLED',
        `Skill "${name}" is already installed (uninstall it first or set overwrite)`
      )
    }

    // Stage a same-volume copy first, then swap, so a failed download never
    // leaves a half-installed skill (or a wiped old one).
    const staged = join(SKILLS_HOME, `.${name}.staging-${Date.now()}`)
    await cp(root, staged, {
      recursive: true,
      filter: (src) => {
        const base = basename(src)
        // Never carry someone else's provenance sidecar across installs.
        return (
          base !== '.git' &&
          base !== 'node_modules' &&
          base !== '.DS_Store' &&
          base !== PROVENANCE_FILE
        )
      }
    })
    // Sidecars are excluded by the copy filter, so a reinstall cannot inherit the
    // previous install's origin — this record is always written fresh below.
    if (targetExists) {
      const previous = readProvenance(target)
      if (previous !== undefined) {
        provenance = { ...provenance, installedAt: previous.installedAt, updatedAt: Date.now() }
      }
      await rm(target, { recursive: true, force: true })
    }
    try {
      await rename(staged, target)
    } catch (error) {
      await rm(staged, { recursive: true, force: true })
      throw error
    }
    const finalMeta = readSkillMeta(target)
    if (provenance !== undefined) {
      provenance.contentHash = await computeTreeHash(target)
      // Audit metadata is not worth failing an install over.
      await writeProvenance(target, provenance).catch(() => undefined)
    }
    return {
      name,
      ...(finalMeta.description !== undefined ? { description: finalMeta.description } : {}),
      source: 'user',
      path: target,
      ...(provenance !== undefined ? { provenance } : {})
    }
  } finally {
    // The copied target lives on its own; releasing here only drops the shared
    // checkout whose expense we already paid.
    if (cleanupRef !== null) cleanupRef()
    if (cleanup !== null) {
      const cleanupError = await cleanupPluginSourceBestEffort(cleanup)
      if (cleanupError !== null && root === null) {
        throw cleanupError
      }
    }
  }
}

/**
 * Re-install from the recorded source — the payoff of keeping provenance.
 *
 * Unpinned GitHub sources follow whatever the default branch is today, so this
 * doubles as "check for updates": the content hash changes only if upstream (or
 * the local copy) actually differs.
 */
export async function reinstallSkill(name: string): Promise<SkillSummary> {
  const dir = resolve(SKILLS_HOME, name)
  if (!dir.startsWith(resolve(SKILLS_HOME))) {
    throw new ContractError('INVALID_INPUT', `Skill name escapes the skills home: ${name}`)
  }
  const record = readProvenance(dir)
  if (record !== undefined && isReinstallable(record)) {
    if (record.kind === 'folder' && record.folderPath !== undefined) {
      if (!existsSync(join(record.folderPath, 'SKILL.md'))) {
        throw new ContractError(
          'SKILL_SOURCE_INVALID',
          `Original folder no longer contains a skill: ${record.folderPath}`
        )
      }
      return installSkill({ kind: 'folder', folderPath: record.folderPath }, true)
    }
    if (record.source !== undefined && record.kind !== 'agent') {
      const parsed = parseSkillSource(record.source)
      if (parsed.kind === 'zip') {
        return installSkill({ kind: 'source', source: record.source }, true)
      }
      // GitHub: honour `@ref` only when it was pinned (and we recorded it), so
      // an unpinned install intentionally stays on the default branch.
      const source =
        parsed.ref !== undefined || record.ref !== undefined
          ? `github:${parsed.owner}/${parsed.repo}${
              record.ref !== undefined ? `@${record.ref}` : ''
            }${parsed.path !== undefined ? `/${parsed.path}` : ''}`
          : sourceToString(parsed)
      return installSkill({ kind: 'source', source }, true)
    }
  }
  throw new ContractError(
    'SKILL_SOURCE_INVALID',
    `Skill "${name}" has no recorded install source — it was written locally, so there is nothing to reinstall from`
  )
}

/**
 * Remove `.<name>.staging-<ms>` leftovers from crashed installs. Listed skills
 * skip hidden dirs, so nothing here is user-visible — but they do hold disk.
 */
async function sweepStaleStaging(): Promise<void> {
  const STAGING_TTL_MS = 60 * 60 * 1000
  let entries
  try {
    entries = await readdir(SKILLS_HOME, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.')) continue
    const match = /^\..+\.staging-(\d+)$/u.exec(entry.name)
    if (match === null) continue
    const created = Number(match[1] ?? '0')
    if (!Number.isFinite(created) || created === 0) continue
    if (Date.now() - created < STAGING_TTL_MS) continue
    await rm(join(SKILLS_HOME, entry.name), { recursive: true, force: true }).catch(
      () => undefined
    )
  }
}

export function uninstallSkill(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new ContractError('INVALID_INPUT', `Invalid skill name: ${name}`)
  }
  const target = resolve(SKILLS_HOME, name)
  if (!target.startsWith(resolve(SKILLS_HOME))) {
    throw new ContractError('INVALID_INPUT', `Skill name escapes the skills home: ${name}`)
  }
  if (!existsSync(join(target, 'SKILL.md'))) {
    throw new ContractError('SKILL_NOT_FOUND', `No user skill named "${name}" in ${SKILLS_HOME}`)
  }
  try {
    // App-managed directory under the skills home — rm is the point here.
    rmSync(target, { recursive: true, force: true })
  } catch (error) {
    throw new ContractError(
      'KERNEL_INTERNAL',
      `Failed to remove skill "${name}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
