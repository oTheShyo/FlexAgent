/** Minimal diagnose: prompt → event dump → check settle */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'

async function listTargets() {
  const res = await fetch(`${CDP_HTTP}/json`)
  return res.json()
}

function pickPage(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
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
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
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
          reject(new Error(`timeout ${method}`))
        }
      }, 70000)
    })
  }
  close() { try { this.ws.close() } catch {} }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result?.value
}

async function main() {
  let target = null
  for (let i = 0; i < 30; i++) {
    try {
      target = pickPage(await listTargets())
      if (target) break
    } catch {}
    await delay(500)
  }
  if (!target) { console.error('no target'); process.exit(2) }

  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')

  const report = await evaluate(cdp, `(async () => {
    const api = window.electron.codex
    const session = await api.createSession({ cwd: ${JSON.stringify(CWD)}, title: 'diag' })
    const events = []
    const un = api.subscribe(session.id, e => events.push(e))
    const t0 = Date.now()
    const ack = await api.prompt({ sessionId: session.id, text: 'Reply with exactly: DIAG_OK' })
    const ackMs = Date.now() - t0
    const start = Date.now()
    let sawRunning = false
    while (Date.now() - start < 45000) {
      if (events.some(e => e.type === 'run_state' && e.runState === 'running')) sawRunning = true
      const last = [...events].reverse().find(e => e.type === 'run_state')
      if (sawRunning && last && last.runState === 'idle') break
      await new Promise(r => setTimeout(r, 200))
    }
    un()
    return {
      disposition: ack && ack.disposition,
      ackMs,
      sawRunning,
      ms: Date.now() - t0,
      count: events.length,
      events: events.map(e => ({ seq: e.seq, type: e.type, runState: e.runState, deltaLen: e.delta && e.delta.length, role: e.message && e.message.role, content: e.message && (e.message.content || '').slice(0, 80) }))
    }
  })()`)

  console.log(JSON.stringify(report, null, 2))
  cdp.close()
  const lastRun = [...report.events].reverse().find(e => e.type === 'run_state')
  const pass = report.disposition === 'started' && report.sawRunning && lastRun && lastRun.runState === 'idle'
  console.error(pass ? 'DIAG_PASS' : 'DIAG_FAIL', 'lastRun=', JSON.stringify(lastRun))
  process.exit(pass ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(4) })
