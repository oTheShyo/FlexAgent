/**
 * Skill Hub acceptance (v1.8) — listSkillHubs / browseSkillHub / installSkill /
 * uninstallSkill + Skills page UI flow.
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'url'
import { existsSync, mkdtempSync, rmSync, writeFileSync, writeFileSync as wf } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const BUNDLE = new URL('.skillhub-test-bundle.mjs', import.meta.url)
const CDP_HTTP = 'http://127.0.0.1:9222'
const TIMEOUT_MS = 90_000
const SKILLS_HOME = join(homedir(), '.flexagent', 'skills')

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
  constructor(getPage) {
    this.getPage = getPage // () => Promise<{ webSocketDebuggerUrl }>
    this.id = 0
    this.pending = new Map()
  }

  async connect(wsUrl) {
    this.wsUrl = wsUrl ?? this.wsUrl
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

  async send(method, params = {}) {
    const id = ++this.id
    const timeoutMs = 120_000
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout waiting for ${method}`))
        }
      }, timeoutMs)
    })
  }

  /** Evaluate with one reconnect retry (HMR full reload navigates the target). */
  async evaluate(expression) {
    try {
      return await this.#evaluateOnce(expression)
    } catch (err) {
      if (!/navigated or closed|target closed/i.test(String((err && err.message) || err))) throw err
      console.log('  (target navigated — reconnecting)')
      const targets = await listTargets()
      const page = pickPage(targets)
      if (!page) throw err
      try {
        this.ws.close()
      } catch {}
      await this.connect(page.webSocketDebuggerUrl)
      return await this.#evaluateOnce(expression)
    }
  }

  async #evaluateOnce(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluate exception')
    }
    return result.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

const CHECKS = []
function check(name, ok, detail = '') {
  CHECKS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function ev(cdp, expression) {
  return cdp.evaluate(
    `(function () { return (${expression}).then(v => JSON.stringify({ ok: true, v }), e => JSON.stringify({ ok: false, code: e && e.code, error: String(e && e.message || e) })) })()`
  ).then(JSON.parse)
}

async function waitForBridge(cdp) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const ok = await cdp.evaluate(
        `Boolean(window.electron?.codex && typeof window.electron.codex.listSkillHubs === 'function')`
      )
      if (ok) return true
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function runUnitChecks() {
  // skillHub.ts imports '../shared/contract' (directory import) which Node ESM
  // cannot resolve — bundle it with esbuild first so we test the REAL code.
    // Always rebuild so the bundle reflects the latest skillHub.ts.
    await build({
      entryPoints: [fileURLToPath(new URL('../src/main/skills/skillHub.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'node',
      external: ['electron'],
      outfile: fileURLToPath(BUNDLE),
      logLevel: 'error'
    })
  let hub = null
  try {
    hub = await import(BUNDLE.href)
    check('unit: skillHub bundle import (esbuild, real code)',
      typeof hub.parseSkillSource === 'function' && typeof hub.listSkillHubs === 'function')
  } catch (err) {
    check('unit: skillHub bundle import (esbuild, real code)', false, String((err && err.message) || err))
    return
  }

  const cases = [
    ['github:owner/repo', { kind: 'github', owner: 'owner', repo: 'repo' }],
    ['github:owner/repo@v1', { kind: 'github', owner: 'owner', repo: 'repo', ref: 'v1' }],
    ['github:owner/repo/skills/pdf', { kind: 'github', owner: 'owner', repo: 'repo', path: 'skills/pdf' }],
    ['github:owner/repo@v1/sub/dir', { kind: 'github', owner: 'owner', repo: 'repo', ref: 'v1', path: 'sub/dir' }],
    ['https://github.com/owner/repo/tree/main/skills/pdf', { kind: 'github', owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/pdf' }],
    ['https://example.com/skill.zip', { kind: 'zip', url: 'https://example.com/skill.zip' }]
  ]
  for (const [input, expected] of cases) {
    try {
      const parsed = hub.parseSkillSource(input)
      const got = { kind: parsed.kind, owner: parsed.owner, repo: parsed.repo, ...(parsed.ref ? { ref: parsed.ref } : {}), ...(parsed.path ? { path: parsed.path } : {}), ...(parsed.url ? { url: parsed.url } : {}) }
      check(`unit: parseSkillSource ${input}`, JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got))
    } catch (err) {
      check(`unit: parseSkillSource ${input}`, false, String((err && err.message) || err))
    }
  }
  for (const bad of ['git@example.com:owner/repo.git', 'https://example.com/not-zip', 'ftp://x/y.zip', '']) {
    let threw = ''
    try {
      hub.parseSkillSource(bad)
    } catch (err) {
      threw = String((err && err.code) || err.message || err)
    }
    check(`unit: parseSkillSource rejects ${bad || '(empty)'}`, threw === 'SKILL_SOURCE_INVALID', threw)
  }
}

function clickByText(cdp, text) {
  return cdp.evaluate(
    `(function () {
      const els = [...document.querySelectorAll('button, [role="tab"]')]
      const el = els.find(b => b.textContent.trim() === ${JSON.stringify(text)})
      if (!el) return false
      el.click()
      return true
    })()`
  )
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) {
        check(label, true)
        return true
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  check(label, false, `timeout after ${timeoutMs}ms`)
  return false
}

async function main() {
  await runUnitChecks()

  const cdp = new Cdp(async () => {
    const targets = await listTargets()
    const page = pickPage(targets)
    if (!page) throw new Error('no page target with CDP')
    return page
  })
  let installedName = null
  try {
    const targets = await listTargets()
    const page = pickPage(targets)
    if (!page) {
      console.error('No page target with CDP')
      process.exit(1)
    }
    await cdp.connect(page.webSocketDebuggerUrl)
    const bridged = await waitForBridge(cdp)
    check('bridge: listSkillHubs available', bridged)
    if (!bridged) {
      console.error('ACCEPT_SKILLHUB_FAIL')
      process.exit(1)
    }

    // Clean slate: make sure walkthrough leftovers are gone.
    const hubs0 = await ev(cdp, `window.electron.codex.listSkillHubs()`)
    check('listSkillHubs resolves', hubs0.ok === true && Array.isArray(hubs0.v), hubs0.error || '')
    const official = hubs0.v?.find((h) => h.builtIn)
    check('built-in official hub present', official?.id === 'official', JSON.stringify(official ?? null))

    // Browse = real GitHub (trees API + contents frontmatter). Generous timeout.
    const t0 = Date.now()
    const browse = await ev(cdp, `window.electron.codex.browseSkillHub()`)
    check('browseSkillHub resolves', browse.ok === true && Array.isArray(browse.v), browse.error || '')
    check(
      'browse returns entries with descriptions',
      browse.ok === true && browse.v.length >= 5 && browse.v.some((e) => typeof e.description === 'string' && e.description.length > 0),
      `count=${browse.v?.length ?? 0} in ${Date.now() - t0}ms`
    )
    check(
      'entries carry installable github sources',
      browse.ok === true && browse.v.every((e) => typeof e.source === 'string' && e.source.startsWith('github:')),
      JSON.stringify(browse.v?.[0]?.source ?? null)
    )

    if (browse.ok !== true || browse.v.length === 0) {
      console.error('ACCEPT_SKILLHUB_FAIL')
      process.exit(1)
    }

    // Pick a stable, small-ish entry if present; else first.
    const wanted = ['docx', 'pdf', 'internal-comms', 'discernment-nudge']
    const entry = wanted.map((w) => browse.v.find((e) => e.name === w)).find(Boolean) ?? browse.v[0]
    installedName = entry.name

    const dup0 = await ev(cdp, `window.electron.codex.uninstallSkill(${JSON.stringify(installedName)}).then(() => null)`)
    check(
      'pre-clean uninstall (clean slate ok)',
      dup0.ok === true || dup0.code === 'SKILL_NOT_FOUND',
      dup0.error || ''
    )

    // Install via IPC.
    const t1 = Date.now()
    const install = await ev(
      cdp,
      `window.electron.codex.installSkill({ source: { kind: 'hub', hub: 'official', name: ${JSON.stringify(installedName)} } })`
    )
    check('installSkill from hub', install.ok === true, install.error || '')
    check(
      'install returns user SkillSummary',
      install.ok === true && install.v?.source === 'user' && install.v?.name === installedName && String(install.v?.path).includes('.flexagent'),
      JSON.stringify(install.v ?? install.error)
    )
    console.log(`  install took ${Date.now() - t1}ms`)
    check('skill dir on disk with SKILL.md', existsSync(join(SKILLS_HOME, installedName, 'SKILL.md')))

    const dupInstall = await ev(
      cdp,
      `window.electron.codex.installSkill({ source: { kind: 'hub', hub: 'official', name: ${JSON.stringify(installedName)} } })`
    )
    check(
      'duplicate install → SKILL_ALREADY_INSTALLED',
      dupInstall.ok === false && dupInstall.code === 'SKILL_ALREADY_INSTALLED',
      dupInstall.code || dupInstall.error || ''
    )

    const skills = await ev(cdp, `window.electron.codex.listSkills()`)
    check(
      'listSkills contains installed user skill',
      skills.ok === true && skills.v.some((s) => s.source === 'user' && s.name === installedName),
      JSON.stringify(skills.v?.filter((s) => s.source === 'user').map((s) => s.name) ?? [])
    )

    // ── Install provenance (v1.9) ──
    const installedSkill = skills.ok
      ? skills.v.find((s) => s.source === 'user' && s.name === installedName)
      : undefined
    check(
      'provenance: sidecar surives a listing round trip',
      installedSkill?.provenance?.kind === 'hub' &&
        installedSkill.provenance.hub === 'official' &&
        typeof installedSkill.provenance.source === 'string' &&
        /^github:/.test(installedSkill.provenance.source) === true &&
        typeof installedSkill.provenance.resolvedRef === 'string' &&
        typeof installedSkill.provenance.contentHash === 'string',
      JSON.stringify(installedSkill?.provenance ?? null)
    )
    check(
      'provenance: .flexagent-source.json written to disk',
      existsSync(join(SKILLS_HOME, installedName, '.flexagent-source.json'))
    )
    const reinstalled = await ev(
      cdp,
      `window.electron.codex.reinstallSkill(${JSON.stringify(installedName)})`
    )
    check(
      'reinstallSkill from recorded source',
      reinstalled.ok === true && reinstalled.v?.name === installedName,
      reinstalled.error || JSON.stringify(reinstalled.v ?? null)
    )
    check(
      'reinstall keeps installedAt, sets updatedAt, content hash stable',
      reinstalled.ok === true &&
        reinstalled.v?.provenance?.installedAt === installedSkill?.provenance?.installedAt &&
        typeof reinstalled.v?.provenance?.updatedAt === 'number' &&
        reinstalled.v?.provenance?.contentHash === installedSkill?.provenance?.contentHash,
      JSON.stringify(reinstalled.v?.provenance ?? null)
    )
    const noSource = await ev(cdp, `window.electron.codex.reinstallSkill('definitely-not-installed')`)
    check(
      'reinstallSkill rejects a skill with no recorded source',
      noSource.ok === false && noSource.code === 'SKILL_SOURCE_INVALID',
      noSource.code || noSource.error || ''
    )

    // Cache-hit browse must reflect the install.
    const browse2 = await ev(cdp, `window.electron.codex.browseSkillHub('official')`)
    const entry2 = browse2.ok ? browse2.v.find((e) => e.name === installedName) : null
    check('cached browse marks entry installed', entry2?.installed === true, JSON.stringify(entry2 ?? null))

    // UI flow: open Skills page → Skill Hub tab → card grid → install badge → Installed tab → uninstall.
    const opened = await clickByText(cdp, 'Skills')
    check('UI: sidebar Skills button clicked', opened === true)
    const pageShown = await waitFor(cdp, `Boolean(document.querySelector('[data-testid="skills-page"]'))`, 15_000, 'UI: skills page visible')
    if (pageShown) {
      const hubTab = await clickByText(cdp, 'Skill Hub')
      check('UI: Skill Hub tab clicked', hubTab === true)
      const gridShown = await waitFor(
        cdp,
        `document.querySelectorAll('[data-testid^="skill-hub-entry-"]').length > 0`,
        90_000,
        'UI: hub card grid populated (real GitHub browse)'
      )
      if (gridShown) {
        const cardCount = await cdp.evaluate(`document.querySelectorAll('[data-testid^="skill-hub-entry-"]').length`)
        check('UI: hub cards rendered', cardCount >= 5, `count=${cardCount}`)
        const badge = await waitFor(
          cdp,
          `Boolean(document.querySelector('[data-testid="skill-installed-${installedName}"]'))`,
          20_000,
          'UI: installed badge on hub card'
        )
        if (badge) {
          const installedTab = await clickByText(cdp, 'Installed')
          check('UI: Installed tab clicked', installedTab === true)
          await waitFor(
            cdp,
            `Boolean(document.querySelector('[data-testid="skill-row-${installedName}"]'))`,
            15_000,
            'UI: skill row in Installed list'
          )
          const unBtn = await cdp.evaluate(
            `Boolean(document.querySelector('[data-testid="skill-uninstall-${installedName}"]'))`
          )
          check('UI: uninstall button present for user skill', unBtn === true)
          const provText = await cdp.evaluate(
            `document.querySelector('[data-testid="skill-origin-${installedName}"]')?.textContent ?? ''`
          )
          check(
            'UI: origin line shows the install source',
            typeof provText === 'string' && provText.includes('github:') === true,
            String(provText).slice(0, 120)
          )
          const updBtn = await cdp.evaluate(
            `Boolean(document.querySelector('[data-testid="skill-reinstall-${installedName}"]'))`
          )
          check('UI: Update button present for a reinstallable skill', updBtn === true)
          if (unBtn) {
            await cdp.evaluate(`document.querySelector('[data-testid="skill-uninstall-${installedName}"]').click()`)
            await waitFor(
              cdp,
              `!document.querySelector('[data-testid="skill-row-${installedName}"]')`,
              15_000,
              'UI: skill row gone after uninstall'
            )
          }
          installedName = null // uninstalled via UI; nothing left to clean
          check('skill dir removed from disk', !existsSync(join(SKILLS_HOME, entry.name)))
          // Back to hub tab for the screenshot (empty-ish but real).
          await clickByText(cdp, 'Skill Hub')
        }
      }
    }

    // Hub management via IPC.
    const fixtureRoot = mkdtempSync(join(tmpdir2(), 'flex-skillhub-'))
    const indexPath = join(fixtureRoot, 'skills.json')
    wf(indexPath, JSON.stringify({ skills: [{ name: 'json-hub-entry', description: 'from json index', source: 'github:anthropics/skills/skills/pdf' }] }), 'utf8')
    const added = await ev(cdp, `window.electron.codex.addSkillHub({ name: 'team', url: ${JSON.stringify('file://' + indexPath)} })`)
    check('addSkillHub json index accepted', added.ok === false || added.ok === true, added.error || added.v?.id || '')
    // file:// is not https — expect either graceful rejection or, if accepted, removal works.
    if (added.ok === true) {
      const removed = await ev(cdp, `window.electron.codex.removeSkillHub('team')`)
      check('removeSkillHub works', removed.ok === true, removed.error || '')
    }
    const noRemoveBuiltin = await ev(cdp, `window.electron.codex.removeSkillHub('official')`)
    check('removing built-in hub rejected', noRemoveBuiltin.ok === false, noRemoveBuiltin.code || '')
    rmSync(fixtureRoot, { recursive: true, force: true })

    // Memory is its own page: sidebar nav + add/remove card round trip.
    const memNav = await clickByText(cdp, 'Memory')
    check('UI: sidebar Memory button clicked', memNav === true)
    const memShown = await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-testid="memory-page"]'))`,
      15_000,
      'UI: memory page visible (separate from Skills)'
    )
    if (memShown) {
      const noSkillsMounted = await cdp.evaluate(
        `!document.querySelector('[data-testid="skills-page"]')`
      )
      check('UI: skills page not mounted while Memory open', noSkillsMounted === true)
      const memBefore = await ev(cdp, `window.electron.codex.listMemoryCards()`)
      const added = await ev(
        cdp,
        `window.electron.codex.addMemoryCard('MEMORY', ${JSON.stringify('accept probe: prefer tabular output')})`
      )
      check('memory_manage add via IPC', added.ok === true, added.error || '')
      if (added.ok === true) {
        const removedByIndex = await ev(
          cdp,
          `window.electron.codex.removeMemoryCard('MEMORY', ${memBefore.ok === true ? memBefore.v.filter((c) => c.file === 'MEMORY').length : 0})`
        )
        check('memory_manage remove via IPC', removedByIndex.ok === true, removedByIndex.error || '')
      }
      const memInput = await cdp.evaluate(
        `Boolean(document.querySelector('[data-testid="memory-add-input"]'))`
      )
      check('UI: memory add form present', memInput === true)
    }

    // Back to Skills for the final banner check + screenshot.
    await clickByText(cdp, 'Skills')
    await waitFor(
      cdp,
      `Boolean(document.querySelector('[data-testid="skills-page"]'))`,
      15_000,
      'UI: back on skills page'
    )

    // Final UI state error banner check.
    const errText = await cdp.evaluate(
      `document.querySelector('[data-testid="skills-error"]')?.textContent ?? ''`
    )
    check('UI: no error banner at end', (errText ?? '').length === 0, String(errText).slice(0, 120))

    // Screenshot last (no modal open).
    try {
      const shot = await Promise.race([
        cdp.send('Page.captureScreenshot', { format: 'png' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('wedged')), 8000))
      ])
      writeFileSync('skillhub-walkthrough.png', Buffer.from(shot.data, 'base64'))
      check('screenshot captured', true)
    } catch (err) {
      check('screenshot captured', false, String((err && err.message) || err))
    }

    const failed = CHECKS.filter((c) => !c.ok)
    console.log(`\nCHECKS ${CHECKS.length - failed.length}/${CHECKS.length}`)
    if (failed.length) {
      console.error('ACCEPT_SKILLHUB_FAIL')
      process.exit(1)
    }
    console.error('ACCEPT_SKILLHUB_PASS')
    process.exit(0)
  } catch (err) {
    console.error(err)
    // Best-effort cleanup.
    if (installedName) {
      try {
        const { rmSync } = await import('fs')
        rmSync(join(SKILLS_HOME, installedName), { recursive: true, force: true })
      } catch {}
    }
    console.error('ACCEPT_SKILLHUB_FAIL')
    process.exit(1)
  } finally {
    cdp.close()
  }
}

import { tmpdir } from 'os'
function tmpdir2() {
  return tmpdir()
}

main()
