/** M2-style long prompt + steer settle probe (longer than accept-smoke 150s). */
const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'
const SETTLE_MS = Number(process.env.SETTLE_MS || 300000)

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
        reject(new Error(String(e?.message ?? e)))
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout ${method}`))
        }
      }, SETTLE_MS + 30000)
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

async function main() {
  const page = pickPage(await listTargets())
  if (!page) {
    console.error('no target')
    process.exit(1)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  try {
    const report = await cdp
      .send('Runtime.evaluate', {
        expression: `(async () => {
  const api = window.electron.codex
  const session = await api.createSession({ cwd: ${JSON.stringify(CWD)}, title: 'diag-m2-long' })
  const events = []
  const un = api.subscribe(session.id, (e) => events.push(e))
  const mark = 0
  const t0 = Date.now()
  const ack = await api.prompt({
    sessionId: session.id,
    text: 'Explain in detail how TCP handshakes work, with multiple paragraphs and examples.'
  })
  await new Promise((r) => setTimeout(r, 1500))
  const steerAck = await api.prompt({
    sessionId: session.id,
    text: 'Actually stop that and just reply STEERED_OK',
    mode: 'steer'
  })
  const waitStart = Date.now()
  let settled = false
  while (Date.now() - waitStart < ${SETTLE_MS}) {
    const last = [...events].reverse().find((e) => e.type === 'run_state')
    if (last && last.runState === 'idle' && Date.now() - waitStart > 500) {
      settled = true
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  const text = events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.delta)
    .join('')
  const types = {}
  for (const e of events) types[e.type] = (types[e.type] || 0) + 1
  const runStates = events.filter((e) => e.type === 'run_state').map((e) => ({ seq: e.seq, runState: e.runState, ts: e.ts }))
  un()
  await api.deleteSession(session.id).catch(() => {})
  return {
    first: ack && ack.disposition,
    steer: steerAck && steerAck.disposition,
    settled,
    waitMs: Date.now() - waitStart,
    totalMs: Date.now() - t0,
    eventCount: events.length,
    types,
    runStates,
    steerHit: text.includes('STEERED_OK'),
    textLen: text.length,
    textTail: text.slice(-80)
  }
})()`,
        awaitPromise: true,
        returnByValue: true
      })
      .then((r) => {
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval fail')
        return r.result?.value
      })
    console.log(JSON.stringify(report, null, 2))
    const pass = report.settled && report.steerHit
    console.error(pass ? 'M2_LONG_PASS' : 'M2_LONG_FAIL')
    process.exit(pass ? 0 : 1)
  } finally {
    cdp.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(4)
})
