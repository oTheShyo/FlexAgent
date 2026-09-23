import { useSyncExternalStore } from 'react'
import type { SessionSummary } from '../types'

/**
 * Display-only session metadata overlay (rename / archive) under
 * `codex.sessionMeta.v1` (backend-handoff §7.1#4).
 *
 * Merge rule: overlay.title (explicit user rename) wins; when undefined,
 * SessionSummary.title from listSessions is the source of truth.
 * Never mutates sessionId; never calls API methods.
 */
export interface SessionMetaEntry {
  title?: string
  archived?: boolean
  renamedAt?: number
}

export type SessionMetaMap = Record<string, SessionMetaEntry>

const STORAGE_KEY = 'codex.sessionMeta.v1'
const EMPTY_META: SessionMetaMap = Object.freeze({})

let cache: SessionMetaMap | null = null
const listeners = new Set<() => void>()

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function parseStored(raw: string | null): SessionMetaMap {
  if (!raw) return EMPTY_META
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SessionMetaMap
    }
  } catch {
  }
  return EMPTY_META
}

export function readSessionMeta(): SessionMetaMap {
  if (cache !== null) return cache
  if (!hasStorage()) return EMPTY_META
  cache = parseStored(window.localStorage.getItem(STORAGE_KEY))
  return cache
}

function writeSessionMeta(next: SessionMetaMap): void {
  cache = next
  if (hasStorage()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
    }
  }
  listeners.forEach((listener) => listener())
}

export function subscribeSessionMeta(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setSessionMetaTitle(sessionId: string, title: string): void {
  const current = readSessionMeta()
  const previous = current[sessionId] ?? {}
  writeSessionMeta({
    ...current,
    [sessionId]: { ...previous, title, renamedAt: Date.now() }
  })
}

export function setSessionMetaArchived(sessionId: string, archived: boolean): void {
  const current = readSessionMeta()
  const previous = current[sessionId] ?? {}
  writeSessionMeta({ ...current, [sessionId]: { ...previous, archived } })
}

export function displaySessionTitle(
  session: Pick<SessionSummary, 'id' | 'title'>,
  meta: SessionMetaMap = readSessionMeta()
): string {
  return meta[session.id]?.title ?? session.title
}

export function isSessionArchived(
  sessionId: string,
  meta: SessionMetaMap = readSessionMeta()
): boolean {
  return meta[sessionId]?.archived === true
}

export function useSessionMeta(): SessionMetaMap {
  return useSyncExternalStore(
    subscribeSessionMeta,
    readSessionMeta,
    () => EMPTY_META
  )
}
