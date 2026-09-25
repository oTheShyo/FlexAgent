// Fails if a child agent's run stops producing a cost ledger.
//
// A child runs its own AgentSession over an in-memory session manager and is
// disposed before the parent hears back, so its `chat` calls never cross the
// parent's event stream — the only way a delegation's tokens become visible is
// the ledger written at the end of `runChild` under callSource 'role_task'.
//
// What this checks is the far end of that path: that the sink writes the role,
// the turn count and the cost, and that a missing ledger never reads as "this
// role cost nothing".
//
// Scope note, learned the hard way: `observeLlmCall` spreads its argument into
// the JSON line, so the *type* dropping a field would not change what is
// written. The type is the channel's real guard (`tsc` is what fails when
// `role` is no longer accepted), and the two source assertions below are what
// fail when the reporting call itself is deleted. This file owns the sink's
// contract; it is not a substitute for running a `task` call.
//
// Run with: node --experimental-strip-types scripts/child-run-observability-check.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const OBS_HOME = mkdtempSync(join(tmpdir(), 'flex-obs-check-'))
process.env.FLEXAGENT_OBS_HOME = OBS_HOME

const { observeLlmCall } = await import('../src/main/observability.ts')

const CALLS_FILE = join(OBS_HOME, 'observability', 'llm-calls.jsonl')

let failed = 0

function check(label, ok, detail = '') {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function readLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

observeLlmCall({
  callSource: 'role_task',
  sessionId: 'ses_parent_1',
  role: 'gauge',
  durationMs: 41_000,
  ok: true,
  note: 'child role "gauge" — 4 turn(s), 11 tool call(s)',
  tokens: { input: 82_000, output: 3_100, cacheRead: 12_000, cacheWrite: 0 },
  cost: 0.42
})

const rows = readLines(CALLS_FILE)
check('the child ledger reaches the llm-calls stream', rows.length === 1, `${rows.length} row(s)`)

const row = rows[0] ?? {}
check("the call source is 'role_task'", row.callSource === 'role_task', String(row.callSource))
check('the row names the role that spent', row.role === 'gauge', String(row.role))
check('the row is attributed to the parent session', row.sessionId === 'ses_parent_1')
check('the ledger carries the model time', row.durationMs === 41_000, `${row.durationMs}ms`)
check('the ledger carries tokens', row.tokens?.input === 82_000 && row.tokens?.output === 3_100)
check('the ledger carries the cost', row.cost === 0.42, String(row.cost))
check("the record kind is 'llm_call'", row.kind === 'llm_call', String(row.kind))

// A child that blew up is the case worth having: an aborted run is disposed
// before the parent sees a failure, so it is the easiest ledger to lose.
observeLlmCall({
  callSource: 'role_task',
  sessionId: 'ses_parent_1',
  role: 'reed',
  durationMs: 1_200,
  ok: false
})
const failedRow = readLines(CALLS_FILE)[1] ?? {}
check('a failed child is still recorded', failedRow.callSource === 'role_task')
check('a failed child still names its role', failedRow.role === 'reed', String(failedRow.role))
check(
  'an unmeasured cost is omitted rather than reported as zero',
  failedRow.cost === undefined,
  'cost: 0 would read as "this run was free"'
)

// The failure mode this exists to catch: the sink dropping the ledger fields so
// the row shows up but says nothing about who spent what.
const source = readFileSync(new URL('../src/main/observability.ts', import.meta.url), 'utf8')
check(
  "the CallSource union still offers 'role_task'",
  /\| 'role_task'/.test(source),
  'the type is the only guard against a silent regression'
)

// The other half: the producer. A sink contract nobody feeds is the exact way
// this channel went dark the first time.
const producer = readFileSync(new URL('../src/main/agents/multiAgent.ts', import.meta.url), 'utf8')
check(
  'runChild still reports its ledger',
  /observeChildRun\?\.\(\{[\s\S]{0,400}?parentSessionId/.test(producer),
  'the finally block that hands the ledger over'
)
// Anchored so a commented-out line cannot satisfy it: unanchored, `// role:
// role.name,` still matched and the check passed against nothing.
check('the ledger names the role', /^[ \t]*role: role\.name,[ \t]*$/m.test(producer))
check(
  'the ledger is reported before the child session is disposed',
  producer.indexOf('observeChildRun?.((') < producer.indexOf('session.dispose()'),
  'the stats object dies with the session'
)
check(
  'the worker tags the ledger as role_task',
  readFileSync(new URL('../src/main/worker.ts', import.meta.url), 'utf8').includes(
    "callSource: 'role_task'"
  )
)

rmSync(OBS_HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nchild runs are attributable' : `\n${failed} problem(s)`)
process.exit(failed === 0 ? 0 : 1)
