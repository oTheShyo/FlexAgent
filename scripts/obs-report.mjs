#!/usr/bin/env node
/**
 * Offline aggregation over the observability NDJSON streams (docs/observability.md).
 *
 *   node scripts/obs-report.mjs [--dir <obsHome>] [--hours <n>]
 *
 * Reads:
 *   <obsHome>/sessions/<id>/events.jsonl     kernel events (metadata-only by default)
 *   <obsHome>/observability/llm-calls.jsonl  LLM calls with callSource + tokens
 *   <obsHome>/observability/pipeline.jsonl   long-running pipeline stages
 *
 * <obsHome> defaults to FLEXAGENT_OBS_HOME, else ~/.flexagent. `--hours` keeps
 * only records stamped within the last N hours (default: all).
 *
 * Answers the questions the design doc promises: token spend by callSource,
 * permission wait vs execution time per tool, and why Skill Hub installs fail.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const obsHome = argValue('--dir') ?? process.env.FLEXAGENT_OBS_HOME ?? join(homedir(), '.flexagent')
const hours = Number(argValue('--hours') ?? NaN)
const cutoff = Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3600_000 : 0

function readNdjson(file) {
  if (!existsSync(file)) return []
  const out = []
  let lineno = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    lineno++
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const record = JSON.parse(trimmed)
      if ((record?.ts ?? 0) >= cutoff) out.push(record)
    } catch {
      // A torn final line is expected after a crash; report it once per file.
      console.warn(`[obs-report] ${file}:${lineno}: unparseable line skipped`)
    }
  }
  return out
}

// ── collect ──────────────────────────────────────────────────────────────────

const llmCalls = readNdjson(join(obsHome, 'observability', 'llm-calls.jsonl'))
const pipeline = readNdjson(join(obsHome, 'observability', 'pipeline.jsonl'))

const eventsRoot = join(obsHome, 'sessions')
const events = []
if (existsSync(eventsRoot)) {
  for (const session of readdirSync(eventsRoot)) {
    events.push(...readNdjson(join(eventsRoot, session, 'events.jsonl')))
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '-')
function pct(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}
function stats(values) {
  if (values.length === 0) return { n: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return { n: values.length, p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted[sorted.length - 1] }
}
const msStat = (s) => (s.n === 0 ? 'n=0' : `n=${s.n} p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms`)

// ── LLM calls by callSource ──────────────────────────────────────────────────

console.log(`\n== LLM calls by callSource (${obsHome}) ==`)
if (llmCalls.length === 0) console.log('(no llm-calls.jsonl records)')
{
  const bySource = new Map()
  for (const c of llmCalls) {
    const b = bySource.get(c.callSource) ?? {
      calls: 0, failures: 0, dur: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Map()
    }
    b.calls += 1
    if (c.ok === false) b.failures += 1
    if (typeof c.durationMs === 'number') b.dur.push(c.durationMs)
    b.input += c.tokens?.input ?? 0
    b.output += c.tokens?.output ?? 0
    b.cacheRead += c.tokens?.cacheRead ?? 0
    b.cacheWrite += c.tokens?.cacheWrite ?? 0
    b.cost += c.cost ?? 0
    if (c.model !== undefined) b.models.set(c.model, (b.models.get(c.model) ?? 0) + 1)
    bySource.set(c.callSource, b)
  }
  for (const [source, b] of [...bySource.entries()].sort()) {
    console.log(
      `\n  ${source}: calls=${b.calls} failures=${b.failures} cost=$${b.cost.toFixed(4)}\n` +
      `    tokens in=${fmt(b.input)} out=${fmt(b.output)} cacheRead=${fmt(b.cacheRead)} cacheWrite=${fmt(b.cacheWrite)}\n` +
      `    duration ${msStat(stats(b.dur))}\n` +
      `    models: ${[...b.models.entries()].map(([m, n]) => `${m}×${n}`).join(', ') || '-'}`
    )
  }
}

// ── tools: exec vs wait ──────────────────────────────────────────────────────

console.log('\n== Tool time: exec vs permission wait ==')
if (events.length === 0) console.log('(no session events found)')
{
  const byTool = new Map()
  for (const e of events) {
    if (e.type !== 'tool_end') continue
    const b = byTool.get(e.name) ?? { exec: [], wait: [], errors: 0 }
    if (typeof e.execMs === 'number') b.exec.push(e.execMs)
    if (typeof e.waitMs === 'number') b.wait.push(e.waitMs)
    if (e.isError === true) b.errors += 1
    byTool.set(e.name, b)
  }
  for (const [name, b] of [...byTool.entries()].sort()) {
    console.log(`\n  ${name}: errors=${b.errors}`)
    if (b.exec.length > 0) console.log(`    exec ${msStat(stats(b.exec))}`)
    if (b.wait.length > 0) console.log(`    wait ${msStat(stats(b.wait))}`)
  }
  const mixed = events.filter((e) => e.type === 'tool_end' && typeof e.execMs !== 'number')
  if (mixed.length > 0) {
    console.log(`\n  (note: ${mixed.length} tool_end without execMs — from before the field existed)`)
  }
}

// ── pipeline ─────────────────────────────────────────────────────────────────

console.log('\n== Pipelines ==')
if (pipeline.length === 0) console.log('(no pipeline.jsonl records)')
{
  const byStage = new Map()
  for (const p of pipeline) {
    const key = `${p.kind}/${p.stage}`
    const b = byStage.get(key) ?? { ok: 0, fail: 0, dur: [], lastNote: undefined, lastOk: undefined }
    if (p.ok === true) b.ok += 1
    else b.fail += 1
    b.lastNote = p.note ?? b.lastNote
    b.lastOk = p.ok
    if (typeof p.durationMs === 'number') b.dur.push(p.durationMs)
    byStage.set(key, b)
  }
  for (const [stage, b] of [...byStage.entries()].sort()) {
    console.log(
      `  ${stage}: ok=${b.ok} fail=${b.fail} ${msStat(stats(b.dur))}` +
      (b.lastOk === false ? `\n    last failure: ${b.lastNote}` : '')
    )
  }
}

// ── kernel errors ────────────────────────────────────────────────────────────

const errors = events.filter((e) => e.type === 'error')
if (errors.length > 0) {
  console.log('\n== Kernel errors (metadata) ==')
  const byCode = new Map()
  for (const e of errors) byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1)
  for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code}: ${n}`)
  }
}

console.log('')
