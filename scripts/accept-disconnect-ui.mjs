/**
 * §7.3 UI walkthrough — same kill scenario, observe renderer disconnect UX.
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 * Checks:
 *   1) during kill: [data-testid=connection-banner] shows "Connection lost"
 *   2) chat shows [data-testid=error-block] with KERNEL_INTERNAL
 *   3) after auto-reconcile: banner shows "Reconnected" then clears (or Retry works)
 *   4) session still usable (composer enabled / no ErrorBoundary crash)
 */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
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
      }, method === 'Runtime.evaluate' ? 120_000 : 30_000)
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
    throw new Error(d.exception?.description || d.text || 'eval exception')
  }
  return result.result?.value
}

async function waitUntil(fn, maxMs, label) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (await fn()) return true
    await delay(150)
  }
  console.error(`timeout: ${label}`)
  return false
}

const SNAPSHOT = `(() => {
  const banner = document.querySelector('[data-testid="connection-banner"]')
  const errors = [...document.querySelectorAll('[data-testid="error-block"]')].map(el => ({
    code: (el.querySelector('span') || {}).textContent || '',
    message: (el.querySelector('p') || {}).textContent || ''
  }))
  const boundary = !!document.querySelector('[data-testid="error-boundary"]')
  const composer = document.querySelector('[data-testid="composer"] textarea, [data-testid="composer"] [contenteditable="true"], textarea')
  const sendBtn = document.querySelector('[data-testid="composer"] button[aria-label*="Send"], button[aria-label="Send message"], button[aria-label="Queue message"]')
  return {
    bannerText: banner ? (banner.textContent || '').trim() : null,
    hasBanner: !!banner,
    errorBlocks: errors,
    hasKernelInternalError: errors.some(e => e.code.includes('KERNEL_INTERNAL')),
    errorBoundary: boundary,
    composerPresent: !!composer,
    sendEnabled: sendBtn ? !sendBtn.disabled : null
  }
})()`

async function main() {
  const deadline = Date.now() + TIMEOUT_MS
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
    console.error('FAIL: no CDP page')
    process.exit(2)
  }
  console.error(`target: ${target.url}`)

  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')

  const ready = await evaluate(
    cdp,
    `!!(window.electron && window.electron.codex && window.electron.diag && typeof window.electron.diag.killWorker === 'function')`
  )
  console.error(`bridge+diag: ${ready}`)
  if (!ready) {
    cdp.close()
    console.error('FAIL: missing bridge or diag.killWorker')
    process.exit(3)
  }

  // Establish UI-owned active session + running prompt on THAT session.
  console.error('phase UI-A: open/create active session in UI...')
  const a = await evaluate(
    cdp,
    `(async () => {
      const api = window.electron.codex
      let list = await api.listSessions()
      let sid
      if (list.length > 0) {
        sid = list[0].id
      } else {
        const s = await api.createSession({ cwd: 'D:/2026/FlexAgent', title: 'ui-disconnect' })
        sid = s.id
      }
      // Drive React openSession via clicking is flaky; use list + first row if present.
      // Fallback: if UI already has an active session matching sid after mount, OK.
      // Force open by selecting session row if we can find it — else prompt on sid after UI openSession from mount.
      const rows = [...document.querySelectorAll('[data-testid="session-row"], aside button, aside [role="button"]')]
      // Prompt on sid — only updates UI if it is activeSessionId.
      // Ensure UI opens this session: if rows empty, still try API prompt after a custom open via retry path.
      return { sid, listLen: list.length, rows: rows.length }
    })()`
  )
  console.error(`UI-A: ${JSON.stringify(a)}`)

  // Click session row matching title if UI already opened list[0] on mount — usually active.
  // Start prompt on a.sid and hope it matches active; if not, force openSession through ConnectionBanner retry path later.
  // Better: subscribe-style — create fresh session via UI New chat button.
  const clicked = await evaluate(
    cdp,
    `(async () => {
      const nav = [...document.querySelectorAll('button, [role="button"]')].find(
        b => (b.textContent || '').includes('New chat')
      )
      if (nav) { nav.click(); await new Promise(r => setTimeout(r, 800)); return 'clicked-new-chat' }
      return 'no-new-chat'
    })()`
  )
  console.error(`new-chat: ${clicked}`)

  // After New chat, React createSession + openSession — wait for composer enabled.
  const composerReady = await waitUntil(
    async () => evaluate(cdp, `(() => {
      const send = document.querySelector('button[aria-label="Send message"], button[aria-label="Queue message"]')
      const ta = document.querySelector('textarea')
      return !!(ta && send && !send.disabled)
    })()`),
    8000,
    'composer ready'
  )
  console.error(`composerReady: ${composerReady}`)

  // Type + send a prompt that will keep running long enough to kill mid-run.
  const sent = await evaluate(
    cdp,
    `(async () => {
      const ta = document.querySelector('textarea')
      if (!ta) return { ok: false, why: 'no textarea' }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, 'Write a detailed 2000-word essay about distributed systems failure modes. Do not stop early.')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 100))
      const btn = document.querySelector('button[aria-label="Send message"], button[aria-label="Queue message"]')
      if (!btn || btn.disabled) return { ok: false, why: 'send disabled' }
      btn.click()
      return { ok: true }
    })()`
  )
  console.error(`send: ${JSON.stringify(sent)}`)

  const running = await waitUntil(
    async () => evaluate(cdp, `(() => {
      const stop = document.querySelector('button[aria-label="Stop run"], button[title*="Stop"]')
      const streaming = document.querySelector('[aria-label="Assistant is responding"]')
      return !!(stop || streaming)
    })()`),
    20000,
    'UI running indicator'
  )
  console.error(`runningUi: ${running}`)

  // Snapshot before kill.
  const before = await evaluate(cdp, SNAPSHOT)
  console.error(`before: ${JSON.stringify(before)}`)

  console.error('phase UI-B: killWorker...')
  const kill = await evaluate(cdp, 'window.electron.diag.killWorker()')
  console.error(`kill: ${JSON.stringify(kill)}`)

  // Poll for degraded banner + error block (kernel fans out error + idle).
  let sawLost = false
  let sawErrorBlock = false
  let sawReconnected = false
  let sawBannerClear = false
  const timeline = []

  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    const snap = await evaluate(cdp, SNAPSHOT)
    timeline.push({ t: Date.now() - t0, banner: snap.bannerText, errs: snap.errorBlocks.length, boundary: snap.errorBoundary })
    if (snap.bannerText && snap.bannerText.includes('Connection lost')) sawLost = true
    if (snap.hasKernelInternalError) sawErrorBlock = true
    if (snap.bannerText && snap.bannerText.includes('Reconnected')) sawReconnected = true
    if (sawLost && !snap.hasBanner) sawBannerClear = true
    if (snap.errorBoundary) break
    if (sawLost && sawErrorBlock && (sawReconnected || sawBannerClear)) break
    await delay(250)
  }

  // If banner never appeared, try Retry now path visibility.
  if (!sawLost) {
    const retryVisible = await evaluate(
      cdp,
      `!!document.querySelector('[data-testid="connection-retry"]')`
    )
    console.error(`retryVisible without banner: ${retryVisible}`)
  }

  // Give reconcile a moment; if still degraded, click Retry now.
  if (sawLost && !sawReconnected && !sawBannerClear) {
    console.error('clicking Retry now...')
    await evaluate(
      cdp,
      `(() => { const b = document.querySelector('[data-testid="connection-retry"]'); if (b) b.click(); return !!b })()`
    )
    const t1 = Date.now()
    while (Date.now() - t1 < 8000) {
      const snap = await evaluate(cdp, SNAPSHOT)
      if (snap.bannerText && snap.bannerText.includes('Reconnected')) sawReconnected = true
      if (sawLost && !snap.hasBanner) { sawBannerClear = true; break }
      await delay(250)
    }
  }

  // Final: session usable? composer present, no ErrorBoundary.
  const after = await evaluate(cdp, SNAPSHOT)
  console.error(`after: ${JSON.stringify(after)}`)
  console.error(`timeline: ${JSON.stringify(timeline)}`)

  const checks = {
    killOk: !!kill?.killed,
    uiSawConnectionLost: sawLost,
    uiSawKernelInternalErrorBlock: sawErrorBlock,
    uiRecovered: sawReconnected || sawBannerClear,
    noErrorBoundaryCrash: after.errorBoundary === false,
    composerStillThere: after.composerPresent === true
  }
  console.error('UI_CHECKS', JSON.stringify(checks, null, 2))

  cdp.close()
  const pass = Object.values(checks).every(Boolean)
  if (pass) {
    console.error('ACCEPT_DISCONNECT_UI_PASS')
    process.exit(0)
  }
  console.error('ACCEPT_DISCONNECT_UI_FAIL')
  process.exit(1)
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
