/**
 * Settings › Models walkthrough (CDP, no Playwright).
 *
 * Drives the real UI: opens Settings from the sidebar, adds a custom model
 * through the form, then checks the claim that matters — that the *kernel*
 * picked the entry up (listModels + setModel on an attached session), not just
 * that a row appeared in the DOM. Removes the entry again at the end.
 *
 * Only touches throwaway state: one scratch session (deleted) and one
 * models.json entry under the `qa-` provider (removed).
 */
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const CDP_HTTP = 'http://127.0.0.1:9222'
const SHOTS = new URL('../.qa-shots/', import.meta.url).pathname.replace(/^\//, '')
const PROVIDER = 'qa-provider'
const MODEL = 'qa-model-1'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
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
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result?.value
}

/** Poll an expression until it returns truthy. */
async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(cdp, expression)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`waitFor timout: ${label}`)
    await delay(250)
  }
}

/**
 * Screenshots are a hazard in this headless setup: `Page.captureScreenshot` has
 * been observed to wedge the renderer for good. They are therefore queued and
 * taken *after* every functional check has run and been reported, each with a
 * short timeout, and a failure can no longer invalidate the results.
 */
const pendingShots = []
function queueShot(name) {
  pendingShots.push(name)
}

async function shot(cdp, name) {
  try {
    const data = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15000)
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data.data, 'base64'))
    console.log(`shot  .qa-shots/${name}.png`)
  } catch (err) {
    console.log(`shot  ${name} failed (non-fatal): ${err.message}`)
  }
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

  // ── readiness: the app owns a session list before anything is clickable ──
  await waitFor(cdp, `document.querySelectorAll('[data-testid="session-list-heading"], aside').length > 0`, 'shell')
  await waitFor(cdp, `typeof window.electron?.codex?.listCustomModels === 'function'`, 'bridge')

  const bridge = await evaluate(
    cdp,
    `(() => {
      const keys = ['listCustomModels', 'customModelsPath', 'saveCustomModel', 'removeCustomModel']
      const api = window.electron.codex
      return keys.filter((key) => typeof api[key] !== 'function')
    })()`
  )
  check('bridge exposes the 4 custom-model methods', bridge.length === 0, bridge.join(',') || 'all present')

  const path = await evaluate(cdp, `window.electron.codex.customModelsPath()`)
  check('models.json path resolves', typeof path === 'string' && path.endsWith('models.json'), path)

  // The file is PI's own config and holds the user's existing providers, so the
  // walkthrough has to prove it left them untouched.
  const rawBefore = (() => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  })()
  const providersBefore = rawBefore === null ? [] : Object.keys(JSON.parse(rawBefore).providers ?? {})
  console.log(`      existing providers: ${providersBefore.join(', ') || '(none)'}`)

  // ── open Settings from the sidebar ──
  const opened = await evaluate(
    cdp,
    `(() => {
      const row = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Settings')
      if (!row) return false
      row.click()
      return true
    })()`
  )
  check('sidebar Settings opens the panel', opened)
  await waitFor(cdp, `document.querySelector('[data-testid="settings-nav"]') !== null`, 'settings rail')
  // Settings opens on General now; the model list lives under the Models group.
  await evaluate(cdp, `document.querySelector('[data-testid="settings-nav-models"]').click()`)
  await waitFor(cdp, `document.querySelector('[data-testid="settings-models"]') !== null`, 'models section')

  const heading = await evaluate(cdp, `document.querySelector('[data-testid="settings-models"]').innerText`)
  check('Models section renders with the file path', heading.includes('models.json'), heading.split('\n')[0])
  const rowCount = await evaluate(
    cdp,
    `document.querySelectorAll('[data-testid^="custom-model-row-"]').length`
  )
  if (providersBefore.length === 0) {
    check('empty state explains the capability', heading.includes('No custom models yet'))
  } else {
    check(
      'existing file entries are listed',
      rowCount > 0,
      `${rowCount} rows for provider(s) [${providersBefore.join(',')}]`
    )
  }
  queueShot('01-settings-models-list')

  // ── validation: an empty form must not write ──
  await evaluate(cdp, `document.querySelector('[data-testid="custom-model-add"]').click()`)
  await waitFor(cdp, `document.querySelector('[data-testid="custom-model-form"]') !== null`, 'form')
  await evaluate(cdp, `document.querySelector('[data-testid="custom-model-submit"]').click()`)
  await delay(300)
  const validationError = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector('[data-testid="custom-model-error"]')
      return el ? el.textContent : null
    })()`
  )
  const listedAfterInvalid = await evaluate(cdp, `window.electron.codex.listCustomModels()`)
  const baseline = await evaluate(cdp, `window.electron.codex.listCustomModels()`)
  check('empty submit is rejected client-side', validationError !== null, validationError ?? 'no error shown')
  check(
    'rejected submit wrote nothing',
    listedAfterInvalid.length === baseline.length && !listedAfterInvalid.some((m) => m.id === MODEL),
    `${listedAfterInvalid.length} entries`
  )

  // ── fill + submit ──
  await evaluate(
    cdp,
    `(() => {
      const setValue = ${SET_VALUE}
      const set = (testid, value) => setValue(document.querySelector('[data-testid="' + testid + '"]'), value)
      set('custom-model-id', '${MODEL}')
      set('custom-model-label', 'QA Model One')
      set('custom-model-provider', '${PROVIDER}')
      set('custom-model-baseurl', 'http://127.0.0.1:9099/v1')
      set('custom-model-api', 'openai-completions')
      set('custom-model-apikey', 'qa-key-not-a-secret')
      return true
    })()`
  )
  queueShot('02-settings-models-form')
  const stateBefore = await evaluate(cdp, `window.electron.codex.listModels()`)
  check('model absent before save', !stateBefore.some((m) => m.id === MODEL), `${stateBefore.length} models listed`)

  await evaluate(cdp, `document.querySelector('[data-testid="custom-model-submit"]').click()`)
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="custom-model-row-${PROVIDER}-${MODEL}"]') !== null`,
    'row after save',
    30000
  )
  check('row appears in the list', true)
  const formClosed = await evaluate(cdp, `document.querySelector('[data-testid="custom-model-form"]') === null`)
  check('form closes on success', formClosed)
  const warning = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector('[data-testid="custom-model-kernel-warning"]')
      return el ? el.textContent : null
    })()`
  )
  check('no kernel warning after save', warning === null, warning ?? '')

  // ── did the *kernel* take it? ──
  const listed = await evaluate(cdp, `window.electron.codex.listCustomModels()`)
  check(
    'listCustomModels returns the entry',
    listed.some((m) => m.provider === PROVIDER && m.id === MODEL),
    `${listed.length} entries`
  )
  check(
    'apiKeySet is reported without the key',
    listed.every((m) => m.apiKey === undefined) && listed.find((m) => m.id === MODEL)?.apiKeySet === true
  )

  const models = await evaluate(cdp, `window.electron.codex.listModels()`)
  const hit = models.find((m) => m.provider === PROVIDER && m.id === MODEL)
  check('kernel listModels includes the new model', hit !== undefined, JSON.stringify(hit ?? null))

  // ── an already-attached session can switch to it (in-place runtime refresh) ──
  const switchResult = await evaluate(
    cdp,
    `(async () => {
      const api = window.electron.codex
      const created = await api.createSession({})
      try {
        await api.openSession(created.id)
        const config = await api.setModel({ sessionId: created.id, provider: '${PROVIDER}', id: '${MODEL}' })
        return { ok: true, model: config.model }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      } finally {
        await api.deleteSession(created.id).catch(() => {})
      }
    })()`
  )
  check(
    'attached session switches to the new model (no restart)',
    switchResult.ok === true,
    switchResult.ok ? JSON.stringify(switchResult.model) : switchResult.error
  )

  // ── composer picker reflects it ──
  const pickerHasIt = await evaluate(
    cdp,
    `(async () => {
      // The composer's first haspopup button is the plan-mode chip (ticket 07
      // landed after this script); the model menu hangs off its own testid.
      const chip = document.querySelector('[data-testid="composer-model-chip"]')
      if (!chip) return 'no-chip'
      chip.click()
      await new Promise((r) => setTimeout(r, 400))
      const menu = document.querySelector('[role="menu"], [aria-label="Model and thinking level"]')
      const text = menu ? menu.innerText : ''
      chip.click()
      return text.includes('QA Model One') ? 'yes' : 'no:' + text.slice(0, 120)
    })()`
  )
  check('composer model picker lists it', pickerHasIt === 'yes', pickerHasIt)
  queueShot('03-settings-models-saved')

  // ── remove ──
  await evaluate(cdp, `document.querySelector('[data-testid="custom-model-remove-${MODEL}"]').click()`)
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="custom-model-remove-confirm-${MODEL}"]') !== null`,
    'confirm'
  )
  await evaluate(cdp, `document.querySelector('[data-testid="custom-model-remove-confirm-${MODEL}"]').click()`)
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="custom-model-row-${PROVIDER}-${MODEL}"]') === null`,
    'row removed',
    30000
  )
  const afterRemove = await evaluate(cdp, `window.electron.codex.listModels()`)
  check(
    'kernel listModels drops it after removal',
    !afterRemove.some((m) => m.provider === PROVIDER && m.id === MODEL),
    `${afterRemove.length} models listed`
  )
  const listedAfterRemove = await evaluate(cdp, `window.electron.codex.listCustomModels()`)
  check(
    'custom model list is back to the pre-test entries',
    listedAfterRemove.length === baseline.length && !listedAfterRemove.some((m) => m.provider === PROVIDER),
    `${listedAfterRemove.length} entries (baseline ${baseline.length})`
  )
  queueShot('04-settings-models-after-remove')

  // ── the user's own entries survived ──
  const rawAfter = (() => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  })()
  if (rawBefore === null) {
    check('models.json written', rawAfter !== null, 'file created by the walkthrough')
  } else {
    const norm = (text) => (text === null ? null : text.replace(/\r\n/g, '\n'))
    check(
      'pre-existing providers unchanged',
      JSON.stringify(Object.keys(JSON.parse(rawAfter ?? '{}').providers ?? {})) ===
        JSON.stringify(providersBefore),
      `before=[${providersBefore.join(',')}] after=[${Object.keys(JSON.parse(rawAfter ?? '{}').providers ?? {}).join(',')}]`
    )
    check(
      "user's models.json restored byte-for-byte (line endings normalized)",
      norm(rawAfter) === norm(rawBefore),
      norm(rawAfter) === norm(rawBefore) ? '' : 'file content differs from the pre-test snapshot'
    )
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  if (failed.length > 0) {
    console.log('failures:')
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
  }
  console.log('')

  // Only now, with the report already on stdout: screenshots last.
  for (const name of pendingShots) await shot(cdp, name)

  cdp.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(4)
})
