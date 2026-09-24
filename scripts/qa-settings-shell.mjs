/**
 * Settings shell walkthrough (CDP, no Playwright).
 *
 * The settings window is a two-pane page now — a navigation rail plus one
 * section at a time — so this checks the parts that are easy to get subtly
 * wrong: that the rail actually swaps sections (rather than stacking them in
 * the DOM), that Escape and the close button both work, that the palette can
 * still reach Settings, and that picking a theme applies it *and* is restored
 * afterwards. It leaves the user's theme preference exactly as it found it.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirSync, writeFileSync } from 'node:fs'

const CDP_HTTP = 'http://127.0.0.1:9222'
const SHOTS = new URL('../.qa-shots/', import.meta.url).pathname.replace(/^\//, '')
const THEME_KEY = 'codex.theme.v1'

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

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(cdp, expression)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`)
    await delay(200)
  }
}

/**
 * Screenshots go last: captureScreenshot has wedged this renderer before, so
 * every functional check runs first. They are recorded per section and taken
 * in one pass at the end, with the settings window reopened — the run closes
 * it on the way out.
 */
const pendingShots = []
function queueShot(name, section) {
  pendingShots.push([name, section])
}

async function takeShots(cdp) {
  if (pendingShots.length === 0) return
  try {
    await openFromSidebar(cdp)
    for (const [name, section] of pendingShots) {
      await goto(cdp, section)
      await shot(cdp, name)
    }
    await evaluate(cdp, `document.querySelector('[data-testid="settings-close"]').click()`)
    await delay(250)
  } catch (err) {
    console.log(`shots failed (non-fatal): ${err.message}`)
  }
}

async function shot(cdp, name) {
  // The first capture in a fresh headless session tends to time out and then
  // succeed on a retry, so one retry is worth the two seconds.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await cdp.send('Page.captureScreenshot', { format: 'png' }, 25000)
      mkdirSync(SHOTS, { recursive: true })
      writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data.data, 'base64'))
      console.log(`shot  .qa-shots/${name}.png${attempt > 1 ? ' (retry)' : ''}`)
      return
    } catch (err) {
      if (attempt === 2) console.log(`shot  ${name} failed (non-fatal): ${err.message}`)
      else await delay(2000)
    }
  }
}

const SECTION_TEXT = `document.querySelector('[data-testid="settings-content"]').innerText`

async function openFromSidebar(cdp) {
  // Start from a clean slate. A panel left open by an earlier run keeps its
  // own section, which is precisely what "lands on General" is asserting.
  const alreadyOpen =
    (await evaluate(cdp, `document.querySelector('[data-testid="settings-panel"]') !== null`)) ===
    true
  if (alreadyOpen) {
    await evaluate(cdp, `document.querySelector('[data-testid="settings-close"]').click()`)
    await delay(250)
  }
  await evaluate(
    cdp,
    `(() => {
      const row = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Settings')
      if (!row) return false
      row.click()
      return true
    })()`
  )
  await waitFor(cdp, `document.querySelector('[data-testid="settings-panel"]') !== null`, 'settings panel')
}

async function goto(cdp, id) {
  await evaluate(cdp, `document.querySelector('[data-testid="settings-nav-${id}"]').click()`)
  await delay(400)
}

async function closed(cdp) {
  return (await evaluate(cdp, `document.querySelector('[data-testid="settings-panel"]') === null`)) === true
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

  await waitFor(cdp, `document.querySelector('aside') !== null`, 'shell')

  // Snapshot the real preference so the run cannot leave the app on a theme
  // the user did not choose.
  const themeBefore = await evaluate(cdp, `localStorage.getItem(${JSON.stringify(THEME_KEY)})`)
  const dataThemeBefore = await evaluate(
    cdp,
    `document.documentElement.getAttribute('data-theme')`
  )

  try {
    await openFromSidebar(cdp)
    check('sidebar Settings opens the window', true)
    check(
      'it is a modal dialog, not a popover',
      (await evaluate(
        cdp,
        `(() => {
          const el = document.querySelector('[data-testid="settings-panel"]')
          return el.getAttribute('role') === 'dialog' && el.getAttribute('aria-modal') === 'true'
        })()`
      )) === true
    )
    check(
      'the palette is gone once settings is up',
      (await evaluate(cdp, `document.querySelector('[data-testid="command-palette"]') === null`)) ===
        true
    )

    const rail = await evaluate(
      cdp,
      `(() => {
        const items = [...document.querySelectorAll('[data-testid^="settings-nav-"] button, [data-testid^="settings-nav-"]')]
          .filter((el) => el.dataset.testid !== 'settings-nav')
        const groups = [...document.querySelectorAll('[data-testid="settings-nav"] p')].map((p) => p.textContent)
        return {
          ids: items.map((el) => el.dataset.testid.replace('settings-nav-', '')),
          groups,
          labels: items.map((el) => el.innerText.trim())
        }
      })()`
    )
    check(
      'the rail lists five sections',
      rail.ids.length === 5,
      `${rail.ids.join(', ')} → ${rail.labels.join(' | ')}`
    )
    check(
      'sections are grouped',
      rail.groups.length === 2 && rail.groups.includes('Models') && rail.groups.includes('About'),
      rail.groups.join(', ') || '(none)'
    )

    // ── one section at a time ──
    const general = await evaluate(cdp, SECTION_TEXT)
    check(
      'General is the landing section',
      general.includes('Bridge') && general.includes('Platform'),
      general.split('\n').slice(0, 3).join(' / ')
    )
    check(
      'a single section is mounted at a time',
      (await evaluate(cdp, `document.querySelector('[data-testid="settings-models"]') === null`)) ===
        true
    )
    queueShot('10-settings-general', 'general')

    // ── appearance: the theme grid writes through to <html> ──
    await goto(cdp, 'appearance')
    const cards = await evaluate(
      cdp,
      `document.querySelectorAll('[data-testid^="theme-"]').length`
    )
    check('appearance renders the theme grid', cards >= 3, `${cards} cards`)
    const applied = await evaluate(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('[data-testid^="theme-"]')]
        const target = cards.find((c) => c.dataset.testid !== 'theme-light' && c.dataset.testid !== 'theme-dark')
        target.click()
        return { id: target.dataset.testid.replace('theme-', ''), stored: localStorage.getItem('${THEME_KEY}') }
      })()`
    )
    await delay(200)
    const dataTheme = await evaluate(cdp, `document.documentElement.getAttribute('data-theme')`)
    check(
      'picking a theme applies it immediately',
      dataTheme === applied.id,
      `${applied.id} → data-theme=${dataTheme}`
    )
    check(
      'and is stored for next launch',
      applied.stored === JSON.stringify(applied.id),
      applied.stored ?? 'nothing stored'
    )
    const selectedCard = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('[data-testid="theme-' + ${JSON.stringify(applied.id)} + '"]')
        return el.getAttribute('aria-checked')
      })()`
    )
    check('the chosen card reports itself selected', selectedCard === 'true')
    queueShot('11-settings-appearance', 'appearance')

    // ── shortcuts ──
    await goto(cdp, 'shortcuts')
    const keys = await evaluate(
      cdp,
      `[...document.querySelectorAll('[data-testid="settings-shortcuts"] kbd')].map((k) => k.textContent)`
    )
    check('shortcuts list the real keymap', keys.length >= 5, keys.join(' '))
    check(
      'and the palette shortcut is among them',
      keys.some((k) => /K$/.test(k.trim())),
      keys.join(' ')
    )

    // ── models ──
    await goto(cdp, 'models')
    const modelsUp = await waitFor(
      cdp,
      `document.querySelector('[data-testid="settings-models"]') !== null`,
      'models section'
    )
    check('the Models section mounts on its own page', modelsUp === true)
    check(
      'and General is gone while it is open',
      (await evaluate(cdp, `document.querySelector('[data-testid="settings-environment"]') === null`)) ===
        true
    )

    // ── storage / about ──
    await goto(cdp, 'about')
    const about = await evaluate(cdp, SECTION_TEXT)
    check(
      'Storage names the kernel models file',
      /models\.json/.test(about),
      about.split('\n').filter((l) => l.includes('models.json'))[0] ?? about.slice(0, 80)
    )
    check(
      'and draws the device/kernel line',
      about.includes('Local overlay') && about.includes('Belong to the kernel')
    )
    queueShot('12-settings-about', 'about')

    const marked = await evaluate(
      cdp,
      `(() => {
        const items = [...document.querySelectorAll('[data-testid^="settings-nav-"]')]
        const current = items.filter((el) => el.getAttribute('aria-current') === 'page')
        return {
          count: current.length,
          id: current[0] ? current[0].dataset.testid : null,
          total: items.length
        }
      })()`
    )
    check(
      'the rail highlights exactly the open section',
      marked.count === 1 && marked.id === 'settings-nav-about',
      `${marked.count}/${marked.total} marked → ${marked.id}`
    )
    // Painted, not just marked: screenshots of this renderer have been caught
    // showing a stale compositor frame, so the highlight is read off the
    // computed style instead of off an image.
    const paint = await evaluate(
      cdp,
      `(() => {
        const cur = document.querySelector('[data-testid="settings-nav-about"]')
        const other = document.querySelector('[data-testid="settings-nav-general"]')
        const a = getComputedStyle(cur)
        const b = getComputedStyle(other)
        return { cur: a.backgroundColor, other: b.backgroundColor, weight: a.fontWeight }
      })()`
    )
    check(
      'the open entry is painted differently',
      paint.cur !== paint.other,
      `${paint.cur} vs ${paint.other} @${paint.weight}`
    )

    // ── closing ──
    await evaluate(
      cdp,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await delay(250)
    check('Escape closes the settings window', await closed(cdp))

    // ── the palette can still reach it ──
    await evaluate(
      cdp,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`
    )
    await waitFor(cdp, `document.querySelector('[data-testid="command-palette"]') !== null`, 'palette')
    // The palette keys its options by HTML id, not by testid.
    await waitFor(
      cdp,
      `document.querySelector('#command-palette-option-settings') !== null`,
      'settings command'
    )
    await evaluate(cdp, `document.querySelector('#command-palette-option-settings').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="settings-panel"]') !== null`, 'settings again')
    check('the palette command opens it too', true)
    check(
      'and the palette closes behind it',
      (await evaluate(cdp, `document.querySelector('[data-testid="command-palette"]') === null`)) ===
        true
    )

    await evaluate(cdp, `document.querySelector('[data-testid="settings-close"]').click()`)
    await delay(250)
    check('the close button works', await closed(cdp))
  } catch (err) {
    check('the walkthrough ran to the end', false, String(err && err.message))
  } finally {
    // Restore the user's theme, whatever happened above.
    await evaluate(
      cdp,
      `(() => {
        const raw = ${JSON.stringify(themeBefore)}
        if (raw === null) localStorage.removeItem(${JSON.stringify(THEME_KEY)})
        else localStorage.setItem(${JSON.stringify(THEME_KEY)}, raw)
        document.documentElement.setAttribute('data-theme', ${JSON.stringify(dataThemeBefore)})
        return true
      })()`
    ).catch(() => {})
  }

  const restored = await evaluate(cdp, `document.documentElement.getAttribute('data-theme')`)
  check(
    'the theme preference is restored',
    restored === dataThemeBefore,
    `before=${dataThemeBefore} after=${restored}`
  )

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  if (failed.length > 0) {
    console.log('failures:')
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
  }
  console.log('')

  await takeShots(cdp)

  cdp.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(4)
})
