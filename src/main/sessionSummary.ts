import type { RunState, SessionId, SessionSummary } from '../shared/contract'

/**
 * A persisted session record, reduced to the fields the renderer is promised.
 *
 * Declared structurally (rather than importing `RegistryRecord`) so this module
 * stays free of the `electron` import that `registry.ts` needs for its path —
 * which is what makes the mapping unit-testable.
 */
export interface SummaryRecord {
  id: SessionId
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  runState: RunState
  archived?: boolean
  derivedFrom?: string
}

/**
 * The one place a session record becomes a `SessionSummary` (ticket 17).
 *
 * It is the single source of truth on purpose. Two call sites used to build the
 * object inline and each dropped a different optional field — `archived` and
 * `derivedFrom` — which the renderer takes literally: `useChat.openSession`
 * swaps its sidebar row for whatever `openSession` returns, so opening a forked
 * chat erased its "fork" badge, and an archived chat reappeared in the main
 * list. Anything that needs a summary must go through here.
 */
export function toSessionSummary(rec: SummaryRecord): SessionSummary {
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
