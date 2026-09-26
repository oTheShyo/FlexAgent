/**
 * Offline usage aggregation (issue 09).
 *
 * Everything here is derived from the NDJSON that observability.ts already
 * writes — no new reporting channel, no new runtime path, nothing to keep in
 * sync. That is the point: a metrics system is a second source of truth that
 * drifts from the first one, whereas re-reading the event log cannot disagree
 * with it.
 *
 * The aggregation is deliberately separated from the file reading so it can be
 * tested by feeding it lines: the interesting logic is "what does one row
 * contribute", and that needs no disk and no Electron.
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { GlobalUsageBucket, GlobalUsageStats } from '../shared/contract'
import type { CallSource } from './observability'

function bucket(key: string): GlobalUsageBucket {
  return { key, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0, failed: 0 }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Parse NDJSON, keeping the lines that parse. A truncated last line is expected
 * (append-only writes lose at most one line on a crash) and must not take the
 * whole report down with it: one bad line is skipped, not fatal.
 */
export function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>)
      }
    } catch {
      // Skipped — see above.
    }
  }
  return out
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function add(row: Record<string, unknown>, into: GlobalUsageBucket): void {
  const tokens = row.tokens as Record<string, unknown> | undefined
  const input = num(tokens?.input)
  const output = num(tokens?.output)
  const cacheRead = num(tokens?.cacheRead)
  const cacheWrite = num(tokens?.cacheWrite)
  into.calls += 1
  into.input += input
  into.output += output
  into.cacheRead += cacheRead
  into.cacheWrite += cacheWrite
  into.total += input + output + cacheRead + cacheWrite
  if (row.ok === false) into.failed += 1
  into.cost += num(row.cost)
}

function bySpend(values: GlobalUsageBucket[]): GlobalUsageBucket[] {
  return values
    .filter((item) => item.calls > 0)
    .sort((a, b) => b.total - a.total || b.calls - a.calls)
}

export interface LlmCallAggregate {
  totals: GlobalUsageBucket
  byModel: GlobalUsageBucket[]
  byCallSource: GlobalUsageBucket[]
  byDay: GlobalUsageBucket[]
  sessions: Set<string>
  firstTs?: number
  lastTs?: number
}

/** Aggregate LLM-call rows. Pure: takes parsed rows, returns buckets. */
export function aggregateLlmCalls(
  rows: readonly Record<string, unknown>[]
): LlmCallAggregate {
  const totals = bucket('all')
  const models = new Map<string, GlobalUsageBucket>()
  const sources = new Map<string, GlobalUsageBucket>()
  const days = new Map<string, GlobalUsageBucket>()
  const sessions = new Set<string>()
  let firstTs: number | undefined
  let lastTs: number | undefined

  for (const row of rows) {
    // The llm-calls file holds one kind today; pipeline rows (skill_hub, ...)
    // are not LLM calls and must not inflate the token bill.
    if (row.kind !== undefined && row.kind !== 'llm_call') continue
    const ts = num(row.ts)
    if (ts > 0) {
      if (firstTs === undefined || ts < firstTs) firstTs = ts
      if (lastTs === undefined || ts > lastTs) lastTs = ts
    }
    const modelKey = typeof row.model === 'string' && row.model ? row.model : 'unknown'
    const sourceKey =
      typeof row.callSource === 'string' && row.callSource
        ? (row.callSource as CallSource)
        : 'unknown'
    const day = ts > 0 ? dayKey(ts) : 'unknown'

    for (const [map, key] of [
      [models, modelKey],
      [sources, sourceKey],
      [days, day]
    ] as const) {
      const existing = map.get(key)
      const target = existing ?? bucket(key)
      add(row, target)
      if (existing === undefined) map.set(key, target)
    }
    add(row, totals)
    if (typeof row.sessionId === 'string' && row.sessionId) sessions.add(row.sessionId)
  }

  return {
    totals,
    byModel: bySpend([...models.values()]),
    byCallSource: bySpend([...sources.values()]),
    byDay: [...days.values()].sort((a, b) => a.key.localeCompare(b.key)),
    sessions,
    ...(firstTs !== undefined ? { firstTs } : {}),
    ...(lastTs !== undefined ? { lastTs } : {})
  }
}

/** Count tool executions from kernel event rows. */
export function aggregateToolCalls(rows: readonly Record<string, unknown>[]): {
  total: number
  byTool: { name: string; count: number }[]
} {
  const byName = new Map<string, number>()
  let total = 0
  for (const row of rows) {
    // tool_start, not tool_end: a tool that hung and never ended still consumed
    // the turn, and end events can be missing when a run was aborted.
    if (row.type !== 'tool_start') continue
    const name = typeof row.name === 'string' && row.name ? row.name : 'unknown'
    byName.set(name, (byName.get(name) ?? 0) + 1)
    total += 1
  }
  return {
    total,
    byTool: [...byName.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }
}

export interface UsageStatsInput {
  /** Raw content of observability/llm-calls.jsonl (may be empty). */
  llmCallsText: string
  /** Raw content of every session's events.jsonl. */
  eventsText: string[]
}

/** Pure aggregation over file contents — the unit-testable core. */
export function buildUsageStats(input: UsageStatsInput): GlobalUsageStats {
  const calls = aggregateLlmCalls(parseJsonl(input.llmCallsText))
  const events = input.eventsText.flatMap((text) => parseJsonl(text))
  const tools = aggregateToolCalls(events)
  return {
    generatedAt: Date.now(),
    hasData: calls.totals.calls > 0 || tools.total > 0,
    totals: calls.totals,
    byModel: calls.byModel,
    byCallSource: calls.byCallSource,
    byDay: calls.byDay,
    toolCalls: tools.total,
    toolCallsByTool: tools.byTool,
    sessions: calls.sessions.size,
    ...(calls.firstTs !== undefined ? { firstTs: calls.firstTs } : {}),
    ...(calls.lastTs !== undefined ? { lastTs: calls.lastTs } : {})
  }
}

/**
 * Read the real files. Every read is best-effort: a missing observability dir
 * means "nothing recorded yet", not an error, and the UI has an empty state for
 * exactly that.
 */
export function collectUsageStats(): GlobalUsageStats {
  const root = process.env.FLEXAGENT_OBS_HOME ?? join(homedir(), '.flexagent')
  const llmCallsFile = join(root, 'observability', 'llm-calls.jsonl')
  const sessionsDir = join(root, 'sessions')
  let llmCallsText = ''
  try {
    if (existsSync(llmCallsFile)) llmCallsText = readFileSync(llmCallsFile, 'utf8')
  } catch {
    llmCallsText = ''
  }
  const eventsText: string[] = []
  try {
    if (existsSync(sessionsDir)) {
      for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const file = join(sessionsDir, entry.name, 'events.jsonl')
        try {
          if (existsSync(file)) eventsText.push(readFileSync(file, 'utf8'))
        } catch {
          // One unreadable session must not hide the rest.
        }
      }
    }
  } catch {
    // No sessions dir yet.
  }
  return buildUsageStats({ llmCallsText, eventsText })
}
