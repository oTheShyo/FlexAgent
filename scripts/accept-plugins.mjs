/**
 * Contract v1.4 acceptance — listPlugins / installPlugin / getPlugin /
 * setPluginEnabled / uninstallPlugin + pluginsChanged events.
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CDP_HTTP = 'http://127.0.0.1:9222'
const TIMEOUT_MS = 60_000
const PLUGIN_NAME = 'accept-demo-plugin'

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

  async evaluate(expression) {
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

async function waitForBridge(cdp) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const ok = await cdp.evaluate(
        `Boolean(window.electron?.codex && typeof window.electron.codex.listPlugins === 'function')`
      )
      if (ok) return true
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function ev(cdp, expression) {
  return cdp.evaluate(
    `(function () { return (${expression}).then(v => JSON.stringify({ ok: true, v }), e => JSON.stringify({ ok: false, code: e && e.code, error: String(e && e.message || e) })) })()`
  ).then(JSON.parse)
}

function makeFixtureDir() {
  const root = mkdtempSync(join(tmpdir(), 'flex-plugin-'))
  mkdirSync(join(root, '.flex-plugin'), { recursive: true })
  writeFileSync(
    join(root, '.flex-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: PLUGIN_NAME,
        version: '0.1.0',
        description: 'acceptance fixture',
        extensions: 'extensions',
        skills: 'skills',
        userConfig: {
          demo_key: { title: 'Demo key', type: 'string', required: true, sensitive: true },
          max_retry: { title: 'Retries', type: 'number', default: 3 }
        }
      },
      null,
      2
    ),
    'utf8'
  )
  mkdirSync(join(root, 'extensions'), { recursive: true })
  writeFileSync(
    join(root, 'extensions', 'index.ts'),
    'export default function ext(_pi: unknown): void {}\n',
    'utf8'
  )
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
  writeFileSync(
    join(root, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: demo skill for acceptance\n---\n\n# Demo\n',
    'utf8'
  )
  return root
}

async function main() {
  const targets = await listTargets()
  const page = pickPage(targets)
  if (!page) {
    console.error('No page target with CDP')
    process.exit(1)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  let fixtureDir = null
  try {
    await cdp.connect()
    const bridged = await waitForBridge(cdp)
    check('bridge.listPlugins', bridged)
    if (!bridged) {
      console.error('ACCEPT_PLUGINS_FAIL')
      process.exit(1)
    }

    await cdp.evaluate(
      `window.__pluginEvents = []; window.__pluginUnsub = window.electron.codex.subscribePlugins(e => window.__pluginEvents.push(e))`
    )

    const id = `${PLUGIN_NAME}@local`

    await ev(cdp, `window.electron.codex.uninstallPlugin(${JSON.stringify(id)}).then(() => null)`)

    const initial = await ev(cdp, `window.electron.codex.listPlugins()`)
    check('listPlugins resolves', initial.ok === true, initial.error || '')
    check(
      'listPlugins without fixture plugin',
      initial.ok === true && Array.isArray(initial.v) && !initial.v.some((p) => p.id === id),
      `len=${initial.v?.length ?? 'n/a'}`
    )

    fixtureDir = makeFixtureDir()
    const install = await ev(
      cdp,
      `window.electron.codex.installPlugin({ source: { kind: 'directory', path: ${JSON.stringify(fixtureDir)} } })`
    )
    check('installPlugin', install.ok === true, install.error || install.v?.id || '')
    check('install returns id', install.ok === true && install.v?.id === id, install.v?.id || '')
    check('install enabled=true', install.ok === true && install.v?.enabled === true)
    check(
      'componentCounts extension=1 skill=1',
      install.ok === true &&
        install.v?.componentCounts?.extension === 1 &&
        install.v?.componentCounts?.skill === 1,
      JSON.stringify(install.v?.componentCounts || {})
    )

    const afterInstall = await ev(cdp, `window.electron.codex.listPlugins()`)
    check(
      'listPlugins contains installed',
      afterInstall.ok === true && afterInstall.v.some((p) => p.id === id)
    )

    const detail = await ev(cdp, `window.electron.codex.getPlugin(${JSON.stringify(id)})`)
    check('getPlugin', detail.ok === true, detail.error || '')
    if (detail.ok) {
      const exts = detail.v.components.filter((c) => c.kind === 'extension')
      const skills = detail.v.components.filter((c) => c.kind === 'skill')
      check('getPlugin extension component', exts.length === 1, JSON.stringify(exts))
      check('getPlugin skill component', skills.length === 1, JSON.stringify(skills))
      check(
        'getPlugin skill has description',
        skills[0]?.description === 'demo skill for acceptance',
        skills[0]?.description || ''
      )
      check(
        'getPlugin userConfig (2 items, sensitive flagged)',
        detail.v.userConfig?.length === 2 &&
          detail.v.userConfig.find((u) => u.key === 'demo_key')?.sensitive === true,
        JSON.stringify(detail.v.userConfig || [])
      )
      const errors = (detail.v.diagnostics || []).filter((d) => d.severity === 'error')
      check('getPlugin no error diagnostics', errors.length === 0, JSON.stringify(errors))
      check('getPlugin rootPath set', typeof detail.v.rootPath === 'string' && detail.v.rootPath.length > 0)
    }

    const dup = await ev(
      cdp,
      `window.electron.codex.installPlugin({ source: { kind: 'directory', path: ${JSON.stringify(fixtureDir)} } })`
    )
    check(
      'duplicate install → PLUGIN_ALREADY_INSTALLED',
      dup.ok === false && dup.code === 'PLUGIN_ALREADY_INSTALLED',
      dup.code || dup.error || ''
    )

    const created = await ev(
      cdp,
      `window.electron.codex.createSession({ cwd: 'D:/2026/FlexAgent' })`
    )
    check('createSession with enabled plugin loaded', created.ok === true, created.error || created.v?.id || '')
    if (created.ok) {
      const sid = created.v.id
      const reopened = await ev(
        cdp,
        `window.electron.codex.openSession(${JSON.stringify(sid)})`
      )
      check('openSession after plugin load', reopened.ok === true, reopened.error || '')
      await ev(cdp, `window.electron.codex.deleteSession(${JSON.stringify(sid)})`)
    }

    const off = await ev(
      cdp,
      `window.electron.codex.setPluginEnabled(${JSON.stringify(id)}, false)`
    )
    check('setPluginEnabled false', off.ok === true && off.v?.enabled === false, off.error || '')
    const on = await ev(cdp, `window.electron.codex.setPluginEnabled(${JSON.stringify(id)}, true)`)
    check('setPluginEnabled true', on.ok === true && on.v?.enabled === true, on.error || '')
    const idempotent = await ev(
      cdp,
      `window.electron.codex.setPluginEnabled(${JSON.stringify(id)}, true)`
    )
    check(
      'setPluginEnabled idempotent',
      idempotent.ok === true && idempotent.v?.enabled === true,
      idempotent.error || ''
    )

    const missing = await ev(
      cdp,
      `window.electron.codex.setPluginEnabled('nope@local', true)`
    )
    check(
      'setPluginEnabled unknown → PLUGIN_NOT_FOUND',
      missing.ok === false && missing.code === 'PLUGIN_NOT_FOUND',
      missing.code || ''
    )

    const emptyDir = mkdtempSync(join(tmpdir(), 'flex-nomanifest-'))
    const noManifest = await ev(
      cdp,
      `window.electron.codex.installPlugin({ source: { kind: 'directory', path: ${JSON.stringify(emptyDir)} } })`
    )
    check(
      'install no manifest → PLUGIN_MANIFEST_INVALID',
      noManifest.ok === false && noManifest.code === 'PLUGIN_MANIFEST_INVALID',
      noManifest.code || ''
    )
    rmSync(emptyDir, { recursive: true, force: true })

    const badPath = await ev(
      cdp,
      `window.electron.codex.installPlugin({ source: { kind: 'directory', path: 'Z:/definitely/not/a/dir' } })`
    )
    check(
      'install missing path → PLUGIN_PATH_INVALID',
      badPath.ok === false && badPath.code === 'PLUGIN_PATH_INVALID',
      badPath.code || ''
    )

    const un = await ev(cdp, `window.electron.codex.uninstallPlugin(${JSON.stringify(id)})`)
    check('uninstallPlugin', un.ok === true, un.error || '')

    const afterUninstall = await ev(cdp, `window.electron.codex.listPlugins()`)
    check(
      'listPlugins without uninstalled',
      afterUninstall.ok === true && !afterUninstall.v.some((p) => p.id === id)
    )

    const gone = await ev(cdp, `window.electron.codex.getPlugin(${JSON.stringify(id)})`)
    check(
      'getPlugin after uninstall → PLUGIN_NOT_FOUND',
      gone.ok === false && gone.code === 'PLUGIN_NOT_FOUND',
      gone.code || ''
    )

    await new Promise((r) => setTimeout(r, 1500))
    const events = JSON.parse(
      (await cdp.evaluate(`JSON.stringify(window.__pluginEvents)`)) || '[]'
    )
    const eventTypesOk = events.length >= 3
    check('pluginsChanged events received (>=3)', eventTypesOk, `count=${events.length}`)
    const lastEvent = events[events.length - 1]
    check(
      'last event payload shape',
      lastEvent && Array.isArray(lastEvent.plugins),
      JSON.stringify(lastEvent || null)
    )

    await cdp.evaluate(`window.__pluginUnsub && window.__pluginUnsub()`)

    const failed = CHECKS.filter((c) => !c.ok)
    console.log(`\nCHECKS ${CHECKS.length - failed.length}/${CHECKS.length}`)
    if (failed.length) {
      console.error('ACCEPT_PLUGINS_FAIL')
      process.exit(1)
    }
    console.error('ACCEPT_PLUGINS_PASS')
    process.exit(0)
  } finally {
    if (fixtureDir) {
      try {
        rmSync(fixtureDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    cdp.close()
  }
}

main().catch((err) => {
  console.error(err)
  console.error('ACCEPT_PLUGINS_FAIL')
  process.exit(1)
})
