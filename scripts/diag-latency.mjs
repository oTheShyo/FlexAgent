/**
 * Latency probe: where does the time go when creating / switching a chat?
 * Measures each renderer-level API round trip (IPC -> main -> worker -> PI).
 * Read-only apart from one throwaway scratch session that is deleted again.
 */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'

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
      }, 90000)
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
    const out = { steps: [] }
    const time = async (label, fn) => {
      const t0 = performance.now()
      let value, error
      try { value = await fn() } catch (err) { error = String((err && err.message) || err) }
      const ms = Math.round(performance.now() - t0)
      out.steps.push({ label, ms, error, value: value === undefined ? undefined : 'ok' })
      return value
    }

    const list = await time('listSessions', () => api.listSessions())
    out.sessionCount = list ? list.length : 0

    // A session other than the one the UI auto-opened: the worker has no host
    // for it, so this is the cold attach path a user hits on first click.
    const coldTarget = list && list[1] ? list[1].id : null
    const currentTarget = list && list[0] ? list[0].id : null

    if (coldTarget) {
      await time('openSession(cold, no worker host)', () => api.openSession(coldTarget))
      await time('openSession(warm, host cached)', () => api.openSession(coldTarget))
    }

    let created = null
    created = await time('createSession(scratch)', () => api.createSession({}))
    if (created) {
      await time('openSession(right after create)', () => api.openSession(created.id))
      await time('deleteSession(cleanup)', () => api.deleteSession(created.id))
    }

    if (currentTarget) {
      await time('openSession(ui-owned session again)', () => api.openSession(currentTarget))
    }

    return out
  })()`)

  console.log(JSON.stringify(report, null, 2))
  cdp.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(4) })
