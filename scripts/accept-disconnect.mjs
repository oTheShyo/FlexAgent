/**
 * §7.3 disconnect walkthrough — kill kernel worker → error+idle → seq reset → auto-restart → openSession reconcile.
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 * Expects: window.electron.diag.killWorker (test-only; not CodexApi).
 */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'
const TIMEOUT_MS = 90_000

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
    throw new Error(d.exception?.description || d.text || 'eval exception')
  }
  return result.result?.value
}

const SETUP = `(async () => {
  if (window.__disc) return 'ready'
  const api = window.electron.codex
  const h = {
    api,
    sessionId: null,
    all: [],
    unsub: null,
    async begin(title) {
      if (h.unsub) { try { h.unsub() } catch {} h.unsub = null }
      const session = await api.createSession({ cwd: ${JSON.stringify(CWD)}, title })
      h.sessionId = session.id
      h.all = []
      h.unsub = api.subscribe(session.id, (e) => h.all.push(e))
      return session.id
    },
    mark() { return h.all.length },
    slice(from) { return h.all.slice(from) },
    end() {
      if (h.unsub) { try { h.unsub() } catch {} h.unsub = null }
      const events = h.all
      h.all = []
      h.sessionId = null
      return events
    }
  }
  window.__disc = h
  return 'installed'
})()`

async function waitUntil(fn, maxMs, label) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (await fn()) return true
    await delay(100)
  }
  console.error(`timeout waiting: ${label}`)
  return false
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

  const hasBridge = await evaluate(
    cdp,
    '!!(window.electron && window.electron.codex && window.electron.diag && typeof window.electron.diag.killWorker === "function")'
  )
  console.error(`preload bridge+diag: ${hasBridge}`)
  if (!hasBridge) {
    cdp.close()
    console.error('FAIL: window.electron.diag.killWorker missing')
    process.exit(3)
  }

  const setup = await evaluate(cdp, SETUP)
  if (setup !== 'installed' && setup !== 'ready') {
    cdp.close()
    console.error('FAIL: setup', setup)
    process.exit(3)
  }

  // Phase A: establish session + at least one fanned-out event (so seq map knows it).
  console.error('phase A: start run...')
  const a = await evaluate(
    cdp,
    `(async () => {
      const h = window.__disc
      const sid = await h.begin('accept-disconnect')
      const mark = h.mark()
      const ack = await h.api.prompt({
        sessionId: sid,
        text: 'Reply with exactly the word READY and nothing else.'
      })
      return { sid, mark, ack }
    })()`
  )
  console.error(`phase A: ${JSON.stringify(a)}`)

  const runningOk = await waitUntil(
    async () =>
      evaluate(
        cdp,
        `(async () => {
          const h = window.__disc
          return h.slice(${a.mark}).some(e => e.type === 'run_state' && e.runState === 'running')
        })()`
      ),
    15_000,
    'run_state:running'
  )
  console.error(`running: ${runningOk}`)

  // Phase B: hard-kill worker mid-run (or after started if slow).
  console.error('phase B: kill worker...')
  const kill = await evaluate(cdp, 'window.electron.diag.killWorker()')
  console.error(`kill: ${JSON.stringify(kill)}`)
  if (!kill?.killed) {
    cdp.close()
    console.error('FAIL: killWorker returned killed=false')
    process.exit(4)
  }

  // Phase C: expect error KERNEL_INTERNAL on known session; idle if was running.
  const c = await evaluate(
    cdp,
    `(async () => {
      const h = window.__disc
      const s = h.slice(${a.mark})
      const errs = s.filter(e => e.type === 'error')
      const idles = s.filter(e => e.type === 'run_state' && e.runState === 'idle')
      const lastErr = errs[errs.length - 1] || null
      const lastIdle = [...s].reverse().find(e => e.type === 'run_state' && e.runState === 'idle') || null
      return {
        sawError: errs.length > 0,
        errCode: lastErr?.code ?? null,
        errMsg: lastErr?.message ?? null,
        sawIdle: idles.length > 0,
        idleBeforeError: lastErr && lastIdle ? lastIdle.seq <= lastErr.seq : null,
        seqBefore: s.map(e => e.seq)
      }
    })()`
  )
  console.error(`phase C (immediate): ${JSON.stringify(c)}`)

  // Recovery may be async — poll briefly for error if not yet present.
  if (!c.sawError) {
    const gotErr = await waitUntil(
      async () =>
        evaluate(
          cdp,
          `window.__disc.slice(${a.mark}).some(e => e.type === 'error' && e.code === 'KERNEL_INTERNAL')`
        ),
      5_000,
      'error KERNEL_INTERNAL'
    )
    if (gotErr) {
      Object.assign(
        c,
        await evaluate(
          cdp,
          `(async () => {
            const h = window.__disc
            const s = h.slice(${a.mark})
            const errs = s.filter(e => e.type === 'error')
            const lastErr = errs[errs.length - 1]
            const lastIdle = [...s].reverse().find(e => e.type === 'run_state' && e.runState === 'idle')
            return {
              sawError: true,
              errCode: lastErr?.code ?? null,
              sawIdle: !!lastIdle,
              idleBeforeError: lastIdle && lastErr ? lastIdle.seq <= lastErr.seq : null
            }
          })()`
        )
      )
    }
  }
  console.error(`phase C: ${JSON.stringify(c)}`)

  // Phase D: auto-restart → openSession reconcile → new prompt starts (seq from 0).
  console.error('phase D: reconcile via openSession...')
  // Worker restart is immediate in recoverFromWorkerLoss; brief settle.
  await delay(500)

  const d = await evaluate(
    cdp,
    `(async () => {
      const h = window.__disc
      const sid = h.sessionId
      let openOk = false
      let openCode = null
      let messages = null
      try {
        const detail = await h.api.openSession(sid)
        openOk = true
        messages = Array.isArray(detail.messages) ? detail.messages.length : null
      } catch (err) {
        openCode = err?.code || String(err?.message || err)
      }
      if (!openOk) return { openOk, openCode, promptAfter: null }

      const mark = h.mark()
      let ack = null
      let promptCode = null
      try {
        ack = await h.api.prompt({
          sessionId: sid,
          text: 'Reply with exactly the word AFTER_OK and nothing else.'
        })
      } catch (err) {
        promptCode = err?.code || String(err?.message || err)
      }
      return { openOk, messages, mark, ack, promptCode, sid }
    })()`
  )
  console.error(`phase D: ${JSON.stringify(d)}`)

  if (!d.openOk) {
    cdp.close()
    console.error('FAIL: openSession after restart', d.openCode)
    process.exit(5)
  }
  if (!d.ack || d.ack.disposition !== 'started') {
    cdp.close()
    console.error('FAIL: prompt after restart', d.ack || d.promptCode)
    process.exit(6)
  }

  // First event after seq.clear must be seq 0 (fresh map for this session).
  const postKillMark = a.mark
  const seqAfter = await evaluate(
    cdp,
    `(async () => {
      const h = window.__disc
      const s = h.slice(${postKillMark})
      // events after recovery: find first run_state running from the second prompt
      // more robust: last run_state running's seq, and whether any seq is 0 after the kill error
      const errIdx = s.findIndex(e => e.type === 'error' && e.code === 'KERNEL_INTERNAL')
      const after = errIdx >= 0 ? s.slice(errIdx + 1) : []
      const seqs = after.map(e => e.seq)
      return {
        errIdx,
        afterCount: after.length,
        seqs: seqs.slice(0, 20),
        startsAtZero: seqs.length > 0 ? seqs[0] === 0 : null,
        gaplessAfter: seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1)
      }
    })()`
  )
  console.error(`seq after kill: ${JSON.stringify(seqAfter)}`)

  // Wait for second prompt to at least emit running (or settle) — proves worker is alive.
  const alive = await waitUntil(
    async () =>
      evaluate(
        cdp,
        `(async () => {
          const h = window.__disc
          const s = h.slice(${d.mark ?? 0})
          return s.some(e => e.type === 'run_state' && e.runState === 'running') ||
            s.some(e => e.type === 'message_end')
        })()`
      ),
    20_000,
    'post-restart activity'
  )
  console.error(`worker alive after restart: ${alive}`)

  // Summary checks (kernel-side §7.3).
  const checks = {
    killed: !!kill?.killed,
    sawError: !!c.sawError,
    errCodeIsKernelInternal: c.errCode === 'KERNEL_INTERNAL',
    idleIfRunning: runningOk ? !!c.sawIdle : true,
    openSessionOk: !!d.openOk,
    promptStarted: d.ack?.disposition === 'started',
    seqResetsAfterError: seqAfter.startsAtZero !== false,
    workerAlive: !!alive
  }
  console.error('CHECKS', JSON.stringify(checks, null, 2))

  const pass = Object.values(checks).every(Boolean)
  cdp.close()
  if (pass) {
    console.error('ACCEPT_DISCONNECT_PASS')
    process.exit(0)
  }
  console.error('ACCEPT_DISCONNECT_FAIL')
  process.exit(1)
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
