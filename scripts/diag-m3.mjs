/** M3-only red/green: first prompt + followUp queue → settle + QUEUED_OK before idle. */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'
const FIRST_WAIT_MS = 180_000
const FIRST_ONLY_MS = 90_000

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
      const onOpen = () => { cleanup(); resolve() }
      const onError = (e) => { cleanup(); reject(new Error(String(e?.message ?? e))) }
      const cleanup = () => {
        this.ws.removeEventListener('open', onOpen)
        this.ws.removeEventListener('error', onError)
      }
      this.ws.addEventListener('open', onOpen)
      this.ws.addEventListener('error', onError)
    })
    this.ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, method === 'Runtime.evaluate' ? 300_000 : 30_000)
    })
  }
  close() { try { this.ws.close() } catch { /* */ } }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  })
  if (result.exceptionDetails) {
    const d = result.exceptionDetails
    throw new Error(d.exception?.description || d.text || 'eval exception')
  }
  return result.result?.value
}

async function main() {
  const mode = process.argv[2] || 'full' // 'full' | 'first-only'
  const targets = await listTargets()
  const target = pickPage(targets)
  if (!target) { console.error('no CDP target'); process.exit(2) }
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')

  const firstWait = mode === 'first-only' ? FIRST_ONLY_MS : FIRST_WAIT_MS
  const r = await evaluate(cdp, `(async () => {
    const api = window.electron.codex
    const sid = (await api.createSession({ cwd: ${JSON.stringify(CWD)}, title: 'diag-m3' })).id
    const events = []
    const unsub = api.subscribe(sid, e => events.push({ ...e, _t: Date.now() }))
    const t0 = Date.now()
    const ack1 = await api.prompt({
      sessionId: sid,
      text: 'Write a long story about a robot gardener, at least 150 words.'
    })
    await new Promise(r => setTimeout(r, 400))
    let ack2 = null
    ${mode === 'first-only' ? '' : `
    ack2 = await api.prompt({
      sessionId: sid,
      text: 'When that finishes, reply with exactly: QUEUED_OK',
      mode: 'followUp'
    })
    `}
    let sawRunning = false
    let sawIdle = false
    let idleAt = null
    const answered = new Set()
    const start = Date.now()
    const waitMs = ${firstWait}
    while (Date.now() - start < waitMs) {
      const s = events.filter(e => e.type === 'run_state')
      if (s.some(e => e.runState === 'running')) sawRunning = true
      for (const e of events) {
        if (e.type === 'permission_request' && !answered.has(e.toolCallId)) {
          answered.add(e.toolCallId)
          try {
            await api.respondPermission({ sessionId: sid, toolCallId: e.toolCallId, decision: 'allowSession' })
          } catch {}
        }
      }
      const last = [...s].pop()
      if (sawRunning && last && last.runState === 'idle') {
        sawIdle = true
        idleAt = Date.now() - t0
        break
      }
      await new Promise(r => setTimeout(r, 150))
    }
    const text = events.map(e => {
      if (e.type === 'text_delta') return e.delta
      if (e.type === 'message_end' && e.message?.role === 'assistant') return e.message.content || ''
      return ''
    }).join('')
    const idleIdx = events.findIndex(e => e.type === 'run_state' && e.runState === 'idle')
    const userMsgs = events.filter(e => e.type === 'user_message')
    const followUpUserBeforeIdle =
      ${mode === 'first-only' ? 'null' : `
      userMsgs.length >= 2 && idleIdx >= 0 && events.indexOf(userMsgs[1]) < idleIdx
      `}
    unsub()
    try { await api.deleteSession(sid) } catch {}
    return {
      mode: ${JSON.stringify(mode)},
      ack1: ack1 && ack1.disposition,
      ack2: ack2 && ack2.disposition,
      sawRunning,
      sawIdle,
      idleAtMs: idleAt,
      totalMs: Date.now() - t0,
      eventCount: events.length,
      types: [...new Set(events.map(e => e.type))],
      runStates: events.filter(e => e.type === 'run_state').map(e => e.runState),
      userMessageCount: userMsgs.length,
      queuedHit: ${mode === 'first-only' ? 'null' : `text.includes('QUEUED_OK')`},
      followUpUserBeforeIdle,
      assistantTail: text.slice(-160),
      timeline: events.slice(0, 40).map(e => ({
        dt: e._t - t0,
        seq: e.seq,
        type: e.type,
        runState: e.runState,
        role: e.message && e.message.role,
        content: e.message && (e.message.content || '').slice(0, 60)
      }))
    }
  })()`)

  console.log(JSON.stringify(r, null, 2))
  cdp.close()

  let pass
  if (mode === 'first-only') {
    pass = r.ack1 === 'started' && r.sawRunning && r.sawIdle
    console.error(pass ? 'M3_FIRST_ONLY_PASS' : 'M3_FIRST_ONLY_FAIL')
  } else {
    pass =
      r.ack1 === 'started' &&
      r.ack2 === 'queued' &&
      r.sawIdle &&
      r.queuedHit === true &&
      r.userMessageCount >= 2 &&
      r.followUpUserBeforeIdle === true
    console.error(pass ? 'M3_FULL_PASS' : 'M3_FULL_FAIL')
  }
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(4) })
