/**
 * Probe: what pty events arrive in the window around terminalResize?
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'
const MARKER = 'RESIZE_PROBE_OK'

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
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, method === 'Runtime.evaluate' ? 60_000 : 15_000)
    })
  }
  close() { try { this.ws.close() } catch { /* */ } }
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
    throw new Error(d.exception?.description || d.text || 'evaluate exception')
  }
  return result.result?.value
}

async function main() {
  const deadline = Date.now() + 60_000
  let target = null
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets()
      target = pickPage(targets)
      if (target) break
    } catch { /* CDP not up */ }
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

  const report = await evaluate(cdp, `(async () => {
    const api = window.electron.codex
    const session = await api.createSession({ cwd: ${JSON.stringify(CWD)}, title: 'resize-probe' })
    const events = []
    const unsub = api.subscribe(session.id, (e) => events.push(e))
    try {
      const ack = await api.terminalCreate({ sessionId: session.id, cols: 80, rows: 24 })
      const terminalId = ack.terminalId
      await api.terminalInput({ terminalId, data: 'echo ${MARKER}\\r' })
      let acc = ''
      const t0 = Date.now()
      while (Date.now() - t0 < 8000) {
        acc = events.filter(e => e.type === 'pty_output' && e.terminalId === terminalId).map(e => e.data).join('')
        if (acc.includes('${MARKER}')) break
        await new Promise(r => setTimeout(r, 80))
      }
      let lastLen = events.length
      let stableMs = 0
      while (stableMs < 600) {
        await new Promise(r => setTimeout(r, 100))
        const n = events.length
        if (n === lastLen) stableMs += 100
        else { stableMs = 0; lastLen = n }
      }
      const beforeResize = events.length
      await api.terminalResize({ terminalId, cols: 100, rows: 30 })
      await new Promise(r => setTimeout(r, 500))
      const afterResize = events.slice(beforeResize).map(e => ({
        type: e.type,
        terminalId: e.terminalId === terminalId ? 'same' : 'other',
        data: e.type === 'pty_output' ? JSON.stringify(e.data).slice(0, 300) : e.exitCode
      }))
      try { await api.terminalKill(terminalId) } catch {}
      try { await api.deleteSession(session.id) } catch {}
      unsub()
      return { ok: true, afterResize, totalAfter: afterResize.length }
    } catch (err) {
      try { unsub() } catch {}
      try { await api.deleteSession(session.id) } catch {}
      return { ok: false, message: String(err && err.message ? err.message : err), code: err && err.code }
    }
  })()`)

  cdp.close()
  console.log(JSON.stringify(report, null, 2))
  process.exit(report && report.ok && report.totalAfter === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('PROBE_ERROR', err?.stack || err)
  process.exit(4)
})
