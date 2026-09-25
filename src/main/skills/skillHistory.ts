import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'

/**
 * Persistent version history and undo log for agent-written skills.
 *
 * `skillManage` can roll back a batch it is still inside — it holds the previous
 * contents in memory. That is not enough: the moment the process exits, or the
 * user approves a staged write from a later session, the only copy of "what
 * this file said before" is gone. A skill that the agent rewrote at 2am and
 * that turns out to be wrong is then unfixable, and *that* is what stops a user
 * from ever approving the next one.
 *
 * So every mutation records the content it replaced, and the record outlives the
 * process. Two caps keep it from becoming its own disk-hog:
 *
 * - Per-path depth — an edit loop must not grow one file's history forever.
 * - Total bytes — history is a safety net, not an archive; the newest is what
 *   matters, the oldest is what gets dropped.
 */

export const UNDO_HOME = join(homedir(), '.flexagent', 'undo')
export const UNDO_LOG = join(UNDO_HOME, 'skill-writes.jsonl')

/** Versions kept per file path. Five covers "undo a day of edits". */
const VERSIONS_PER_PATH = 5
/** History is a safety net, not an archive — 4MB is far more than a skills tree. */
const MAX_LOG_BYTES = 4 * 1024 * 1024
/** Newest-first page size for the UI. */
const DEFAULT_LIMIT = 25

export interface UndoChange {
  /** Absolute path of the file as it was changed. */
  path: string
  /** Content before the change; the value a revert restores. */
  previousContent: string | null
}

export interface UndoEntry {
  id: string
  /** Epoch ms of the change. */
  at: number
  /** What the batch did, in user-readable form. */
  summary: string[]
  changes: UndoChange[]
}

/** Write to a sibling temp file and rename over the target: no half-written file. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* nothing to clean up */
    }
    throw err
  }
}

function readLog(): UndoEntry[] {
  if (!existsSync(UNDO_LOG)) return []
  const out: UndoEntry[] = []
  for (const line of readFileSync(UNDO_LOG, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as UndoEntry
      if (typeof parsed?.id === 'string' && Array.isArray(parsed?.changes)) out.push(parsed)
    } catch {
      // A torn last line is exactly what an interrupted write looks like; the
      // entries before it are fine and still worth keeping.
    }
  }
  return out
}

function serialize(entries: UndoEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

/** Drop the oldest entries until every path is within depth and the log within budget. */
function prune(entries: UndoEntry[]): UndoEntry[] {
  const perPath = new Map<string, number>()
  const kept: UndoEntry[] = []
  // Newest first, so counting from the head keeps the recent versions.
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    let count = 0
    for (const change of entry.changes) count += perPath.get(change.path) ?? 0
    if (count >= VERSIONS_PER_PATH) continue
    for (const change of entry.changes) {
      perPath.set(change.path, (perPath.get(change.path) ?? 0) + 1)
    }
    kept.push(entry)
  }

  let bytes = 0
  const budgeted: UndoEntry[] = []
  for (const entry of kept) {
    const size = serialize([entry]).length
    if (bytes + size > MAX_LOG_BYTES) break
    bytes += size
    budgeted.push(entry)
  }
  return budgeted
}

/**
 * Record a completed batch. Called only after the writes landed, so the entry is
 * never a claim about a change that did not happen.
 */
export function recordSkillHistory(summary: string[], changes: UndoChange[]): string | undefined {
  const visible = changes.filter(
    (change) => change.previousContent !== null || existsSync(change.path)
  )
  if (visible.length === 0) return undefined
  const entry: UndoEntry = {
    id: randomUUID(),
    at: Date.now(),
    summary: summary.map((line) => line.replace(/\s+/g, ' ').trim()).slice(0, 20),
    changes: visible.map((change) => ({ path: change.path, previousContent: change.previousContent }))
  }
  writeFileAtomic(UNDO_LOG, serialize(prune([...readLog(), entry])))
  return entry.id
}

/** Newest first. */
export function listSkillHistory(limit = DEFAULT_LIMIT): UndoEntry[] {
  return readLog()
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, limit))
}

export interface UndoResult {
  entryId: string
  /** Paths restored to their previous content. */
  reverted: string[]
  /** Paths that could not be restored — already gone, or unreadable. */
  skipped: string[]
}

/**
 * Restore every file this batch touched to what it held before. Entries are
 * applied in reverse order so later changes unwind before earlier ones.
 */
export function revertSkillHistory(entryId: string): UndoResult {
  const entry = readLog().find((candidate) => candidate.id === entryId)
  if (entry === undefined) {
    throw new Error(`no skill history entry with id ${entryId}`)
  }
  const reverted: string[] = []
  const skipped: string[] = []
  for (const change of [...entry.changes].reverse()) {
    try {
      if (change.previousContent === null) {
        // It did not exist before, so "previous" means absent.
        if (existsSync(change.path)) {
          rmSync(change.path, { force: true })
          reverted.push(change.path)
        }
        continue
      }
      // Deliberately no existence check: a file that was *deleted* by this very
      // batch is missing precisely when undoing matters most. Writing it back
      // over a newer file is also the correct revert — the newer content is what
      // we are replacing.
      writeFileAtomic(change.path, change.previousContent)
      reverted.push(change.path)
    } catch {
      skipped.push(change.path)
    }
  }
  return { entryId, reverted, skipped }
}

export function clearSkillHistory(): void {
  try {
    rmSync(UNDO_LOG, { force: true })
  } catch {
    /* nothing to clear */
  }
}
