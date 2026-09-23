import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { RunState, SessionId, SessionSummary } from '../shared/contract'
import { ContractError } from '../shared/contract'

export interface RegistryRecord {
  id: SessionId
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  runState: RunState
  piSessionFile?: string
}

interface PersistShape {
  version: 1
  sessions: RegistryRecord[]
}

const MAX_TITLE = 80

function registryPath(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

function defaultTitle(cwd: string, title?: string): string {
  const trimmed = title?.trim()
  if (trimmed) return trimmed.slice(0, MAX_TITLE)
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  const base = parts[parts.length - 1] || cwd
  return base.slice(0, MAX_TITLE) || 'Session'
}

export class SessionRegistry {
  private records = new Map<SessionId, RegistryRecord>()

  load(): void {
    const file = registryPath()
    if (!existsSync(file)) return
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw) as PersistShape
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) return
      for (const rec of parsed.sessions) {
        if (rec && typeof rec.id === 'string' && typeof rec.cwd === 'string') {
          this.records.set(rec.id, {
            ...rec,
            runState: 'idle',
            updatedAt: Number(rec.updatedAt) || Number(rec.createdAt) || Date.now(),
            createdAt: Number(rec.createdAt) || Date.now()
          })
        }
      }
    } catch {
      this.records.clear()
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

  attachPiSession(id: SessionId, piSessionFile: string): void {
    const rec = this.require(id)
    rec.piSessionFile = piSessionFile
    rec.updatedAt = Date.now()
    this.persist()
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
    runState: rec.runState
  }
}
