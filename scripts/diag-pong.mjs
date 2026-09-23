/** Minimal LLM settle diagnostic: one short prompt, measure time to idle. */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'

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
      }, method === 'Runtime.evaluate' ? 150_000 : 30_000)
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
  const targets = await listTargets()
  const target = pickPage(targets)
  if (!target) { console.error('no target'); process.exit(2) }
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')

  const r = await evaluate(cdp, `(async () => {
    const api = window.electron.codex
    const sid = (await api.createSession({ cwd: ${JSON.stringify(CWD)}, title: 'diag-settle' })).id
    const events = []
    const unsub = api.subscribe(sid, e => events.push(e))
    const t0 = Date.now()
    const ack = await api.prompt({ sessionId: sid, text: 'Say exactly: PONG' })
    let idle = false
    const start = Date.now()
    while (Date.now() - start < 60000) {
      const sawRun = events.some(e => e.type === 'run_state' && e.runState === 'running')
      const sawIdle = events.some(e => e.type === 'run_state' && e.runState === 'idle')
      if (sawRun && sawIdle) { idle = true; break }
      await new Promise(r => setTimeout(r, 100))
    }
    const ms = Date.now() - t0
    unsub()
    try { await api.deleteSession(sid) } catch {}
    const text = events.map(e => e.type === 'text_delta' ? e.delta : (e.type === 'message_end' && e.message?.role === 'assistant' ? e.message.content || '' : '')).join('')
    return {
      disposition: ack?.disposition,
      idle,
      ms,
      eventCount: events.length,
      types: [...new Set(events.map(e => e.type))],
      hasPong: text.includes('PONG'),
      textTail: text.slice(-120)
    }
  })()`)
  console.log(JSON.stringify(r, null, 2))
  cdp.close()
  process.exit(r.idle && r.hasPong ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(4) })
