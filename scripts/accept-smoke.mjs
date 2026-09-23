/**
 * §5 acceptance smoke — one session per phase (avoids cross-phase run-state coupling).
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'
const TIMEOUT_MS = 60_000
const ERROR_CODES = new Set([
  'SESSION_NOT_FOUND',
  'SESSION_BUSY',
  'INVALID_INPUT',
  'PERMISSION_EXPIRED',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_LIMIT',
  'KERNEL_INTERNAL'
])

async function listTargets() {
  const res = await fetch(`${CDP_HTTP}/json`)
  if (!res.ok) throw new Error(`CDP /json ${res.status}`)
  return res.json()
}

function pickPage(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!pages.length) return null
  return pages.find((t) => /5173|flex-agent|localhost/i.test(t.url)) || pages[0]
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (e) => {
        cleanup()
        reject(new Error(`ws open failed: ${e?.message ?? e}`))
      }
      const cleanup = () => {
        this.ws.removeEventListener('open', onOpen)
        this.ws.removeEventListener('error', onError)
      }
      this.ws.addEventListener('open', onOpen)
      this.ws.addEventListener('error', onError)
    })
    this.ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    const timeoutMs = method === 'Runtime.evaluate' ? 300_000 : 30_000
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, timeoutMs)
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (result.exceptionDetails) {
    const d = result.exceptionDetails
    throw new Error(d.exception?.description || d.text || `evaluate exception: ${JSON.stringify(d)}`)
  }
  return result.result?.value
}

function collectInvariants(events) {
  if (!events || events.length === 0) {
    return {
      eventCount: 0,
      gapless: false,
      continuousFromZero: false,
      seqStart: null,
      seqEnd: null,
      idsMatch: false,
      errorCount: 0,
      badCodes: [],
      hasColonMarkers: false,
      types: []
    }
  }
  const seqs = events.map((e) => e.seq)
  const gapless = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)
  const idsMatch = events.every((e) => e.sessionId === events[0].sessionId)
  const errors = events.filter((e) => e.type === 'error')
  const badCodes = errors.filter((e) => !ERROR_CODES.has(e.code))
  const text = events
    .map((e) => {
      if (e.type === 'text_delta') return e.delta
      if (e.type === 'message_end') return e.message?.role === 'assistant' ? e.message.content || '' : ''
      return ''
    })
    .join('')
  const hasColonMarkers = text.includes('::tool::') || text.includes('::error::')
  return {
    eventCount: events.length,
    gapless,
    continuousFromZero: gapless && seqs[0] === 0,
    seqStart: seqs[0],
    seqEnd: seqs[seqs.length - 1],
    idsMatch,
    errorCount: errors.length,
    badCodes: badCodes.map((e) => e.code),
    hasColonMarkers,
    types: [...new Set(events.map((e) => e.type))]
  }
}

/**
 * Page harness: each begin() creates a fresh session + subscription.
 * end() returns events for that session slice only.
 */
const SETUP = `(async () => {
  if (window.__acc2) return 'ready'
  const api = window.electron.codex
  const h = {
    api,
    sessionId: null,
    all: [],
    unsub: null,
    async begin(title) {
      if (h.unsub) { try { h.unsub() } catch {} h.unsub = null }
      if (h.sessionId) {
        try { await api.deleteSession(h.sessionId) } catch {}
        h.sessionId = null
      }
      const session = await api.createSession({ cwd: ${JSON.stringify(CWD)}, title })
      h.sessionId = session.id
      h.all = []
      h.unsub = api.subscribe(session.id, (e) => h.all.push(e))
      return session.id
    },
    mark() { return h.all.length },
    slice(from) { return h.all.slice(from) },
      async waitIdle(from, maxMs) {
      const start = Date.now()
      let sawRunning = false
      const answered = new Set()
      while (Date.now() - start < maxMs) {
        const s = h.all.slice(from)
        if (s.some(e => e.type === 'run_state' && e.runState === 'running')) sawRunning = true
        for (const e of s) {
          if (e.type === 'permission_request' && !answered.has(e.toolCallId)) {
            answered.add(e.toolCallId)
            try {
              await api.respondPermission({ sessionId: h.sessionId, toolCallId: e.toolCallId, decision: 'allowSession' })
            } catch {}
          }
        }
        if (sawRunning && s.some(e => e.type === 'run_state' && e.runState === 'idle')) return true
        await new Promise(r => setTimeout(r, 120))
      }
      return false
    },
    async waitRunning(from, maxMs) {
      const start = Date.now()
      while (Date.now() - start < maxMs) {
        const last = [...h.all].reverse().find(e => e.type === 'run_state')
        if (last && last.runState === 'running') return true
        await new Promise(r => setTimeout(r, 80))
      }
      return false
    },
    async waitPermission(from, maxMs) {
      const start = Date.now()
      while (Date.now() - start < maxMs) {
        const p = h.all.slice(from).find(e => e.type === 'permission_request')
        if (p) return p
        await new Promise(r => setTimeout(r, 120))
      }
      return null
    },
    async waitIdleAutoAllow(from, maxMs, decision) {
      const start = Date.now()
      let sawRunning = false
      const answered = new Set()
      while (Date.now() - start < maxMs) {
        const s = h.all.slice(from)
        if (s.some(e => e.type === 'run_state' && e.runState === 'running')) sawRunning = true
        for (const e of s) {
          if (e.type === 'permission_request' && !answered.has(e.toolCallId)) {
            answered.add(e.toolCallId)
            try {
              await api.respondPermission({ sessionId: h.sessionId, toolCallId: e.toolCallId, decision })
            } catch {}
          }
        }
        if (sawRunning && s.some(e => e.type === 'run_state' && e.runState === 'idle')) {
          return { settled: true, answered: [...answered] }
        }
        await new Promise(r => setTimeout(r, 120))
      }
      return { settled: false, answered: [...answered] }
    },
    assistantText(from) {
      return h.all.slice(from).map(e => {
        if (e.type === 'text_delta') return e.delta
        if (e.type === 'message_end' && e.message && e.message.role === 'assistant') return e.message.content || ''
        return ''
      }).join('')
    },
    async end() {
      if (h.unsub) { try { h.unsub() } catch {} h.unsub = null }
      const events = h.all
      h.all = []
      const sid = h.sessionId
      h.sessionId = null
      if (sid) {
        try { await api.deleteSession(sid) } catch {}
      }
      return events
    }
  }
  window.__acc2 = h
  return 'installed'
})()`

async function phase(cdp, name, expr) {
  console.error(`phase ${name}...`)
  const r = await evaluate(cdp, expr)
  console.error(`phase ${name} done: ${JSON.stringify(r).slice(0, 260)}`)
  return r
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS
  let target = null
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets()
      target = pickPage(targets)
      if (target) break
    } catch {
      /* CDP not up */
    }
    await delay(500)
  }
  if (!target) {
    console.error('FAIL: no CDP page target')
    process.exit(2)
  }
  console.error(`target: ${target.url}`)

  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')

  let hasBridge = false
  while (Date.now() < deadline) {
    hasBridge = await evaluate(cdp, '!!(window.electron && window.electron.codex)')
    if (hasBridge) break
    await delay(300)
  }
  console.error(`preload bridge: ${hasBridge}`)
  if (!hasBridge) {
    cdp.close()
    console.error('FAIL: window.electron.codex missing')
    process.exit(3)
  }

  const setup = await phase(cdp, 'setup', SETUP)
  if (setup !== 'installed' && setup !== 'ready') {
    cdp.close()
    console.error('FAIL: setup', setup)
    process.exit(3)
  }

  // ── M1: idle prompt → stream → file_changes → idle ──
  const m1 = await phase(cdp, 'M1', `(async () => {
    const h = window.__acc2
    const sid = await h.begin('accept-M1')
    const mark = h.mark()
    const t0 = Date.now()
    const ack = await h.api.prompt({
      sessionId: sid,
      text: 'Write a file named accept_probe.txt containing exactly ACCEPT_OK, then reply with ACCEPT_OK.'
    })
    const ackMs = Date.now() - t0
    const wait = await h.waitIdleAutoAllow(mark, 120000, 'allowSession')
    const events = await h.end()
    const text = events.map(e => e.type === 'text_delta' ? e.delta : (e.type === 'message_end' && e.message && e.message.role === 'assistant' ? e.message.content || '' : '')).join('')
    return {
      disposition: ack && ack.disposition,
      ackMs,
      answered: wait.answered,
      settled: wait.settled,
      expectHit: text.includes('ACCEPT_OK'),
      fileChangesSeen: events.some(e => e.type === 'file_changes' && e.files && e.files.length > 0),
      events
    }
  })()`)

  // ── M5: abort mid-run → idle → re-prompt started ──
  const m5 = await phase(cdp, 'M5', `(async () => {
    const h = window.__acc2
    const sid = await h.begin('accept-M5')
    const mark = h.mark()
    const ack = await h.api.prompt({
      sessionId: sid,
      text: 'Count slowly from 1 to 400, one number per line, think carefully between each.'
    })
    const wasRunning = await h.waitRunning(mark, 10000)
    if (wasRunning) await h.api.abort(sid)
    const settledAfterAbort = await h.waitIdle(mark, 20000)
    const mark2 = h.mark()
    const ack2 = await h.api.prompt({ sessionId: sid, text: 'Reply with exactly: AFTER_ABORT' })
    const rePromptSettled = await h.waitIdle(mark2, 60000)
    const rePromptHit = h.assistantText(mark2).includes('AFTER_ABORT')
    const events = await h.end()
    return {
      abortDisposition: ack && ack.disposition,
      wasRunning,
      settledAfterAbort,
      rePromptDisposition: ack2 && ack2.disposition,
      rePromptSettled,
      rePromptHit,
      events
    }
  })()`)

  // ── M4: permission gate zero-tool-until-respond + deny → tool_end isError ──
  const m4 = await phase(cdp, 'M4', `(async () => {
    const h = window.__acc2
    const sid = await h.begin('accept-M4')
    const mark = h.mark()
    const ack = await h.api.prompt({
      sessionId: sid,
      text: 'Run the shell command: echo PERMISSION_DEMO'
    })
    const perm = await h.waitPermission(mark, 60000)
    if (!perm) {
      const events = await h.end()
      return { disposition: ack && ack.disposition, hadPermission: false, events }
    }
    const afterPerm = h.all.filter(e => e.seq >= perm.seq && e.toolCallId === perm.toolCallId)
    const toolEventsBeforeRespond = afterPerm.filter(e =>
      e.type === 'tool_start' || e.type === 'tool_update' || e.type === 'tool_end'
    ).length
    await h.api.respondPermission({ sessionId: sid, toolCallId: perm.toolCallId, decision: 'deny' })
    const settledAfterDeny = await h.waitIdle(mark, 90000)
    const toolEnd = h.all.find(e => e.type === 'tool_end' && e.toolCallId === perm.toolCallId)
    const events = await h.end()
    return {
      disposition: ack && ack.disposition,
      hadPermission: true,
      toolEventsBeforeRespond,
      toolEndIsError: toolEnd ? toolEnd.isError === true : null,
      settledAfterDeny,
      events
    }
  })()`)

  // ── M2: steer while running ──
  const m2 = await phase(cdp, 'M2', `(async () => {
    const h = window.__acc2
    const sid = await h.begin('accept-M2')
    const mark = h.mark()
    const ack = await h.api.prompt({
      sessionId: sid,
      text: 'Explain in detail how TCP handshakes work, with multiple paragraphs and examples.'
    })
    await h.waitRunning(mark, 10000)
    const ackSteer = await h.api.prompt({
      sessionId: sid,
      text: 'Actually stop that and just reply STEERED_OK',
      mode: 'steer'
    })
    // Steer delivers after the current tool batch / turn end — allow a long first turn.
    const settled = await h.waitIdle(mark, 150000)
    const steerHit = h.assistantText(mark).includes('STEERED_OK')
    const userMessageCount = h.all.slice(mark).filter(e => e.type === 'user_message').length
    const events = await h.end()
    return {
      firstDisposition: ack && ack.disposition,
      steerDisposition: ackSteer && ackSteer.disposition,
      settled,
      userMessageCount,
      steerHit,
      events
    }
  })()`)

  // ── M3: followUp queued while running ──
  const m3 = await phase(cdp, 'M3', `(async () => {
    const h = window.__acc2
    const sid = await h.begin('accept-M3')
    const mark = h.mark()
    const ack = await h.api.prompt({
      sessionId: sid,
      text: 'Write a long story about a robot gardener, at least 150 words.'
    })
    await h.waitRunning(mark, 10000)
    const ackQ = await h.api.prompt({
      sessionId: sid,
      text: 'When that finishes, reply with exactly: QUEUED_OK',
      mode: 'followUp'
    })
    // PI drains followUp inside the same agent run (no intermediate idle→running edge).
    // Contract M3: queued ack + user_message before final idle + followUp text + settle.
    const settled = await h.waitIdle(mark, 150000)
    const queuedHit = h.assistantText(mark).includes('QUEUED_OK')
    const events = await h.end()
    const idleIdx = events.findIndex(e => e.type === 'run_state' && e.runState === 'idle')
    const userMsgs = events.filter(e => e.type === 'user_message')
    const followUpUserBeforeIdle =
      userMsgs.length >= 2 &&
      idleIdx >= 0 &&
      events.indexOf(userMsgs[1]) < idleIdx
    return {
      firstDisposition: ack && ack.disposition,
      queueDisposition: ackQ && ackQ.disposition,
      settled,
      queuedHit,
      userMessageCount: userMsgs.length,
      followUpUserBeforeIdle,
      events
    }
  })()`)

  cdp.close()

  const summarize = (p) => {
    if (!p) return null
    const { events, ...rest } = p
    return { ...rest, inv: collectInvariants(events) }
  }

  const report = {
    phases: {
      M1: summarize(m1),
      M5: summarize(m5),
      M4: summarize(m4),
      M2: summarize(m2),
      M3: summarize(m3)
    }
  }
  console.log(JSON.stringify(report, null, 2))

  const M1 = report.phases.M1
  const M5 = report.phases.M5
  const M4 = report.phases.M4
  const M2 = report.phases.M2
  const M3 = report.phases.M3

  // Each phase is its own session → seq must start at 0 and be gapless (§5.4).
  const invOk = (inv) =>
    inv && inv.gapless && inv.continuousFromZero && inv.idsMatch &&
    inv.badCodes.length === 0 && !inv.hasColonMarkers

  const checks = {
    M1:
      M1 &&
      M1.disposition === 'started' &&
      M1.ackMs < 2000 &&
      M1.settled &&
      M1.expectHit &&
      M1.fileChangesSeen &&
      invOk(M1.inv),
    M5:
      M5 &&
      M5.abortDisposition === 'started' &&
      M5.wasRunning &&
      M5.settledAfterAbort &&
      M5.rePromptDisposition === 'started' &&
      M5.rePromptSettled &&
      M5.rePromptHit &&
      invOk(M5.inv),
    M4:
      M4 &&
      M4.hadPermission &&
      M4.toolEventsBeforeRespond === 0 &&
      M4.toolEndIsError === true &&
      M4.settledAfterDeny &&
      invOk(M4.inv),
    M2:
      M2 &&
      M2.firstDisposition === 'started' &&
      M2.steerDisposition === 'steering' &&
      M2.settled &&
      M2.steerHit &&
      M2.userMessageCount >= 2 &&
      invOk(M2.inv),
    M3:
      M3 &&
      M3.firstDisposition === 'started' &&
      M3.queueDisposition === 'queued' &&
      M3.settled &&
      M3.queuedHit &&
      M3.userMessageCount >= 2 &&
      M3.followUpUserBeforeIdle &&
      invOk(M3.inv)
  }

  console.error('CHECKS', JSON.stringify(checks))

  const pass = Object.values(checks).every(Boolean)
  if (pass) {
    console.error('ACCEPT_SMOKE_PASS')
    process.exit(0)
  }
  console.error('ACCEPT_SMOKE_FAIL')
  process.exit(1)
}

main().catch((err) => {
  console.error('ACCEPT_SMOKE_ERROR', err?.stack || err)
  process.exit(4)
})
