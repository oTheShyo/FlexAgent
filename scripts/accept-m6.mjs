/**
 * M6 acceptance — real PTY via contract §4.
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 *
 * Path:
 *   terminalCreate → { terminalId }
 *   terminalInput("echo hi\n") → pty_output 含回显/输出
 *   terminalResize → 成功；无专用 resize 事件（ConPTY 经 pty_output 重绘属预期）
 *   terminalKill → pty_exit
 *   再 terminalInput → reject TERMINAL_NOT_FOUND
 *   非法 sessionId terminalCreate → reject SESSION_NOT_FOUND
 *   每 session 存活 ≤4 → 超限 TERMINAL_LIMIT
 */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'
const TIMEOUT_MS = 60_000
const MARKER = 'M6_ECHO_OK'

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
    throw new Error(d.exception?.description || d.text || `evaluate exception: ${JSON.stringify(d)}`)
  }
  return result.result?.value
}

const SETUP = `(async () => {
  if (window.__m6) return 'ready'
  const api = window.electron.codex
  const h = {
    api,
    sessionId: null,
    events: [],
    unsub: null,
    async begin(title) {
      if (h.unsub) { try { h.unsub() } catch {} h.unsub = null }
      if (h.sessionId) {
        try { await api.deleteSession(h.sessionId) } catch {}
        h.sessionId = null
      }
      const session = await api.createSession({ cwd: ${JSON.stringify(CWD)}, title })
      h.sessionId = session.id
      h.events = []
      h.unsub = api.subscribe(session.id, (e) => h.events.push(e))
      return session.id
    },
    mark() { return h.events.length },
    slice(from) { return h.events.slice(from) },
    async waitPty(from, terminalId, pred, maxMs) {
      const start = Date.now()
      while (Date.now() - start < maxMs) {
        const s = h.events.slice(from).filter(e => e.type && e.type.startsWith('pty_') && (!terminalId || e.terminalId === terminalId))
        const hit = s.find(pred)
        if (hit) return hit
        await new Promise(r => setTimeout(r, 80))
      }
      return null
    },
    async waitPtyOutputContains(from, terminalId, needle, maxMs) {
      const start = Date.now()
      let acc = ''
      while (Date.now() - start < maxMs) {
        const s = h.events.slice(from).filter(e => e.type === 'pty_output' && e.terminalId === terminalId)
        acc = s.map(e => e.data).join('')
        if (acc.includes(needle)) return { ok: true, acc }
        await new Promise(r => setTimeout(r, 80))
      }
      return { ok: false, acc }
    },
    async end() {
      if (h.unsub) { try { h.unsub() } catch {} h.unsub = null }
      const events = h.events
      h.events = []
      const sid = h.sessionId
      h.sessionId = null
      if (sid) {
        try { await api.deleteSession(sid) } catch {}
      }
      return events
    }
  }
  window.__m6 = h
  return 'installed'
})()`

async function phase(cdp, name, expr) {
  console.error(`phase ${name}...`)
  const r = await evaluate(cdp, expr)
  console.error(`phase ${name} done: ${JSON.stringify(r).slice(0, 400)}`)
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

  // ── Core M6 path ──
  const m6 = await phase(cdp, 'M6', `(async () => {
    const h = window.__m6
    const api = h.api
    const sid = await h.begin('accept-M6')
    const mark = h.mark()

    // 1) terminalCreate
    const createAck = await api.terminalCreate({ sessionId: sid, cols: 80, rows: 24 })
    const terminalId = createAck && createAck.terminalId
    if (!terminalId) return { step: 'create', fail: true, createAck }

    // 2) terminalInput → pty_output 含回显
    await api.terminalInput({ terminalId, data: 'echo ${MARKER}\\r' })
    const echo = await h.waitPtyOutputContains(mark, terminalId, '${MARKER}', 8000)

    // 3) terminalResize → 成功即可（真 PTY：ConPTY 尺寸变化可能触发 shell 重绘 pty_output，
    //    协议层不要求“字节流绝对静默”；只要求不抛错、不产生非 pty_* 协议事件）
    let resizeOkLocal = true
    let resizeErr = null
    let nonPtyAfterResize = []
    try {
      await api.terminalResize({ terminalId, cols: 100, rows: 30 })
    } catch (err) {
      resizeOkLocal = false
      resizeErr = err && (err.code || err.message) || String(err)
    }
    await new Promise(r => setTimeout(r, 200))
    nonPtyAfterResize = h.slice(mark).slice(0).filter(e => e.type && !e.type.startsWith('pty_'))

    // 4) terminalKill → pty_exit
    const beforeKill = h.mark()
    await api.terminalKill(terminalId)
    const exit = await h.waitPty(beforeKill, terminalId, e => e.type === 'pty_exit', 8000)

    // 5) 再 input → TERMINAL_NOT_FOUND
    let afterKillCode = null
    let afterKillOk = false
    try {
      await api.terminalInput({ terminalId, data: 'x' })
      afterKillOk = false
    } catch (err) {
      afterKillCode = err && err.code
      afterKillOk = err && err.code === 'TERMINAL_NOT_FOUND'
    }

    // 6) 非法 sessionId terminalCreate → SESSION_NOT_FOUND
    let badSessionCode = null
    let badSessionOk = false
    try {
      await api.terminalCreate({ sessionId: 'no-such-session-' + Date.now(), cols: 80, rows: 24 })
      badSessionOk = false
    } catch (err) {
      badSessionCode = err && err.code
      badSessionOk = err && err.code === 'SESSION_NOT_FOUND'
    }

    // 7) TERMINAL_LIMIT: 4 live → 5th fails
    const liveIds = []
    let limitCode = null
    let limitOk = false
    try {
      for (let i = 0; i < 4; i++) {
        const ack = await api.terminalCreate({ sessionId: sid, cols: 80, rows: 24 })
        liveIds.push(ack.terminalId)
      }
      try {
        await api.terminalCreate({ sessionId: sid, cols: 80, rows: 24 })
        limitOk = false
      } catch (err) {
        limitCode = err && err.code
        limitOk = err && err.code === 'TERMINAL_LIMIT'
      }
    } catch (err) {
      limitCode = err && err.code || String(err)
    } finally {
      for (const id of liveIds) {
        try { await api.terminalKill(id) } catch {}
      }
    }

    const events = await h.end()
    return {
      terminalId,
      createOk: !!terminalId,
      echoOk: echo.ok,
      echoHasMarker: echo.ok,
      echoSample: echo.acc.slice(-200),
      resizeOk: resizeOkLocal && nonPtyAfterResize.length === 0,
      resizeErr,
      nonPtyAfterResize: nonPtyAfterResize.map(e => e.type),
      exitOk: !!exit,
      exitEvent: exit ? { type: exit.type, exitCode: exit.exitCode, terminalId: exit.terminalId } : null,
      afterKillOk,
      afterKillCode,
      badSessionOk,
      badSessionCode,
      limitOk,
      limitCode,
      events
    }
  })()`)

  cdp.close()

  const { events, ...rest } = m6 || {}
  console.log(JSON.stringify({ m6: rest, eventTypes: (events || []).map(e => e.type) }, null, 2))

  const checks = {
    createOk: rest.createOk === true,
    echoOk: rest.echoOk === true && rest.echoHasMarker === true,
    resizeOk: rest.resizeOk === true,
    exitOk: rest.exitOk === true && rest.exitEvent && rest.exitEvent.type === 'pty_exit',
    afterKill: rest.afterKillOk === true && rest.afterKillCode === 'TERMINAL_NOT_FOUND',
    badSession: rest.badSessionOk === true && rest.badSessionCode === 'SESSION_NOT_FOUND',
    terminalLimit: rest.limitOk === true && rest.limitCode === 'TERMINAL_LIMIT'
  }

  console.error('CHECKS', JSON.stringify(checks))
  const pass = Object.values(checks).every(Boolean)
  if (pass) {
    console.error('ACCEPT_M6_PASS')
    process.exit(0)
  }
  console.error('ACCEPT_M6_FAIL')
  process.exit(1)
}

main().catch((err) => {
  console.error('ACCEPT_M6_ERROR', err?.stack || err)
  process.exit(4)
})
