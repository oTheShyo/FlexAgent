/**
 * Walkthrough: the permission-mode switches must actually switch. (CDP, no Playwright.)
 *
 * Regression being covered: the top-bar menu used to open *upward* from the
 * top of the window, so the panel rendered above the viewport and the button
 * read as dead. The composer chip used to be a hardcoded `disabled` stub with
 * a stale "not wired to the kernel yet" tooltip, even though the kernel side
 * had been wired.
 *
 * Two traps this script is built to avoid:
 *   - A second Electron on the machine may already own 9222; QA against the
 *     wrong checkout proves nothing. Port comes from `CDP_PORT`.
 *   - Asserting on a session created through the raw API measures nothing when
 *     the UI is bound to a different one. The active session is read off the
 *     DOM instead.
 */
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = `http://127.0.0.1:${process.env.CDP_PORT ?? 9222}`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function listTargets() {
  const res = await fetch(`${CDP_HTTP}/json`)
  return res.json()
}

function pickPage(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  return pages.find((t) => /517\d|flex-agent|localhost/i.test(t.url)) || pages[0]
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
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout ${method}`))
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
    throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed')
  }
  return result.result.value
}

const targets = await listTargets()
const page = pickPage(targets)
if (!page) {
  console.error('no renderer page found on CDP')
  process.exit(1)
}
console.log('page:', page.url)
const cdp = new Cdp(page.webSocketDebuggerUrl)
await cdp.connect()

const ev = (expression) => evaluate(cdp, expression)
const waitFor = async (expr, timeoutMs = 8000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await ev(expr)) return true
    await delay(250)
  }
  return false
}

const SWITCHER = '[data-testid="permission-mode"]'
const TOP = `header ${SWITCHER}`
const COMPOSER = `[data-testid="composer"] ${SWITCHER}`

// --- which session is the UI actually bound to? ---
let sessionId = await ev(`(() => {
  const current = document.querySelector('[aria-current="true"]')
  const row = current?.closest('[data-session-menu-root]')
  return row?.getAttribute('data-session-menu-root') ?? null
})()`)
let createdHere = false

if (!sessionId) {
  const created = await ev(
    `window.electron.codex.createSession({}).then((s) => s.id).catch((e) => 'ERR:' + e.message)`
  )
  check('scratch session created', !String(created).startsWith('ERR'), String(created))
  if (String(created).startsWith('ERR')) process.exit(1)
  sessionId = String(created)
  createdHere = true
  // Wait for it to appear in the sidebar, then select it so the UI binds to it.
  await waitFor(`!!document.querySelector('[data-session-menu-root=${JSON.stringify(sessionId)}]')`, 15000)
  await ev(
    `document.querySelector('[data-session-menu-root=${JSON.stringify(sessionId)}] button')?.click(); true`
  )
  await waitFor(
    `document.querySelector('[data-session-menu-root=${JSON.stringify(sessionId)}] [aria-current="true"]') !== null`,
    10000
  )
}
check('active session resolved from the UI', Boolean(sessionId), String(sessionId))

const readyStart = Date.now()
let ready = null
while (Date.now() - readyStart < 45000) {
  const ok = await ev(
    `window.electron.codex.getPermissionMode(${JSON.stringify(sessionId)}).then(() => true).catch(() => false)`
  )
  if (ok === true) {
    ready = Date.now() - readyStart
    break
  }
  await delay(400)
}
check('kernel ready for permission queries', ready !== null, ready === null ? 'timeout' : `${ready}ms`)

const original = await ev(`window.electron.codex.getPermissionMode(${JSON.stringify(sessionId)})`)
console.log(`  (mode at start: ${original})`)

// --- top-bar switcher: menu must appear inside the viewport ---
check('top-bar mode button exists', await ev(`!!document.querySelector(${JSON.stringify(TOP)})`))

await ev(`document.querySelector(${JSON.stringify(TOP)}).click()`)
check(
  'menu opens on click',
  await waitFor(`document.querySelector(${JSON.stringify(TOP)}).getAttribute('aria-expanded') === 'true'`)
)

// The rule list arrives from the main process after the menu paints, so give
// the IPC a moment instead of declaring it missing.
const rulesShown = await waitFor(
  `/Effective rules/.test(document.querySelector('header [role="menu"]')?.textContent ?? '')`,
  6000
)
check('menu shows the effective rule set', rulesShown, rulesShown ? '' : 'no rule list after 6s')

const geom = await ev(`(() => {
  const menu = document.querySelector('header [role="menu"]')
  if (!menu) return null
  const r = menu.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, height: r.height, vh: window.innerHeight,
           items: menu.querySelectorAll('[role="menuitemradio"]').length,
           rules: /Effective rules/.test(menu.textContent) }
})()`)
check('menu lists five modes', geom !== null && geom.items === 5, JSON.stringify(geom))
check(
  'menu is inside the viewport (regression: used to open above the window)',
  geom !== null && geom.top >= 0 && geom.bottom <= geom.vh,
  geom ? `top=${Math.round(geom.top)} bottom=${Math.round(geom.bottom)} vh=${geom.vh}` : 'no menu'
)

// --- switching modes for real ---
const target = original === 'acceptEdits' ? 'auto' : 'acceptEdits'
const label = target === 'auto' ? 'Auto' : 'Accept edits'
await ev(
  `[...document.querySelectorAll('header [role="menuitemradio"]')]
    .find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`
)
await delay(800)
const after = await ev(`window.electron.codex.getPermissionMode(${JSON.stringify(sessionId)})`)
check('selecting a mode persists to the kernel', after === target, `${original} -> ${after}`)
check(
  'button label follows the selection',
  await waitFor(`document.querySelector(${JSON.stringify(TOP)}).textContent.includes(${JSON.stringify(label)})`)
)
check(
  'the other switcher mirrors the same mode',
  await ev(`document.querySelector(${JSON.stringify(COMPOSER)})?.dataset.mode === ${JSON.stringify(target)}`),
  String(await ev(`document.querySelector(${JSON.stringify(COMPOSER)})?.dataset.mode`))
)

// restore
await ev(`document.querySelector(${JSON.stringify(TOP)}).click()`)
await waitFor(`document.querySelector(${JSON.stringify(TOP)}).getAttribute('aria-expanded') === 'true'`)
const originalLabel =
  { plan: 'Plan', default: 'Default', acceptEdits: 'Accept edits', auto: 'Auto', bypass: 'Bypass' }[original] ??
  'Default'
await ev(
  `[...document.querySelectorAll('header [role="menuitemradio"]')]
    .find((b) => b.textContent.includes(${JSON.stringify(originalLabel)})).click()`
)
await delay(700)
check(
  `restored to ${original}`,
  (await ev(`window.electron.codex.getPermissionMode(${JSON.stringify(sessionId)})`)) === original
)

// --- composer chip: live control, not the old disabled stub ---
const composer = await ev(`(() => {
  const b = document.querySelector(${JSON.stringify(COMPOSER)})
  return b ? { disabled: b.disabled, label: b.textContent.trim(), mode: b.dataset.mode } : null
})()`)
check('composer mode control exists', composer !== null, JSON.stringify(composer))
check('composer mode control is enabled', composer !== null && composer.disabled === false)
check(
  'composer label shows the live mode, not the stale "Manual"',
  composer !== null && composer.label !== 'Manual',
  composer?.label ?? ''
)

// composer menu opens upward and must still be visible
await ev(`document.querySelector(${JSON.stringify(COMPOSER)}).click(); true`)
check(
  'composer menu opens',
  await waitFor(`[...document.querySelectorAll('[role="menu"]')].some((m) => !m.closest('header'))`)
)
const upGeom = await ev(`(() => {
  const menus = [...document.querySelectorAll('[role="menu"]')].filter((m) => !m.closest('header'))
  const r = menus[menus.length - 1].getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, vh: window.innerHeight }
})()`)
check(
  'composer menu stays inside the viewport',
  upGeom.top >= 0 && upGeom.bottom <= upGeom.vh,
  JSON.stringify(upGeom)
)
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

// --- teardown ---
if (createdHere) {
  await ev(`window.electron.codex.deleteSession(${JSON.stringify(sessionId)})`).catch(() => {})
  await delay(400)
  const gone = await ev(
    `window.electron.codex.listSessions().then((l) => !l.some((s) => s.id === ${JSON.stringify(sessionId)})).catch(() => false)`
  )
  check('scratch session removed', gone === true)
} else {
  console.log('  (left the pre-existing session in place)')
}

cdp.close()
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} PASS`)
process.exit(passed === results.length ? 0 : 1)
