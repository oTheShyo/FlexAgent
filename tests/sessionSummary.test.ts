import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { toSessionSummary, type SummaryRecord } from '../src/main/sessionSummary'

const base: SummaryRecord = {
  id: 's-1',
  title: 'New chat',
  cwd: 'C:\\proj',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  runState: 'idle'
}

describe('toSessionSummary', () => {
  it('copies every field the renderer lists a session by', () => {
    expect(toSessionSummary(base)).toEqual({
      id: 's-1',
      title: 'New chat',
      cwd: 'C:\\proj',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      runState: 'idle',
      archived: false
    })
  })

  it('carries the fork lineage marker (ticket 17)', () => {
    const summary = toSessionSummary({ ...base, derivedFrom: 's-0' })
    expect(summary.derivedFrom).toBe('s-0')
  })

  it('omits derivedFrom entirely when there is no lineage', () => {
    expect('derivedFrom' in toSessionSummary(base)).toBe(false)
  })

  it('reports archived as a boolean, never undefined', () => {
    // The sidebar filters on `archived === true`; an absent field and `false`
    // read the same there, but `undefined` escaping into the list is how a
    // dropped field turns into a UI bug somewhere else later.
    expect(toSessionSummary(base).archived).toBe(false)
    expect(toSessionSummary({ ...base, archived: true }).archived).toBe(true)
  })

  it('does not mutate the record it was handed', () => {
    const rec: SummaryRecord = { ...base }
    toSessionSummary(rec)
    expect(rec).toEqual(base)
  })
})

/**
 * Ticket 17 regression: `ipc.openSession` used to hand-build its `summary`, and
 * the fields it forgot (`archived`, `derivedFrom`) are exactly the ones the
 * renderer trusts — `useChat.openSession` swaps its sidebar row for whatever
 * comes back. Opening a forked chat erased its fork badge.
 *
 * `registry.ts` pulls in `electron` for its path, so the summary mapping is not
 * importable in this suite; the guard below is the source-level half. The
 * behavioural half lives in `toSessionSummary` tests above, on the one module
 * both `registry` and `ipc` now go through.
 */
describe('ipc handlers never hand-build a session summary', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc.ts'), 'utf8')

  it('builds no summary literal', () => {
    expect(source).not.toMatch(/summary:\s*\{/)
    expect(source).not.toMatch(/runState:/)
    expect(source).not.toMatch(/derivedFrom:/)
  })

  it('asks the registry for every summary it returns', () => {
    const calls = source.match(/registry\.summary\(/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
  })
})
