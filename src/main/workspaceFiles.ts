/**
 * Ticket 27 — the file list behind the Composer `@` mention, and the file
 * contents that go with it.
 *
 * The list used to be a hardcoded array of this repo's own paths. It looked
 * finished because the paths were real, but it was still this repo: a user
 * mentioning a file in *their* project got a list of ours, and the model was
 * handed a path with no contents — so "what's wrong with @foo.ts" had nothing
 * to answer from. This is the source that makes the mention mean something.
 *
 * The scan is bounded three ways — depth, total entries visited, and results
 * returned — because it runs on the worker's single thread while the user is
 * typing. Walking a monorepo is fine; walking it on every keystroke is not, so
 * the result is cached per root and reused until it goes stale. A scan that
 * hits a bound returns what it found rather than throwing: a partial list the
 * user can narrow by typing beats an empty popup and an error toast.
 */

import { readdir, readFile, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'

/**
 * Directories that are never worth walking. They are large, generated, or
 * vendor-controlled, and their contents are almost never what a mention means.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
  '.gradle',
  '.idea',
  '.vscode'
])

/** How many directory entries one scan will visit before it gives up. */
const MAX_ENTRIES = 20_000

/** How deep one scan will descend. */
const MAX_DEPTH = 10

/** How many paths one query returns. The popup cannot show more anyway. */
const MAX_RESULTS = 50

/** How long a scan stays cached. Long enough to cover one mention session. */
const CACHE_TTL_MS = 30_000

/** How many roots stay cached at once. Scratch sessions come and go. */
const MAX_CACHED_ROOTS = 4

/** Largest file whose contents will be inlined, in characters. */
const MAX_FILE_CHARS = 20_000

const EMPTY_QUERY_RESULTS = 12

interface Snapshot {
  at: number
  files: string[]
}

const cache = new Map<string, Snapshot>()

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/**
 * Walk `root`, collecting file paths relative to it.
 *
 * Iterative on purpose: a deep tree on a recursive walk is a stack overflow
 * waiting for the wrong repo. Unreadable directories are skipped rather than
 * aborting the scan — one unreadable `node_modules` should not cost the user
 * the rest of the list.
 */
async function scan(root: string): Promise<string[]> {
  const out: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let seen = 0
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number }
    if (depth > MAX_DEPTH) continue
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return out
      if (entry.isSymbolicLink()) continue // never followed: cycles, and escaping the root
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile()) {
        out.push(toPosix(relative(root, full)))
      }
    }
  }
  return out
}

/**
 * Prefix matches first, then substring — the order a user typing a filename
 * expects, and stable within each group so the popup does not reshuffle.
 */
export function rankFiles(
  files: readonly string[],
  rawQuery: string,
  limit = MAX_RESULTS
): string[] {
  const q = rawQuery.trim().toLowerCase()
  if (q.length === 0) return files.slice(0, Math.min(EMPTY_QUERY_RESULTS, limit))
  const prefix: string[] = []
  const substring: string[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    if (lower.startsWith(q)) {
      if (prefix.length < limit) prefix.push(path)
    } else if (substring.length < limit && lower.includes(q)) {
      substring.push(path)
    }
    if (prefix.length >= limit && substring.length >= limit) break
  }
  return [...prefix, ...substring].slice(0, limit)
}

async function filesFor(root: string): Promise<string[]> {
  const cached = cache.get(root)
  const now = Date.now()
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.files
  const files = (await scan(root)).sort()
  // Refresh the timestamp on a hit so a root in continuous use keeps its place.
  cache.delete(root)
  cache.set(root, { at: now, files })
  while (cache.size > MAX_CACHED_ROOTS) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
  return files
}

/** Paths matching `query`, relative to `root`. Never throws for a bad root. */
export async function listWorkspaceFiles(root: string, query: string): Promise<string[]> {
  if (root.length === 0) return []
  try {
    const files = await filesFor(root)
    return rankFiles(files, query)
  } catch {
    // An unreadable root (deleted cwd, revoked permission) is not an error the
    // mention popup can act on; it just has nothing to show.
    return []
  }
}

/**
 * Forget a root's scan. Called when a session's cwd moves, so the popup cannot
 * keep offering files from where the session used to be.
 */
export function invalidateWorkspaceFiles(root?: string): void {
  if (root === undefined) cache.clear()
  else cache.delete(root)
}

export type FileReadOutcome =
  | { ok: true; path: string; content: string; truncated: boolean }
  /** Named rather than dropped: a mention whose file cannot be read must say so. */
  | { ok: false; path: string; reason: string }

/**
 * Resolve a mention's path against `root` and read it.
 *
 * The path arrives from the renderer, so it is resolved and then checked to
 * still be inside `root` — `../../etc/passwd` is a path the user can type into
 * the popup, and nothing about the UI prevents it.
 */
export async function readWorkspaceFile(root: string, path: string): Promise<FileReadOutcome> {
  const rel = path.replace(/^\/+/, '')
  const abs = isAbsolute(rel) ? rel : resolve(root, rel)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    return { ok: false, path, reason: 'outside the working directory' }
  }
  try {
    const info = await stat(abs)
    if (info.isDirectory()) return { ok: false, path, reason: 'is a directory' }
    const buffer = await readFile(abs)
    // Binary files would flood the prompt with replacement characters; a text
    // file that merely contains one NUL is still refused, because guessing
    // wrong costs more than the mention was worth.
    if (buffer.includes(0)) return { ok: false, path, reason: 'is not a text file' }
    const text = buffer.toString('utf8')
    if (text.length <= MAX_FILE_CHARS) return { ok: true, path, content: text, truncated: false }
    return {
      ok: true,
      path,
      content: text.slice(0, MAX_FILE_CHARS),
      truncated: true
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, path, reason: message }
  }
}

/** The cap `readWorkspaceFile` applies, exported so callers can state it. */
export const WORKSPACE_FILE_CHARS = MAX_FILE_CHARS
