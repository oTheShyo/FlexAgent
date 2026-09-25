/**
 * Multi-agent end-to-end verification against a REAL model (ticket 03).
 *
 *   node scripts/diag-multie2e.mjs               # every phase
 *   node scripts/diag-multie2e.mjs single chain  # a subset (cheap re-runs)
 *
 * Why this shape: the acceptance scripts in this folder drive the Electron
 * renderer over CDP, which needs a dev server + a window. The subsystem under
 * test lives entirely in the kernel worker — `task`/`swarm` registration,
 * child session isolation, and `forwardChildPermission` — so this harness
 * speaks the main↔worker protocol (shared/kernel-protocol) directly. Same
 * worker.js the app spawns, same permission gate, same observability sinks;
 * only the renderer is absent, and the renderer contributes no multi-agent
 * logic (it renders permission_request and posts respondPermission, which
 * this harness does itself).
 *
 * Requires a build: `npm run build` (worker.js is the entry).
 *
 * Phases (each writes PASS/FAIL lines and an evidence record):
 *   single        one child via task single mode
 *   parallel      two children in one wave, overlap proven from the ledgers
 *   chain         step 2 consumes step 1 through {previous}
 *   isolate       child cannot see the parent conversation (codeword test)
 *   whitelist     child's tool list is the role whitelist; no `task` → depth cap 1
 *   perm-default  mode=default: child's high-risk bash is ASKed on the parent's
 *                 channel (toolCallId `subagent-*`) and denied → no file
 *   perm-bypass   mode=bypass: same class of command runs with no prompt
 *
 * Everything is deadline-bounded: a phase that never settles is aborted and
 * recorded as a failure instead of hanging the run.
 */
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const CWD = process.cwd()
const WORKER_PATH = join(CWD, 'out', 'main', 'worker.js')
const EVIDENCE_FILE = join(CWD, '.scratch', 'zcode-gap', 'reports', '03-multie2e-evidence.json')
const OBS_FILE = join(homedir(), '.flexagent', 'observability', 'llm-calls.jsonl')
const AUDIT_DIR = join(homedir(), '.flexagent', 'audit')

const ALL_PHASES = ['single', 'parallel', 'chain', 'isolate', 'whitelist', 'perm-default', 'perm-bypass']

/** Per-phase wall clock budget. A phase that blows its budget is aborted. */
const PHASE_BUDGET_MS = {
  single: 180_000,
  parallel: 240_000,
  chain: 240_000,
  isolate: 180_000,
  whitelist: 240_000,
  'perm-default': 240_000,
  'perm-bypass': 180_000
}

const CODEWORD = 'ZEBRA-42'

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

const results = []
let current = null

function check(name, ok, detail = '') {
  current.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 500) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${current.phase} :: ${name}${detail ? `  — ${detail}` : ''}`)
}

function note(text) {
  console.log(`      ${current.phase} :: ${text}`)
}

// ---------------------------------------------------------------------------
// kernel client (mirrors KernelHost: requestId correlation + event fan-out)
// ---------------------------------------------------------------------------

class KernelClient {
  constructor(workerPath) {
    this.worker = new Worker(workerPath)
    this.pending = new Map()
    this.listeners = new Set()
    this.dead = null
    this.worker.on('message', (msg) => {
      if (msg.type === 'event') {
        for (const fn of this.listeners) fn(msg.sessionId, msg.event)
        return
      }
      if (msg.type === 'mcpStatus') return
      const p = this.pending.get(msg.requestId)
      if (!p) return
      this.pending.delete(msg.requestId)
      clearTimeout(p.timer)
      if (msg.type === 'ok') p.resolve(msg.result)
      else p.reject(Object.assign(new Error(msg.message), { code: msg.code }))
    })
    this.worker.on('error', (err) => {
      this.dead = err
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
    })
    this.worker.on('exit', (code) => {
      if (this.dead === null) this.dead = new Error(`worker exited with code ${code}`)
    })
  }

  request(payload, timeoutMs = 120_000) {
    if (this.dead) return Promise.reject(this.dead)
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`timeout waiting for worker response: ${payload.type}`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      this.worker.postMessage({ ...payload, requestId })
    })
  }

  onEvent(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// session harness
// ---------------------------------------------------------------------------

function openSession(kernel, title) {
  const id = randomUUID()
  const sess = {
    id,
    title,
    events: [],
    permLog: [],
    piSessionFile: null,
    off: null
  }
  sess.off = kernel.onEvent((sessionId, event) => {
    if (sessionId === id) sess.events.push({ ...event, at: Date.now() })
  })
  return sess
}

function eventsFrom(sess, mark) {
  return sess.events.slice(mark)
}

async function waitSettled(sess, mark, timeoutMs) {
  const start = Date.now()
  let runningAt = -1
  while (Date.now() - start < timeoutMs) {
    const evs = sess.events
    for (let i = Math.max(0, mark); i < evs.length; i += 1) {
      const e = evs[i]
      if (e.type === 'run_state' && e.runState === 'running' && runningAt < 0) runningAt = i
      if (e.type === 'run_state' && e.runState === 'idle' && runningAt >= 0 && i > runningAt) {
        return { ok: true, ms: Date.now() - start }
      }
      if (e.type === 'error' && runningAt < 0 && i > mark) {
        return { ok: false, ms: Date.now() - start, error: `${e.code}: ${e.message}` }
      }
    }
    await delay(100)
  }
  return { ok: false, ms: Date.now() - start, timeout: true }
}

/**
 * Prompt + settle, with an automatic permission responder.
 *
 * `decide(event)` returns a decision string, or 'wait' to leave the request
 * pending (the settle timeout then reports it instead of deadlocking silently).
 * Every answered request lands in sess.permLog — that log is the evidence for
 * the permission phases.
 */
async function runPrompt(kernel, sess, text, { decide, timeoutMs }) {
  const mark = sess.events.length
  const answered = new Set()
  let stop = false

  const responder = (async () => {
    while (!stop) {
      for (const e of sess.events.slice(mark)) {
        if (e.type !== 'permission_request' || answered.has(e.toolCallId)) continue
        const decision = decide ? decide(e) : 'allowOnce'
        if (decision === 'wait') continue
        answered.add(e.toolCallId)
        sess.permLog.push({
          toolCallId: e.toolCallId,
          name: e.name,
          label: e.label,
          mode: e.mode,
          decision,
          at: e.at
        })
        kernel
          .request({ type: 'respondPermission', sessionId: sess.id, toolCallId: e.toolCallId, decision }, 30_000)
          .catch(() => {})
      }
      await delay(80)
    }
  })()

  const ack = await kernel.request({ type: 'prompt', sessionId: sess.id, text }, 90_000)
  const settled = await waitSettled(sess, mark, timeoutMs)
  if (!settled.ok) {
    await kernel.request({ type: 'abort', sessionId: sess.id }, 30_000).catch(() => {})
    await delay(1_500)
  }
  stop = true
  await responder
  return { mark, ack: ack?.disposition, settled }
}

// ---------------------------------------------------------------------------
// transcript + ledger readers (evidence, not the model's own relay)
// ---------------------------------------------------------------------------

function readTranscript(file) {
  if (!file || !existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** Full text of every `task` tool result in the parent transcript. */
function taskResults(transcript) {
  const out = []
  for (const entry of transcript) {
    const msg = entry.message
    if (!msg || msg.role !== 'toolResult' || msg.toolName !== 'task') continue
    const text = (msg.content || []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n')
    out.push({ toolCallId: msg.toolCallId, text })
  }
  return out
}

function userMessages(transcript) {
  return transcript
    .filter((e) => e.message?.role === 'user')
    .map((e) => (e.message.content || []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n'))
}

function assistantText(transcript) {
  return transcript
    .filter((e) => e.message?.role === 'assistant')
    .map((e) => (e.message.content || []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n'))
    .join('\n')
}

function readLedger() {
  if (!existsSync(OBS_FILE)) return []
  return readFileSync(OBS_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function readAuditTail(maxLines = 400) {
  if (!existsSync(AUDIT_DIR)) return []
  const files = readdirSync(AUDIT_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(AUDIT_DIR, f))
  const out = []
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
    for (const l of lines.slice(-maxLines)) {
      try {
        out.push(JSON.parse(l))
      } catch {
        /* skip */
      }
    }
  }
  return out
}

/** Progress lines the task tool streams through onUpdate (tool_update chunks). */
function progressLines(events) {
  const out = []
  for (const e of events) {
    if (e.type !== 'tool_update' || typeof e.chunk !== 'string') continue
    let text = e.chunk
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed?.content)) {
        text = parsed.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
      }
    } catch {
      /* raw string */
    }
    for (const line of text.split('\n')) {
      if (line.includes('⏺')) out.push({ line: line.trim(), at: e.at })
    }
  }
  return out
}

function windowsOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end
}

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------

async function phaseSingle(ctx) {
  const { kernel, sess } = ctx
  const prompt =
    'Use the `task` tool exactly once, in single mode, with role "researcher" and task ' +
    '"Reply with exactly: CHILD_SINGLE_OK". Do not solve it yourself, do not use any other tool. ' +
    'When the task tool returns, reply with only what the task tool reported.'
  const { mark, settled } = await runPrompt(kernel, sess, prompt, {
    timeoutMs: PHASE_BUDGET_MS.single
  })
  const evs = eventsFrom(sess, mark)
  const started = evs.find((e) => e.type === 'tool_start' && e.name === 'task')
  const ended = started && evs.find((e) => e.type === 'tool_end' && e.toolCallId === started.toolCallId)

  check('run settled', settled.ok, settled.timeout ? 'TIMEOUT' : settled.error || `${settled.ms}ms`)
  check('parent called the task tool', Boolean(started), started ? started.toolCallId : 'no tool_start(task)')
  check('task tool call succeeded', Boolean(ended) && !ended.isError, ended ? `isError=${ended.isError}` : 'no tool_end')

  const results_ = taskResults(readTranscript(sess.piSessionFile))
  const taskText = results_.map((r) => r.text).join('\n')
  check('child report came back through the tool result', taskText.includes('CHILD_SINGLE_OK'), `len=${taskText.length}`)
  check('report marks the child ok', /researcher[^)]*— ok/.test(taskText) || /researcher — ok/.test(taskText))

  const ledger = readLedger().filter((r) => r.callSource === 'role_task' && r.sessionId === sess.id)
  check('child run recorded in llm-calls (role_task)', ledger.length >= 1, JSON.stringify(ledger.map((l) => ({ role: l.role, ok: l.ok, tokens: l.tokens?.total }))))
}

async function phaseParallel(ctx) {
  const { kernel, sess } = ctx
  const prompt =
    'Use the `task` tool exactly once, in parallel mode, with a `tasks` array containing exactly ' +
    'these two entries: (1) role "researcher", task "Reply with exactly: CHILD_PAR_A"; ' +
    '(2) role "researcher", task "Reply with exactly: CHILD_PAR_B". ' +
    'Do not solve them yourself. When the task tool returns, reply with only what it reported.'
  const ledgerBefore = readLedger().filter((r) => r.callSource === 'role_task' && r.sessionId === sess.id).length
  const { mark, settled } = await runPrompt(kernel, sess, prompt, {
    timeoutMs: PHASE_BUDGET_MS.parallel
  })
  const evs = eventsFrom(sess, mark)
  const started = evs.find((e) => e.type === 'tool_start' && e.name === 'task')
  const ended = started && evs.find((e) => e.type === 'tool_end' && e.toolCallId === started.toolCallId)

  check('run settled', settled.ok, settled.timeout ? 'TIMEOUT' : settled.error || `${settled.ms}ms`)
  check('parent called the task tool once', Boolean(started) && evs.filter((e) => e.type === 'tool_start' && e.name === 'task').length === 1)
  const argTasks = Array.isArray(started?.args?.tasks) ? started.args.tasks : []
  check('dispatched 2 tasks in one wave', argTasks.length === 2, JSON.stringify(argTasks.map((t) => t?.role)))
  check('task tool call succeeded', Boolean(ended) && !ended.isError, ended ? `isError=${ended.isError}` : 'no tool_end')

  const taskText = taskResults(readTranscript(sess.piSessionFile)).map((r) => r.text).join('\n')
  check('both children reported back', taskText.includes('CHILD_PAR_A') && taskText.includes('CHILD_PAR_B'))
  check('batch summary reports 0 failed', /batch finished: 2 task\(s\), 0 failed/.test(taskText), taskText.slice(0, 160).replace(/\s+/g, ' '))

  // Concurrency: two independent signals — the streamed progress lines (both
  // "started" before any "done") and the persisted per-child ledgers, whose
  // [ts - durationMs, ts] windows must intersect.
  const lines = progressLines(evs)
  const starts = lines.filter((l) => l.line.includes('— started'))
  const dones = lines.filter((l) => l.line.includes('— done'))
  const progressOverlap = starts.length >= 2 && dones.length >= 1 && starts[1].at <= dones[0].at

  const ledger = readLedger().filter((r) => r.callSource === 'role_task' && r.sessionId === sess.id)
  const newRows = ledger.slice(ledgerBefore)
  const windows = newRows.map((r) => ({ start: r.ts - (r.durationMs || 0), end: r.ts }))
  const ledgerOverlap = windows.length >= 2 && windowsOverlap(windows[0], windows[1])
  const ledgerOk = newRows.filter((r) => r.ok).length >= 2

  check('children ran concurrently (progress lines)', progressOverlap, `${starts.length} started / ${dones.length} done before first done`)
  check('children ran concurrently (role_task ledgers overlap)', ledgerOverlap, JSON.stringify(windows))
  check('two successful child ledgers persisted', ledgerOk, JSON.stringify(newRows.map((r) => ({ role: r.role, ok: r.ok, ms: r.durationMs }))))
}

async function phaseChain(ctx) {
  const { kernel, sess } = ctx
  const prompt =
    'Use the `task` tool exactly once, in chain mode, with a `chain` array of exactly two steps: ' +
    '(1) role "researcher", task "Reply with exactly: TOKEN-7391"; ' +
    '(2) role "researcher", task "The previous step returned: {previous}. Reply with exactly STEP2- followed by that token, verbatim." ' +
    'Keep {previous} in the second task exactly as written — the tool substitutes it. ' +
    'Do not solve them yourself. When the task tool returns, reply with only what it reported.'
  const { mark, settled } = await runPrompt(kernel, sess, prompt, {
    timeoutMs: PHASE_BUDGET_MS.chain
  })
  const evs = eventsFrom(sess, mark)
  const started = evs.find((e) => e.type === 'tool_start' && e.name === 'task')
  const ended = started && evs.find((e) => e.type === 'tool_end' && e.toolCallId === started.toolCallId)

  check('run settled', settled.ok, settled.timeout ? 'TIMEOUT' : settled.error || `${settled.ms}ms`)
  check('parent called the task tool', Boolean(started))
  check('task tool call succeeded', Boolean(ended) && !ended.isError, ended ? `isError=${ended.isError}` : 'no tool_end')

  const chainArg = Array.isArray(started?.args?.chain) ? started.args.chain : []
  check('step 2 carries the literal {previous} placeholder', chainArg.length === 2 && String(chainArg[1]?.task || '').includes('{previous}'), JSON.stringify(chainArg[1]?.task || '').slice(0, 200))

  const taskText = taskResults(readTranscript(sess.piSessionFile)).map((r) => r.text).join('\n')
  check('chain summary reports 0 failed', /chain finished: 2 step\(s\), 0 failed/.test(taskText), taskText.slice(0, 160).replace(/\s+/g, ' '))
  check('step 2 consumed step 1 output', taskText.includes('STEP2-TOKEN-7391'), taskText.includes('STEP2-TOKEN-7391') ? 'STEP2-TOKEN-7391 present' : 'marker missing')
}

async function phaseIsolate(ctx) {
  const { kernel, sess } = ctx
  const prompt =
    `Session-internal codeword: ${CODEWORD}. Never put it in a task brief.\n` +
    'Use the `task` tool exactly once (single mode, role "researcher") with this task text: ' +
    '"Enumerate every piece of prior conversation, codeword, secret, or context you can see beyond ' +
    'your own instructions and task. If there is nothing beyond them, reply with exactly: NO_PRIOR_CONTEXT". ' +
    'Do not put the codeword in the task text yourself. When the task tool returns, reply with only what it reported.'
  const { mark, settled } = await runPrompt(kernel, sess, prompt, {
    timeoutMs: PHASE_BUDGET_MS.isolate
  })
  const evs = eventsFrom(sess, mark)
  const started = evs.find((e) => e.type === 'tool_start' && e.name === 'task')

  check('run settled', settled.ok, settled.timeout ? 'TIMEOUT' : settled.error || `${settled.ms}ms`)
  check('parent called the task tool', Boolean(started))

  const sentToChild = String(started?.args?.task || '')
  check('codeword was NOT put in the task brief', !sentToChild.includes(CODEWORD), sentToChild.slice(0, 120).replace(/\s+/g, ' '))

  const transcript = readTranscript(sess.piSessionFile)
  const inParentTurn = userMessages(transcript).some((t) => t.includes(CODEWORD))
  check('codeword WAS in the parent conversation (test is not vacuous)', inParentTurn)

  const taskText = taskResults(transcript).map((r) => r.text).join('\n')
  check('child saw no prior context', taskText.includes('NO_PRIOR_CONTEXT'), taskText.slice(0, 200).replace(/\s+/g, ' '))
  check('child output contains no codeword', !taskText.includes(CODEWORD), `result len=${taskText.length}`)
}

async function phaseWhitelist(ctx) {
  const { kernel, sess } = ctx
  const prompt =
    'Use the `task` tool exactly once (single mode, role "researcher") with this task text: ' +
    '"Answer in exactly this format and nothing else. ' +
    'TOOLS: <comma-separated exact names of every tool you are able to call>. ' +
    'TASK_ATTEMPT: <what happens when you try to call a tool named task with arguments {"role":"researcher","task":"say HI"} — quote the error verbatim, or write TOOL_NOT_AVAILABLE>. ' +
    'BASH_ATTEMPT: <same for a tool named bash>". ' +
    'Do not solve it yourself. When the task tool returns, reply with only what it reported.'
  const { mark, settled } = await runPrompt(kernel, sess, prompt, {
    timeoutMs: PHASE_BUDGET_MS.whitelist
  })
  const evs = eventsFrom(sess, mark)
  const started = evs.find((e) => e.type === 'tool_start' && e.name === 'task')
  check('run settled', settled.ok, settled.timeout ? 'TIMEOUT' : settled.error || `${settled.ms}ms`)
  check('parent called the task tool', Boolean(started))

  const taskText = taskResults(readTranscript(sess.piSessionFile)).map((r) => r.text).join('\n')
  const toolsLine = (taskText.match(/TOOLS:\s*([^\n]*)/) || [])[1] || ''
  const tools = toolsLine
    .split(/[,·|]/)
    .map((t) => t.trim().toLowerCase().replace(/[^a-z_]/g, ''))
    .filter((t) => t !== '')

  check('child reported its tool list', tools.length > 0, tools.join(',') || 'unparsed')
  const forbidden = ['task', 'swarm', 'bash', 'write', 'edit', 'skillmanage', 'memorymanage']
  const leaked = forbidden.filter((f) => tools.includes(f))
  check('no out-of-whitelist tool available to the child', leaked.length === 0, leaked.length ? `leaked: ${leaked}` : `tools=[${tools.join(',')}]`)
  check('whitelist tools present', tools.some((t) => ['read', 'grep', 'find', 'ls'].includes(t)), `tools=[${tools.join(',')}]`)

  const taskAttempt = (taskText.match(/TASK_ATTEMPT:\s*([\s\S]*?)(?=\n\s*BASH_ATTEMPT:|$)/) || [])[1] || ''
  check(
    're-dispatch inside the child is refused (depth cap = 1)',
    /TOOL_NOT_AVAILABLE|not available|no such tool|unknown tool|does not exist|cannot find|not (?:able|allowed) to/i.test(taskAttempt),
    taskAttempt.trim().slice(0, 220).replace(/\s+/g, ' ') || 'unparsed'
  )
}

async function phasePermDefault(ctx) {
  const { kernel, sess } = ctx
  await kernel.request({ type: 'setPermissionMode', sessionId: sess.id, mode: 'default' }, 30_000)
  const mode = await kernel.request({ type: 'getPermissionMode', sessionId: sess.id }, 30_000)
  check('session permission mode is non-bypass', mode === 'default', `mode=${mode}`)

  const probeFile = join(CWD, 'multie2e_denied_probe.txt')
  const prompt =
    'Use the `task` tool exactly once (single mode, role "developer") with this task text: ' +
    '"Run exactly this shell command with bash: echo denied > multie2e_denied_probe.txt . ' +
    'Then report whether it ran." Do not run anything yourself; report only what the task tool returned.'
  const { mark, settled } = await runPrompt(kernel, sess, prompt, {
    decide: (e) => (String(e.toolCallId).startsWith('subagent-') ? 'deny' : 'allowOnce'),
    timeoutMs: PHASE_BUDGET_MS['perm-default']
  })
  const evs = eventsFrom(sess, mark)
  const requests = evs.filter((e) => e.type === 'permission_request')
  const sub = sess.permLog.filter((p) => String(p.toolCallId).startsWith('subagent-'))

  check('run settled', settled.ok, settled.timeout ? 'TIMEOUT' : settled.error || `${settled.ms}ms`)
  check(
    'parent tool calls were gated by the parent mode',
    requests.some((r) => r.mode === 'default'),
    JSON.stringify(requests.map((r) => ({ id: r.toolCallId, name: r.name, mode: r.mode }))).slice(0, 300)
  )
  check(
    'child high-risk op forwarded to the parent channel under a synthetic id',
    sub.length >= 1,
    JSON.stringify(sub).slice(0, 300)
  )
  const subBash = sub.find((p) => p.name === 'bash')
  check('forwarded request is the child bash call, labelled with the child role', Boolean(subBash) && String(subBash.label).includes('developer'), subBash ? subBash.label : 'none')
  check('forwarded request evaluated under mode=default', Boolean(subBash) && subBash.mode === 'default', subBash ? `mode=${subBash.mode}` : '')
  check('the forwarded request was answered deny', Boolean(subBash) && subBash.decision === 'deny', subBash ? subBash.decision : '')
  check('denied command did NOT execute', !existsSync(probeFile), existsSync(probeFile) ? 'file exists!' : 'absent')

  const audits = readAuditTail().filter((a) => a.kind === 'child-permission')
  const mine = audits.filter((a) => a.sessionId === sess.id)
  check(
    'audit trail has a child-permission record for this session',
    mine.some((a) => a.tool === 'bash' && a.mode === 'default'),
    JSON.stringify(mine.slice(-3)).slice(0, 400)
  )
}

async function phasePermBypass(ctx) {
  const { kernel, sess } = ctx
  await kernel.request({ type: 'setPermissionMode', sessionId: sess.id, mode: 'bypass' }, 30_000)
  const mode = await kernel.request({ type: 'getPermissionMode', sessionId: sess.id }, 30_000)
  check('session permission mode is bypass', mode === 'bypass', `mode=${mode}`)

  const probeFile = join(CWD, 'multie2e_bypass_probe.txt')
  const prompt =
    'Use the `task` tool exactly once (single mode, role "developer") with this task text: ' +
    '"Run exactly this shell command with bash: echo bypass > multie2e_bypass_probe.txt . ' +
    'Then report whether it ran." Do not run anything yourself; report only what the task tool returned.'
  const { mark, settled } = await runPrompt(kernel, sess, prompt, {
    timeoutMs: PHASE_BUDGET_MS['perm-bypass']
  })
  const evs = eventsFrom(sess, mark)
  const requests = evs.filter((e) => e.type === 'permission_request')

  check('run settled', settled.ok, settled.timeout ? 'TIMEOUT' : settled.error || `${settled.ms}ms`)
  check('no permission prompt in bypass mode', requests.length === 0, JSON.stringify(requests.map((r) => r.toolCallId)))
  check('child command executed under bypass', existsSync(probeFile))
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(probeFile)
  } catch {
    /* ignore */
  }
}

const PHASE_IMPL = {
  single: phaseSingle,
  parallel: phaseParallel,
  chain: phaseChain,
  isolate: phaseIsolate,
  whitelist: phaseWhitelist,
  'perm-default': phasePermDefault,
  'perm-bypass': phasePermBypass
}

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

function writeEvidence(entry) {
  let doc = {}
  try {
    doc = JSON.parse(readFileSync(EVIDENCE_FILE, 'utf8'))
  } catch {
    doc = { ticket: '03-multi-agent-e2e', phases: {} }
  }
  doc.updatedAt = new Date().toISOString()
  doc.worker = 'out/main/worker.js (real kernel worker, spawned by this harness)'
  doc.phases = doc.phases || {}
  doc.phases[entry.phase] = entry
  mkdirSync(join(EVIDENCE_FILE, '..'), { recursive: true })
  writeFileSync(EVIDENCE_FILE, `${JSON.stringify(doc, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const phases = requested.length > 0 ? requested : ALL_PHASES
  for (const p of phases) {
    if (!ALL_PHASES.includes(p)) {
      console.error(`unknown phase "${p}" — known: ${ALL_PHASES.join(', ')}`)
      process.exit(2)
    }
  }
  if (!existsSync(WORKER_PATH)) {
    console.error(`FAIL: ${WORKER_PATH} missing — run \`npm run build\` first`)
    process.exit(2)
  }

  const kernel = new KernelClient(WORKER_PATH)
  const startedAt = Date.now()

  let model = null
  let failures = 0

  try {
    for (const phase of phases) {
      current = { phase, checks: [], startedAt: new Date().toISOString() }
      console.log(`\n── phase ${phase} ──`)
      const sess = openSession(kernel, `multie2e-${phase}`)
      try {
        const created = await kernel.request(
          { type: 'createSession', sessionId: sess.id, cwd: CWD, title: sess.title },
          180_000
        )
        sess.piSessionFile = created?.piSessionFile ?? null
        if (model === null) {
          try {
            const cfg = await kernel.request({ type: 'getModelConfig', sessionId: sess.id }, 60_000)
            model = cfg
          } catch (err) {
            model = { error: String(err.message || err) }
          }
        }
        const t0 = Date.now()
        await PHASE_IMPL[phase]({ kernel, sess })
        const durationMs = Date.now() - t0
        const ok = current.checks.every((c) => c.ok)
        if (!ok) failures += 1
        writeEvidence({
          phase,
          ok,
          durationMs,
          sessionFile: sess.piSessionFile,
          permissionLog: sess.permLog,
          checks: current.checks
        })
        console.log(`${ok ? 'PHASE OK ' : 'PHASE FAIL'} ${phase} (${durationMs}ms, ${current.checks.filter((c) => c.ok).length}/${current.checks.length})`)
      } catch (err) {
        failures += 1
        check('phase threw', false, err?.stack || String(err))
        writeEvidence({ phase, ok: false, checks: current.checks })
        console.log(`PHASE FAIL ${phase} — ${err?.message || err}`)
        await kernel.request({ type: 'abort', sessionId: sess.id }, 20_000).catch(() => {})
      } finally {
        await kernel.request({ type: 'disposeSession', sessionId: sess.id }, 30_000).catch(() => {})
        sess.off?.()
      }
    }
  } finally {
    await kernel.request({ type: 'shutdown' }, 15_000).catch(() => {})
    try {
      await Promise.race([kernel.worker.terminate(), delay(5_000)])
    } catch {
      /* ignore */
    }
  }

  const totalMs = Date.now() - startedAt
  console.log(`\nmodel: ${JSON.stringify(model)}`)
  console.log(failures === 0 ? `ALL PHASES PASSED (${phases.length}) in ${(totalMs / 1000).toFixed(1)}s` : `${failures} phase(s) failed of ${phases.length}`)
  console.log(`evidence: ${EVIDENCE_FILE}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err?.stack || err)
  process.exit(3)
})
