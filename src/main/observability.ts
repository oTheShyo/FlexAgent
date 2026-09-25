/**
 * Observability sink — the persistence half of the observability design
 * (docs/observability.md).
 *
 * Two streams, both NDJSON append-only (a crash drops at most the last line,
 * the same trade skill-writes.jsonl makes):
 *
 *   ~/.flexagent/sessions/<sessionId>/events.jsonl   kernel events, per session
 *   ~/.flexagent/observability/llm-calls.jsonl       worker-side LLM calls
 *
 * The trace spine is deliberately NOT a span model: sessionId + the ordered
 * event sequence already read as a call tree, and `sessionId` doubles as the
 * per-agent instance id that multi-agent correlation needs. Metrics are
 * aggregated offline from these files; there is no separate metrics system.
 *
 * Privacy (§3.1 of the doc): metadata-only by default — args, message content
 * and tool results are stripped unless FLEXAGENT_DEBUG_LLM=1. Same philosophy
 * as the permission chain: conservative by default, explicitly widened.
 *
 * Every write is best-effort and swallows errors: observability must never
 * take a session down with it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { ReasoningEffort, ThinkingLevel } from '../shared/contract'

const OBS_ROOT =
  process.env.FLEXAGENT_OBS_HOME ?? join(homedir(), '.flexagent')

/** Settings live at the real `~/.flexagent` even when OBS_ROOT is redirected for tests. */
const SETTINGS_FILE = join(homedir(), '.flexagent', 'settings.json')

/**
 * Debug mode (docs/observability.md §3.1): full args/content in the event
 * stream. `FLEXAGENT_DEBUG_LLM=1` forces it; otherwise the user's
 * `observability.debugLlm` setting wins, re-read with a short TTL so flipping
 * the flag takes effect without a restart. Conservative default either way.
 */
export function isDebugLlm(): boolean {
  if (process.env.FLEXAGENT_DEBUG_LLM === '1') return true
  const now = Date.now()
  if (debugCache !== null && now - debugCache.at < DEBUG_TTL_MS) return debugCache.value
  let value = false
  try {
    if (existsSync(SETTINGS_FILE)) {
      const parsed: unknown = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
      value =
        (parsed as { observability?: { debugLlm?: unknown } } | null)?.observability
          ?.debugLlm === true
    }
  } catch {
    value = false
  }
  debugCache = { at: now, value }
  return value
}

const DEBUG_TTL_MS = 2000
let debugCache: { at: number; value: boolean } | null = null

const LLM_CALLS_FILE = join(OBS_ROOT, 'observability', 'llm-calls.jsonl')

const PIPELINE_FILE = join(OBS_ROOT, 'observability', 'pipeline.jsonl')

/**
 * Long-running non-LLM pipelines whose failure history is the debugging
 * currency (docs/observability.md §5): Skill Hub downloads (undici retries),
 * install staging/swap, marketplace archives.
 */
export type PipelineKind = 'skill_hub' | 'skill_install' | 'marketplace'

export interface PipelineObservation {
  kind: PipelineKind
  /** Stage label — for transports, the same label retryTransient logs. */
  stage: string
  ok: boolean
  durationMs?: number
  note?: string
}

/**
 * Why an LLM call happened. `chat` (kernel-internal) is reserved — see §4.
 *
 * `role_task` is the one source that is not a single call: a child agent runs
 * its own session and can burn a whole run's budget before the parent hears
 * back, and its `chat` calls never cross the parent's event stream. So the
 * child's ledger is written once, at the end of its run, under this source.
 */
export type CallSource =
  | 'chat'
  | 'compaction'
  | 'permission_classifier'
  | 'memory_dedupe'
  | 'role_task'
  /**
   * The post-turn automatic memory pass (issue 15). Separate from
   * `memory_dedupe` because that one only answers "is this a duplicate",
   * while this is the call that decides *whether there is anything to keep* —
   * the cost the user needs to see when they turn the feature on.
   */
  | 'memory_extract'

export interface LlmCallObservation {
  callSource: CallSource
  /** `provider/id` of the model that served (or was routed for) the call. */
  model?: string
  durationMs: number
  /** false = the call failed or fell back to heuristics / the session model. */
  ok: boolean
  /** Omitted for worker-side calls that have no session in scope. */
  sessionId?: string
  /**
   * Only for `role_task`: the role that ran. Without it, a delegation's cost is
   * a number with nobody's name on it.
   */
  role?: string
  /** Only for `role_task`: the child's whole ledger, not one call's. */
  turns?: number
  toolCalls?: number
  note?: string
  /** Token metering when the source exposes it (PI assistant messages do). */
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
  cost?: number
  /**
   * PI thinking level in effect when the call was made (kernel `chat` calls) —
   * together with `effort` this is the llm-calls.jsonl evidence that a
   * reasoning tier actually reached the request (issue 08).
   */
  thinkingLevel?: ThinkingLevel
  /** Reasoning tier (低/高/最高) behind `thinkingLevel`; `null` = off/unmapped. */
  effort?: ReasoningEffort | null
}

/** Session ids are app-generated, but a directory name is a boundary — sanitize. */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

function appendLine(file: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...record })}\n`)
  } catch {
    // Dropped. A failed observability write is never an app error.
  }
}

function sessionEventsFile(sessionId: string): string {
  return join(OBS_ROOT, 'sessions', safeSegment(sessionId), 'events.jsonl')
}

/**
 * Fields kept in metadata-only mode. Everything else (args, message content,
 * delta text, tool summaries) is debug-only. Timing fields (`execMs`/`waitMs`)
 * and outcome fields (`isError`, `runState`, `code`, `exitCode`) stay: they are
 * the whole point of the default stream.
 */
const META_KEYS = new Set([
  'type',
  'sessionId',
  'seq',
  'ts',
  'toolCallId',
  'name',
  'runState',
  'isError',
  'execMs',
  'waitMs',
  'code',
  'exitCode',
  'terminalId'
])

/** Observe one kernel event at the worker's single emit() outlet. */
export function observeEvent(sessionId: string, event: Record<string, unknown>): void {
  if (isDebugLlm()) {
    appendLine(sessionEventsFile(sessionId), event)
    return
  }
  const meta: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (META_KEYS.has(key)) meta[key] = value
  }
  appendLine(sessionEventsFile(sessionId), meta)
}

/** Observe one LLM call made by (or routed through) worker-side code. */
export function observeLlmCall(o: LlmCallObservation): void {
  appendLine(LLM_CALLS_FILE, { kind: 'llm_call', ...o })
}

/** Observe one stage (or the whole run) of a long-running pipeline. */
export function observePipeline(o: PipelineObservation): void {
  appendLine(PIPELINE_FILE, { ...o })
}
