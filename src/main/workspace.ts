import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Workspace paths.
 *
 * PI needs an absolute cwd for every session: the session file lands under it
 * and every relative tool path resolves against it. Chats that are just a
 * conversation therefore cannot run with "no cwd", so they run in the scratch
 * workspace — a dedicated empty directory that belongs to no project. Bind a
 * real folder later via `setSessionCwd`; the transcript survives the move.
 */

const SCRATCH_SEGMENTS = ['.flexagent', 'scratch']

let cachedScratch: string | undefined

/** Absolute path of the scratch workspace, created on first use. */
export function scratchCwd(): string {
  if (cachedScratch === undefined) {
    const dir = join(homedir(), ...SCRATCH_SEGMENTS)
    mkdirSync(dir, { recursive: true })
    cachedScratch = dir
  }
  return cachedScratch
}

/**
 * Same-directory test that ignores separator spelling and case, so
 * `C:\a\b` and `C:/a/b` never read as two different workspaces.
 */
export function isScratchCwd(cwd: string): boolean {
  return workspaceKey(cwd) === workspaceKey(scratchCwd())
}

/** Canonical comparison key for a workspace path. */
export function workspaceKey(cwd: string): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '')
  if (trimmed.length === 0) return ''
  const absolute = resolve(trimmed)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
