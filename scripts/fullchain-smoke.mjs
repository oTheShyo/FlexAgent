/**
 * Full-chain smoke against the running Electron renderer via CDP.
 * Steps: listSessions → createSession → subscribe → prompt → assert events.
 */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'
const PROMPT = 'Reply with exactly: FULLCHAIN_OK'
const EXPECT = 'FULLCHAIN_OK'
const TIMEOUT_MS = 60_000

async function listTargets() {
  const res = await fetch(`${CDP_HTTP}/json`)
  if (!res.ok) throw new Error(`CDP /json ${res.status}`)
  return res.json()
}

function pickPage(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!pages.length) return null
  // Prefer the app page (vite localhost or file)
  return (
    pages.find((t) => /5173|flex-agent|localhost/i.test(t.url)) || pages[0]
  )
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
    this.events = []
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
        return
      }
      this.events.push(msg)
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    const timeoutMs = method === 'Runtime.evaluate' ? 90_000 : 30_000
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
    throw new Error(
      d.exception?.description || d.text || `evaluate exception: ${JSON.stringify(d)}`
    )
  }
  return result.result?.value
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
      /* CDP not up yet */
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

  // Wait for preload
  let hasBridge = false
  while (Date.now() < deadline) {
    hasBridge = await evaluate(cdp, '!!(window.electron && window.electron.codex)')
    if (hasBridge) break
    await delay(300)
  }
  console.error(`preload bridge: ${hasBridge}`)
  if (!hasBridge) {
    cdp.close()
    console.error('FAIL: window.electron.codex missing (mock-only renderer?)')
    process.exit(3)
  }

  const smokeExpr = `(async () => {
    const api = window.electron.codex
    const events = []
    let un = null
    let session = null
    const t0 = Date.now()
    try {
      const listed0 = await api.listSessions()
      session = await api.createSession({ cwd: ${JSON.stringify(CWD)}, title: 'fullchain-smoke' })
      un = api.subscribe(session.id, (e) => { events.push(e) })
      const ack = await api.prompt({ sessionId: session.id, text: ${JSON.stringify(PROMPT)} })

      const startedAt = Date.now()
      let settled = false
      let sawRunning = false
      while (Date.now() - startedAt < 55000) {
        const idle = events.some(e => e.type === 'run_state' && e.runState === 'idle' && e.seq > 0)
        const running = events.some(e => e.type === 'run_state' && e.runState === 'running')
        if (running) sawRunning = true
        const lastIdle = [...events].reverse().find(e => e.type === 'run_state' && e.runState === 'idle')
        if (sawRunning && lastIdle) { settled = true; break }
        // also break if error-only settle without running (auth fail path)
        if (events.some(e => e.type === 'error') && !sawRunning && Date.now() - startedAt > 8000) {
          break
        }
        await new Promise(r => setTimeout(r, 200))
      }

      const types = [...new Set(events.map(e => e.type))]
      const deltas = events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')
      const finals = events.filter(e => e.type === 'message_end')
      const assistant = finals.filter(e => e.message && e.message.role === 'assistant')
      const seqs = events.map(e => e.seq)
      const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1])
      const idsMatch = events.every(e => e.sessionId === session.id)
      const errors = events.filter(e => e.type === 'error')

      return {
        ok: true,
        listedBefore: Array.isArray(listed0) ? listed0.length : null,
        sessionId: session.id,
        disposition: ack && ack.disposition,
        settled,
        sawRunning,
        types,
        textLen: deltas.length,
        finalAssistant: assistant.map(m => m.message.content).slice(-1)[0] || '',
        expectHit: (deltas.includes(${JSON.stringify(EXPECT)}) ||
          assistant.some(m => (m.message.content || '').includes(${JSON.stringify(EXPECT)}))),
        monotonic,
        idsMatch,
        errors,
        ms: Date.now() - t0,
        eventCount: events.length
      }
    } catch (err) {
      return {
        ok: false,
        thrown: String(err && err.message ? err.message : err),
        code: err && err.code,
        types: [...new Set(events.map(e => e.type))],
        eventCount: events.length,
        ms: Date.now() - t0
      }
    } finally {
      if (un) { try { un() } catch {} }
      if (session) { try { await api.deleteSession(session.id) } catch {} }
    }
  })()`

  const report = await evaluate(cdp, smokeExpr)
  cdp.close()

  console.log(JSON.stringify(report, null, 2))

  const pass =
    report &&
    report.ok === true &&
    report.disposition === 'started' &&
    report.sawRunning &&
    report.settled &&
    report.expectHit &&
    report.monotonic &&
    report.idsMatch &&
    (!report.errors || report.errors.length === 0) &&
    Array.isArray(report.types) &&
    report.types.includes('run_state') &&
    report.types.includes('user_message') &&
    report.types.includes('message_end')

  if (pass) {
    console.error('FULLCHAIN_SMOKE_PASS')
    process.exit(0)
  }
  console.error('FULLCHAIN_SMOKE_FAIL')
  process.exit(1)
}

main().catch((err) => {
  console.error('FULLCHAIN_SMOKE_ERROR', err?.stack || err)
  process.exit(4)
})
