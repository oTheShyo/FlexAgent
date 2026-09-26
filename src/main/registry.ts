import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { RunState, SessionId, SessionSummary } from '../shared/contract'
import { ContractError } from '../shared/contract'
import { isScratchCwd } from './workspace'

export interface RegistryRecord {
  id: SessionId
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  runState: RunState
  piSessionFile?: string
  /** Persisted in the registry, not in the renderer: a rename is data. */
  archived?: boolean
  /** When the title last stopped being the cwd-derived default. */
  renamedAt?: number
  /** Session this one forked from (ticket 17); absent = not a fork. */
  derivedFrom?: string
}

interface PersistShape {
  version: 1
  sessions: RegistryRecord[]
}

const MAX_TITLE = 80

function registryPath(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

/** A scratch session has no project to name it after. */
const SCRATCH_TITLE = 'New chat'

function defaultTitle(cwd: string, title?: string): string {
  const trimmed = title?.trim()
  if (trimmed) return trimmed.slice(0, MAX_TITLE)
  if (isScratchCwd(cwd)) return SCRATCH_TITLE
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  const base = parts[parts.length - 1] || cwd
  return base.slice(0, MAX_TITLE) || 'Session'
}

function backupPath(file: string): string {
  let candidate = `${file}.corrupt`
  let n = 1
  while (existsSync(candidate)) {
    candidate = `${file}.corrupt.${n++}`
  }
  return candidate
}

function preserveCorrupt(file: string, reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason)
  try {
    const backup = backupPath(file)
    renameSync(file, backup)
    console.error(
      `[registry] sessions.json unreadable (${message}); preserved original bytes at ${backup}`
    )
  } catch (err) {
    const backupError = err instanceof Error ? err.message : String(err)
    console.warn(
      `[registry] sessions.json unreadable (${message}); original file could NOT be backed up (${backupError}) — it may be overwritten by the next persist()`
    )
  }
}

export class SessionRegistry {
  private records = new Map<SessionId, RegistryRecord>()

  load(): void {
    const file = registryPath()
    if (!existsSync(file)) return
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      this.records.clear()
      preserveCorrupt(file, err)
      return
    }
    let parsed: PersistShape
    try {
      parsed = JSON.parse(raw) as PersistShape
    } catch (err) {
      this.records.clear()
      preserveCorrupt(file, err)
      return
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
      this.records.clear()
      preserveCorrupt(file, new Error('unexpected sessions registry shape'))
      return
    }
    let skipped = 0
    for (const rec of parsed.sessions) {
      if (rec && typeof rec.id === 'string' && typeof rec.cwd === 'string') {
        this.records.set(rec.id, {
          ...rec,
          runState: 'idle',
          // Registries written before rename/archive existed simply lack the
          // fields; reading them as "not archived, default title" is the only
          // interpretation that does not invent history.
          archived: rec.archived === true,
          title: typeof rec.title === 'string' && rec.title.trim() ? rec.title : defaultTitle(rec.cwd),
          updatedAt: Number(rec.updatedAt) || Number(rec.createdAt) || Date.now(),
          createdAt: Number(rec.createdAt) || Date.now()
        })
      } else {
        skipped++
      }
    }
    if (skipped > 0) {
      preserveCorrupt(file, new Error(`${skipped} malformed record(s) skipped, good records kept`))
    }
  }

  private persist(): void {
    const file = registryPath()
    mkdirSync(join(file, '..'), { recursive: true })
    const payload: PersistShape = {
      version: 1,
      sessions: [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    }
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  }

  list(): SessionSummary[] {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(toSummary)
  }

  get(id: SessionId): RegistryRecord | undefined {
    return this.records.get(id)
  }

  require(id: SessionId): RegistryRecord {
    const rec = this.records.get(id)
    if (!rec) throw new ContractError('SESSION_NOT_FOUND', `Unknown session: ${id}`)
    return rec
  }

  summary(id: SessionId): SessionSummary {
    return toSummary(this.require(id))
  }

  create(id: SessionId, cwd: string, title?: string): RegistryRecord {
    if (!cwd || !cwd.trim()) {
      throw new ContractError('INVALID_INPUT', 'cwd must be a non-empty absolute path')
    }
    const now = Date.now()
    const rec: RegistryRecord = {
      id,
      title: defaultTitle(cwd, title),
      cwd,
      createdAt: now,
      updatedAt: now,
      runState: 'idle'
    }
    this.records.set(id, rec)
    this.persist()
    return rec
  }

  /** Re-point a session at another workspace; the transcript is untouched. */
  setCwd(id: SessionId, cwd: string): RegistryRecord {
    if (!cwd || !cwd.trim()) {
      throw new ContractError('INVALID_INPUT', 'cwd must be a non-empty absolute path')
    }
    const rec = this.require(id)
    if (rec.cwd === cwd) return rec
    // A scratch session is still called "New chat"; once it has a project the
    // old default no longer describes it. A user-set title is left alone.
    const stillDefault = rec.title === defaultTitle(rec.cwd)
    rec.cwd = cwd
    if (stillDefault) rec.title = defaultTitle(cwd)
    rec.updatedAt = Date.now()
    this.persist()
    return rec
  }

  /**
   * User-set title. Persisted in the registry so a second window — or the same
   * window after a restart — shows the same name; a renderer-only overlay
   * could not, which is what this replaces.
   */
  setTitle(id: SessionId, title: string): RegistryRecord {
    const trimmed = title.trim()
    if (!trimmed) {
      throw new ContractError('INVALID_INPUT', 'title must be a non-empty string')
    }
    const rec = this.require(id)
    rec.title = trimmed.slice(0, MAX_TITLE)
    rec.renamedAt = Date.now()
    rec.updatedAt = Date.now()
    this.persist()
    return rec
  }

  /** Archive or restore. The record and its transcript are kept either way. */
  setArchived(id: SessionId, archived: boolean): RegistryRecord {
    const rec = this.require(id)
    if (rec.archived === archived) return rec
    rec.archived = archived
    rec.updatedAt = Date.now()
    this.persist()
    return rec
  }

  attachPiSession(id: SessionId, piSessionFile: string): void {
    const rec = this.require(id)
    rec.piSessionFile = piSessionFile
    rec.updatedAt = Date.now()
    this.persist()
  }

  /**
   * Register a fork (ticket 17): same workspace as the source, a derived
   * title, and the lineage marker. The transcript prefix itself is the
   * forked session's history; nothing else is copied.
   */
  fork(id: SessionId, sourceId: SessionId, title: string): RegistryRecord {
    const source = this.require(sourceId)
    const now = Date.now()
    const rec: RegistryRecord = {
      id,
      title: title.slice(0, MAX_TITLE),
      cwd: source.cwd,
      createdAt: now,
      updatedAt: now,
      runState: 'idle',
      derivedFrom: sourceId
    }
    this.records.set(id, rec)
    this.persist()
    return rec
  }

  /** Rollback a create() that failed before the worker attached a PI session. */
  remove(id: SessionId): void {
    if (this.records.delete(id)) this.persist()
  }

  setRunState(id: SessionId, runState: RunState): void {
    const rec = this.records.get(id)
    if (!rec || rec.runState === runState) return
    rec.runState = runState
    rec.updatedAt = Date.now()
    this.persist()
  }

  touch(id: SessionId): void {
    const rec = this.records.get(id)
    if (!rec) return
    rec.updatedAt = Date.now()
    this.persist()
  }
}

function toSummary(rec: RegistryRecord): SessionSummary {
  return {
    id: rec.id,
    title: rec.title,
    cwd: rec.cwd,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    runState: rec.runState,
    archived: rec.archived === true,
    ...(rec.derivedFrom !== undefined ? { derivedFrom: rec.derivedFrom } : {})
  }
}
