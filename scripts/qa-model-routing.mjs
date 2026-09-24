/**
 * Settings › Routing / Network walkthrough (CDP, no Playwright).
 *
 * Checks the claims that actually matter for a routing layer, not that a select
 * element rendered:
 *
 *  1. a role binding is resolved against the live kernel, not merely stored;
 *  2. the `chat` role really decides what a *new* session runs on (kernel's own
 *     `getModelConfig` answer, not our own echo);
 *  3. the proxy reaches the request path — proven by a local TCP listener that
 *     the kernel connects to when, and only when, a proxy is configured;
 *  4. the ledger attributes real token spend to a purpose and a model;
 *  5. the user's own `routing.json` and `settings.json` are restored byte for
 *     byte afterwards.
 *
 * Only throwaway state is touched: one scratch session (deleted), and the two
 * files above (snapshotted, restored, then compared).
 */
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CDP_HTTP = 'http://127.0.0.1:9222'
const SHOTS = new URL('../.qa-shots/', import.meta.url).pathname.replace(/^\//, '')
const ROUTING_FILE = join(homedir(), '.flexagent', 'routing.json')
const PROXY_PORT = 9876
/** Unreachable on purpose: the point is the connection attempt, not the reply. */
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
function skip(name, why) {
  results.push({ name, ok: true, detail: `SKIPPED: ${why}` })
  console.log(`SKIP  ${name}  — ${why}`)
}

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
    this.errors = []
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
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        // The URL is kept because the interesting part of a resource failure is
        // *which* resource — "403 (Forbidden)" alone is not actionable.
        const entry = msg.params.entry
        this.errors.push(`${entry.text}${entry.url ? ` <${entry.url}>` : ''}`)
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
    const detail = result.exceptionDetails
    // A ContractError crossing the IPC bridge arrives as a plain object, and
    // `${err}` would print "Object" — which is how one failure here cost twenty
    // minutes and left the user's settings.json modified.
    const thrown = detail.exception
    const text =
      thrown?.description ??
      detail.text ??
      (thrown === undefined ? undefined : JSON.stringify(thrown.value ?? thrown))
    throw new Error(text ?? 'unknown renderer exception')
  }
  return result.result?.value
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(cdp, expression)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`)
    await delay(250)
  }
}

/**
 * Screenshots are a hazard in this headless setup: `Page.captureScreenshot` has
 * been observed to time out on the first attempt (a retry then succeeds), and
 * `fromSurface: false` fails outright. They are therefore taken *after* every
 * functional check has run and been reported, so a failure to capture can never
 * invalidate the results.
 */
async function shot(cdp, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000)
      mkdirSync(SHOTS, { recursive: true })
      writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data.data, 'base64'))
      console.log(`shot  .qa-shots/${name}.png`)
      return
    } catch (err) {
      if (attempt === 2) console.log(`shot  ${name} failed (non-fatal): ${err.message}`)
      await delay(400)
    }
  }
}

/**
 * Open a section, whatever state the window is in. Earlier this assumed the
 * panel was still open from the previous step; creating a chat mid-walkthrough
 * closes it, and the assumption surfaced as a null `.click()` at the very end —
 * after every check had already been reported.
 */
async function openSection(cdp, id) {
  await openSettings(cdp)
  const clicked = await evaluate(
    cdp,
    `(() => {
      const row = document.querySelector('[data-testid="settings-nav-${id}"]')
      if (row === null) return false
      row.click()
      return true
    })()`
  )
  if (!clicked) throw new Error(`settings section "${id}" is not reachable`)
  await waitFor(cdp, `document.querySelector('[data-testid="settings-${id}"]') !== null`, id)
}

/** The settings body is its own scroll container; shots have to position it. */
async function scrollSettings(cdp, where) {
  await evaluate(
    cdp,
    `(() => {
      const scroller = document.querySelector('[data-testid="settings-content"] > div')
      if (!scroller) return false
      scroller.scrollTop = ${where === 'bottom' ? 'scroller.scrollHeight' : '0'}
      return true
    })()`
  )
  await delay(500)
}

/**
 * Put the two files this walkthrough writes back the way it found them, and
 * then *prove* it.
 *
 * Registered on the failure path as well as the happy one: an early attempt used
 * plain sequential code, one step threw, and the user's `settings.json` was left
 * holding a 60-second idle timeout and a one-shot retry budget with nothing
 * around to unset them. A walkthrough that touches real user files owns them
 * until every exit is covered.
 */
let restorable = null

async function restoreUserFiles(cdp, snapshot) {
  snapshot ??= restorable
  if (snapshot === null || snapshot.done) return
  snapshot.done = true
  const { routingBefore, settingsBefore, settingsPath, net0 } = snapshot

  try {
    // In-process first (the dispatcher and the proxy variable have to go back),
    // then the file itself, because the API cannot express "this key was absent".
    await evaluate(
      cdp,
      `window.electron.codex.setNetworkSettings(${JSON.stringify({
        proxy: net0.proxy,
        idleTimeoutMs: net0.idleTimeoutMs,
        maxRetries: net0.maxRetries
      })})`
    )
  } catch (err) {
    console.log(`restore could not reach the app bridge: ${err.message}`)
  }
  if (settingsBefore !== null) writeFileSync(settingsPath, settingsBefore)
  if (settingsBefore === null && existsSync(settingsPath)) rmSync(settingsPath, { force: true })
  if (routingBefore === null) {
    const raw = readOrNull(ROUTING_FILE)
    check('routing.json removed bindings again', raw === null || !raw.includes('"chat"'), raw ?? 'absent')
  }

  const routingAfter = readOrNull(ROUTING_FILE)
  const settingsAfter = readOrNull(settingsPath)
  const routingOk = routingEquivalent(routingBefore, routingAfter)
  check(
    "user's routing.json restored (no binding left behind)",
    routingOk,
    routingOk
      ? `before=${routingBefore === null ? 'absent' : 'present'} after=${routingAfter === null ? 'absent' : 'present'}`
      : 'content differs from the snapshot'
  )
  const settingsOk = normalize(settingsAfter) === normalize(settingsBefore)
  check(
    "user's settings.json restored byte-for-byte (line endings normalized)",
    settingsOk,
    settingsOk ? '' : `found ${JSON.stringify(settingsAfter)}`
  )

  try {
    const finalNet = await evaluate(cdp, `window.electron.codex.getNetworkSettings()`)
    check(
      'panel agrees the proxy is back to its original value',
      finalNet.proxy === net0.proxy,
      `proxy="${finalNet.proxy}" (was "${net0.proxy}")`
    )
  } catch {
    /* the app may already be gone; the file itself is what matters */
  }
}

/** Idempotent: the panel may already be open, or may have closed in between. */
async function openSettings(cdp) {
  if (await evaluate(cdp, `document.querySelector('[data-testid="settings-panel"]') !== null`)) return
  const clicked = await evaluate(
    cdp,
    `(() => {
      const row = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Settings')
      if (!row) return false
      row.click()
      return true
    })()`
  )
  if (!clicked) throw new Error('Settings entry point not found in the sidebar')
  await waitFor(cdp, `document.querySelector('[data-testid="settings-nav"]') !== null`, 'settings rail')
}

const SET_VALUE = `
  (el, value) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
`

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
const normalize = (text) => (text === null ? null : text.replace(/\r\n/g, '\n'))

/**
 * An absent file and a file holding only an empty routing table are the same
 * configuration — the app deletes the stub when the last binding goes.
 */
function routingEquivalent(before, after) {
  if (normalize(before) === normalize(after)) return true
  const isEmptyTable = (text) => {
    if (text === null) return true
    try {
      const root = JSON.parse(text)
      return Object.keys(root.roles ?? {}).length === 0 && Object.keys(root).length <= 1
    } catch {
      return false
    }
  }
  return isEmptyTable(before) && isEmptyTable(after)
}

/** Send one prompt and wait for the session to settle. Returns the transcript. */
async function runOnce(cdp, sessionId, text, timeoutMs = 120000) {
  await evaluate(
    cdp,
    `window.electron.codex.prompt({ sessionId: ${JSON.stringify(sessionId)}, text: ${JSON.stringify(text)} })`
  )
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const detail = await evaluate(cdp, `window.electron.codex.openSession(${JSON.stringify(sessionId)})`)
    if (detail.summary.runState === 'idle' && detail.messages.length > 1) return detail
    if (Date.now() > deadline) throw new Error('run did not settle in time')
    await delay(500)
  }
}

async function main() {
  let target = null
  for (let i = 0; i < 60; i++) {
    try {
      target = pickPage(await listTargets())
      if (target) break
    } catch {
      /* dev server not up yet */
    }
    await delay(500)
  }
  if (!target) {
    console.error('no CDP target')
    process.exit(2)
  }

  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')

  await waitFor(cdp, `typeof window.electron?.codex?.listModelRoles === 'function'`, 'bridge', 60000)

  const missing = await evaluate(
    cdp,
    `(() => {
      const keys = ['listModelRoles', 'setModelRole', 'getNetworkSettings', 'setNetworkSettings', 'sessionUsage']
      const api = window.electron.codex
      return keys.filter((key) => typeof api[key] !== 'function')
    })()`
  )
  check('bridge exposes the 5 routing/network methods', missing.length === 0, missing.join(',') || 'all present')

  // ── snapshot the two files this walkthrough writes to ──
  const routingBefore = readOrNull(ROUTING_FILE)
  const state0 = await evaluate(cdp, `window.electron.codex.listModelRoles()`)
  const net0 = await evaluate(cdp, `window.electron.codex.getNetworkSettings()`)
  const settingsPath = net0.path
  const settingsBefore = readOrNull(settingsPath)
  // From here on every write lands in one of these two files, so both are owned
  // until the walkthrough exits — including when it exits through an exception.
  const restoreTarget = { routingBefore, settingsBefore, settingsPath, net0, done: false }
  restorable = restoreTarget
  check('routing file path is the agent-owned one', state0.path === ROUTING_FILE, state0.path)
  check('network settings path is the kernel\u2019s own', settingsPath.endsWith('settings.json'), settingsPath)
  check(
    'dispatcher is installed (proxy can work at all)',
    net0.dispatcher === 'installed',
    `${net0.dispatcher}${net0.note ? ` — ${net0.note}` : ''}`
  )

  const facts = state0.facts ?? []
  const roleOf = (state, role) => (state.roles ?? []).find((r) => r.role === role) ?? null
  console.log(
    `      kernel catalogue: ${facts.length} model(s); ` +
      `baseline chat source=${roleOf(state0, 'chat')?.source} compaction source=${roleOf(state0, 'compaction')?.source}`
  )

  // ── the panel ──
  await openSettings(cdp)
  check('sidebar Settings opens the panel', true)
  await evaluate(cdp, `document.querySelector('[data-testid="settings-nav-routing"]').click()`)
  await waitFor(cdp, `document.querySelector('[data-testid="settings-routing"]') !== null`, 'routing section')

  const routingText = await evaluate(cdp, `document.querySelector('[data-testid="settings-routing"]').innerText`)
  check('Routing section names its file', routingText.includes('routing.json'), routingText.split('\n')[0])
  const roleRows = await evaluate(
    cdp,
    `document.querySelectorAll('[data-testid^="routing-role-"]').length`
  )
  check('one row per purpose with a consumer', roleRows === 2, `${roleRows} rows`)
  const factsShown = await evaluate(
    cdp,
    `document.querySelectorAll('[data-testid="routing-facts"] tbody tr').length`
  )
  check('model catalogue is rendered from the kernel', factsShown === facts.length, `${factsShown} rows`)

  const navHasNetwork = await evaluate(
    cdp,
    `document.querySelector('[data-testid="settings-nav-network"]') !== null`
  )
  check('Network section is reachable from the rail', navHasNetwork)

  if (facts.length === 0) {
    skip('role binding round-trip', 'kernel has no usable models')
    skip('chat role decides a new session\u2019s model', 'kernel has no usable models')
    skip('ledger attributes real spend', 'kernel has no usable models')
  } else {
    // ── bind a purpose, and confirm the *kernel* resolves it ──
    const boundFact = facts.find((f) => roleOf(state0, 'chat')?.model?.id !== f.id) ?? facts[0]
    const bound = { provider: boundFact.provider, id: boundFact.id }
    if (boundFact.label !== undefined) bound.label = boundFact.label

    const afterBind = await evaluate(
      cdp,
      `window.electron.codex.setModelRole({ role: 'chat', model: ${JSON.stringify(bound)} })`
    )
    const chatBound = roleOf(afterBind, 'chat')
    check(
      'binding is stored and resolved by the kernel',
      chatBound?.source === 'binding' && chatBound?.model?.provider === bound.provider && chatBound?.model?.id === bound.id,
      JSON.stringify(chatBound?.model ?? null) + (chatBound?.error ? ` error=${chatBound.error}` : '')
    )

    const fileAfterBind = readOrNull(ROUTING_FILE)
    check(
      'binding is persisted to routing.json',
      fileAfterBind !== null && fileAfterBind.includes(bound.id),
      fileAfterBind === null ? 'file missing' : `${fileAfterBind.length} bytes`
    )

    // ── the binding actually decides a brand-new session ──
    const newSession = await evaluate(
      cdp,
      `(async () => {
        const created = await window.electron.codex.createSession({})
        try {
          const config = await window.electron.codex.getModelConfig(created.id)
          return { id: created.id, model: config.model }
        } finally {
          await window.electron.codex.deleteSession(created.id).catch(() => {})
        }
      })()`
    )
    check(
      'a new session starts on the bound model (kernel\u2019s own answer)',
      newSession.model?.provider === bound.provider && newSession.model?.id === bound.id,
      JSON.stringify(newSession.model ?? null)
    )

    // ── clearing hands the choice back to the kernel ──
    const afterClear = await evaluate(cdp, `window.electron.codex.setModelRole({ role: 'chat', model: null })`)
    check('clearing a role returns it to the kernel', roleOf(afterClear, 'chat')?.source === 'kernel')

    // ── compaction can be bound too (resolution only; see docs) ──
    const compactionBind = await evaluate(
      cdp,
      `window.electron.codex.setModelRole({ role: 'compaction', model: ${JSON.stringify(bound)} })`
    )
    const comp = roleOf(compactionBind, 'compaction')
    check(
      'compaction role binds to a resolvable model',
      comp?.source === 'binding' && comp?.model?.id === bound.id && comp?.error === undefined,
      JSON.stringify(comp?.model ?? null) + (comp?.error ? ` error=${comp.error}` : '')
    )
    await evaluate(cdp, `window.electron.codex.setModelRole({ role: 'compaction', model: null })`)

    // ── the proxy has to reach the request path ──
    let proxyHits = 0
    const proxyServer = createServer((socket) => {
      proxyHits += 1
      socket.destroy()
    })
    const listening = await new Promise((resolve) => {
      proxyServer.once('error', () => resolve(false))
      proxyServer.listen(PROXY_PORT, '127.0.0.1', () => resolve(true))
    })
    if (!listening) {
      skip('configured proxy is used by the kernel', `port ${PROXY_PORT} is busy`)
      skip('a real turn completes with the proxy in force', 'proxy listener unavailable')
      skip('ledger attributes real spend', 'turn could not run')
    } else {
      const setProxy = await evaluate(
        cdp,
        `window.electron.codex.setNetworkSettings({ proxy: ${JSON.stringify(PROXY_URL)} })`
      )
      check('proxy is echoed back as stored', setProxy.proxy === PROXY_URL, setProxy.proxy)
      check(
        'the worker does not mistake its own proxy for an ambient one',
        setProxy.envProxy === null,
        String(setProxy.envProxy)
      )

      const sessionId = await evaluate(
        cdp,
        `(async () => { const s = await window.electron.codex.createSession({}); return s.id })()`
      )
      try {
        let turnError = null
        try {
          await runOnce(cdp, sessionId, 'Reply with the single word: ok', 60000)
        } catch (err) {
          turnError = err.message
        }
        check(
          'configured proxy is used by the kernel (local proxy saw a connection)',
          proxyHits > 0,
          `${proxyHits} connection(s)${turnError ? `; turn did not settle: ${turnError}` : ''}`
        )

        // ── and clearing it puts the kernel back on a direct connection ──
        await evaluate(cdp, `window.electron.codex.setNetworkSettings({ proxy: '' })`)
        const hitsBeforeDirect = proxyHits
        await runOnce(cdp, sessionId, 'Reply with the single word: ok', 120000)
        check(
          'clearing the proxy restores direct connections',
          proxyHits === hitsBeforeDirect,
          `proxy untouched (${proxyHits}) while the turn completed`
        )

        // ── the ledger ──
        const usage = await evaluate(cdp, `window.electron.codex.sessionUsage(${JSON.stringify(sessionId)})`)
        const chatBucket = (usage.byPurpose ?? []).find((b) => b.key === 'chat')
        check(
          'ledger attributes real spend to a purpose',
          usage.total?.calls > 0 && chatBucket?.calls > 0,
          `calls=${usage.total?.calls} cost=${usage.total?.cost} purposes=[${(usage.byPurpose ?? []).map((b) => b.key).join(',')}]`
        )
        check(
          'ledger attributes the same spend to a model',
          (usage.byModel ?? []).length > 0 && (usage.byModel ?? []).every((b) => b.key.includes('/')),
          (usage.byModel ?? []).map((b) => `${b.key}=${b.calls}`).join(' ')
        )

        // ── timeouts & retries round-trip ──
        const tuned = await evaluate(
          cdp,
          `window.electron.codex.setNetworkSettings({ idleTimeoutMs: 60000, maxRetries: 1 })`
        )
        check(
          'timeout and retry budget round-trip through the kernel\u2019s settings',
          tuned.idleTimeoutMs === 60000 && tuned.maxRetries === 1,
          `idle=${tuned.idleTimeoutMs} retries=${tuned.maxRetries}`
        )
        const onDisk = readOrNull(settingsPath)
        check(
          'both are on disk in the kernel\u2019s own file',
          onDisk !== null && onDisk.includes('60000') && onDisk.includes('"maxRetries": 1'),
          onDisk === null ? 'missing' : 'keys present'
        )
      } finally {
        await evaluate(cdp, `window.electron.codex.deleteSession(${JSON.stringify(sessionId)}).catch(() => {})`)
      }
      proxyServer.close()
    }
  }

  // ── the panel's own controls, not just the bridge ──
  // The proxy field commits on blur, so the walkthrough has to blur it the way
  // a user would (focusout) rather than calling the API itself.
  await openSettings(cdp)
  await evaluate(cdp, `document.querySelector('[data-testid="settings-nav-network"]').click()`)
  await waitFor(cdp, `document.querySelector('[data-testid="settings-network"]') !== null`, 'network section')

  const uiIdle = await evaluate(
    cdp,
    `(async () => {
      const setValue = ${SET_VALUE}
      setValue(document.querySelector('[data-testid="network-idle"]'), '120000')
      await new Promise((r) => setTimeout(r, 400))
      return (await window.electron.codex.getNetworkSettings()).idleTimeoutMs
    })()`
  )
  check('the idle-timeout control writes through to the kernel', uiIdle === 120000, String(uiIdle))

  const uiProxy = await evaluate(
    cdp,
    `(async () => {
      const setValue = ${SET_VALUE}
      const field = document.querySelector('[data-testid="network-proxy"]')
      setValue(field, ${JSON.stringify(PROXY_URL)})
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 500))
      return (await window.electron.codex.getNetworkSettings()).proxy
    })()`
  )
  check('the proxy field commits on blur', uiProxy === PROXY_URL, `"${uiProxy}"`)

  const uiProxyCleared = await evaluate(
    cdp,
    `(async () => {
      const setValue = ${SET_VALUE}
      const field = document.querySelector('[data-testid="network-proxy"]')
      setValue(field, '')
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 500))
      return (await window.electron.codex.getNetworkSettings()).proxy
    })()`
  )
  check('clearing the field goes direct again', uiProxyCleared === '', `"${uiProxyCleared}"`)

  // ── the ledger panel follows whatever chat is open ──
  // Creating a chat through the UI is the only way to get a session the renderer
  // considers active; it is deleted again from the API afterwards.
  const sessionsBefore = await evaluate(cdp, `window.electron.codex.listSessions()`)
  const createdByUi = []
  try {
    await evaluate(cdp, `document.querySelector('[data-testid="settings-close"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="settings-panel"]') === null`, 'panel closed')
    const newChatClicked = await evaluate(
      cdp,
      `(() => {
        const button = [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === 'New chat')
        if (!button) return false
        button.click()
        return true
      })()`
    )
    check('sidebar New chat is reachable', newChatClicked)
    await delay(2000)
    for (const session of await evaluate(cdp, `window.electron.codex.listSessions()`)) {
      if (!sessionsBefore.some((before) => before.id === session.id)) createdByUi.push(session.id)
    }
    check('the new chat exists in the kernel', createdByUi.length === 1, `${createdByUi.length} new session(s)`)

    await openSettings(cdp)
    await evaluate(cdp, `document.querySelector('[data-testid="settings-nav-routing"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="settings-routing"]') !== null`, 'routing section')
    await scrollSettings(cdp, 'bottom')
    const ledgerText = await evaluate(
      cdp,
      `document.querySelector('[data-testid="settings-routing"]').innerText`
    )
    check(
      'ledger binds to the open chat instead of the placeholder',
      ledgerText.includes('No calls recorded yet') && !ledgerText.includes('Open a chat to see what it has spent')
    )
    const ledgers = await evaluate(
      cdp,
      `document.querySelectorAll('[data-testid="routing-usage-purpose"], [data-testid="routing-usage-model"]').length`
    )
    check('both attribution tables render', ledgers === 2, `${ledgers} table(s)`)
  } finally {
    for (const id of createdByUi) {
      await evaluate(cdp, `window.electron.codex.deleteSession(${JSON.stringify(id)}).catch(() => {})`)
    }
  }

  // ── restore, then prove the restore ──
  await restoreUserFiles(cdp, restoreTarget)

  // Three kinds of noise this harness produces on its own, each of which must
  // stay *named* rather than being swallowed by a loose filter:
  //   1. DevTools/Autofill chatter.
  //   2. When the walkthrough runs from a git worktree whose `node_modules` is a
  //      junction to another path, Vite refuses to serve a font through `/@fs/`
  //      (403).
  //   3. When it runs against the *built* app (`file://`), index.html's root-relative
  //      favicon resolves against the drive root and misses.
  // Everything else must still turn this check red.
  const noise = /DevTools|Autofill|favicon|@fs\/.*\.woff2|file:\/\/\/[A-Za-z]:\/logo\.png/i
  const pageErrors = cdp.errors.filter((text) => !noise.test(text))
  check('no renderer errors logged during the walkthrough', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  console.log('')

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  if (failed.length > 0) {
    console.log('failures:')
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
  }
  console.log('')

  // Only now, with the report already on stdout: screenshots last, one panel
  // state at a time so each file matches its name.
  await openSection(cdp, 'routing')
  await scrollSettings(cdp, 'top')
  await shot(cdp, '01-settings-routing-purposes')
  await scrollSettings(cdp, 'bottom')
  await shot(cdp, '02-settings-routing-models-and-usage')
  await openSection(cdp, 'network')
  await shot(cdp, '03-settings-network')

  cdp.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  // The walkthrough died mid-flight; whatever it wrote still has to be undone,
  // and whether the undo worked is reported rather than assumed.
  if (restorable !== null && !restorable.done) {
    try {
      await restoreUserFiles(null, restorable)
    } catch (restoreErr) {
      console.error(restoreErr)
    }
    for (const result of results) {
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  — ${result.detail}`)
    }
  }
  process.exit(4)
})
