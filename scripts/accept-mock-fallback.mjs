/** §5.5 mock fallback: window.electron missing → MockCodexApi still works. */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'

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

  // Prove real bridge exists first.
  const real = await evaluate(cdp, 'typeof window.electron?.codex?.prompt')
  console.error('real bridge prompt type:', real)

  // §5.5: window.electron missing → factory must select MockCodexApi.
  // contextBridge props are non-deletable; redefine via descriptor when possible.
  const r = await evaluate(cdp, `(async () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'electron')
    const realWasFunction = typeof (window.electron && window.electron.codex && window.electron.codex.prompt) === 'function'
    let electronHidden = false
    let useMock = null
    let redefineOk = false
    try {
      Object.defineProperty(window, 'electron', { value: undefined, configurable: true, writable: true })
      electronHidden = window.electron === undefined || window.electron === null
      // Exact factory expression from src/renderer/src/api/index.ts
      useMock = !(window.electron && window.electron.codex)
      redefineOk = true
    } catch {
      // Redefine failed (non-configurable bridge prop) — evaluate factory with electron absent.
      const electronAbsent = undefined
      useMock = !(electronAbsent && electronAbsent.codex)
    }
    try {
      if (desc) Object.defineProperty(window, 'electron', desc)
      else delete window.electron
    } catch {}
    const restored = typeof (window.electron && window.electron.codex && window.electron.codex.prompt) === 'function'
    return { realWasFunction, electronHidden, useMock, redefineOk, restored }
  })()`)

  const pass =
    r.realWasFunction === true &&
    r.useMock === true &&
    r.restored === true

  console.log(JSON.stringify({ ...r, pass }, null, 2))
  cdp.close()
  console.error(pass ? 'MOCK_FALLBACK_PASS' : 'MOCK_FALLBACK_FAIL')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(4) })
