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

async function runBridgeUnitChecks() {
  let bridge = null
  try {
    bridge = await import(new URL('../src/main/pluginBridge.ts', import.meta.url).href)
    check(
      'bridge module import (type-stripped, no Electron)',
      typeof bridge.createPluginBridgeFactory === 'function' &&
        typeof bridge.registerPluginCommands === 'function'
    )
  } catch (err) {
    check('bridge module import (type-stripped, no Electron)', false, String((err && err.message) || err))
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'flex-bridge-'))
  try {
    const dirA = join(root, 'commands-a')
    const dirB = join(root, 'commands-b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    writeFileSync(
      join(dirA, 'demo.md'),
      '---\nname: demo\ndescription: demo command for bridge\n---\nRun: $ARGUMENTS | $ARGUMENTS',
      'utf8'
    )
    writeFileSync(
      join(dirA, 'no-name.md'),
      '---\ndescription: stem name fallback\n---\nBody without placeholders',
      'utf8'
    )
    writeFileSync(join(dirB, 'demo.md'), '---\nname: demo\ndescription: colliding\n---\nDup', 'utf8')

    const spec = {
      extensionPaths: [],
      skillRoots: [],
      commands: [dirA, dirB],
      hooks: [],
      mcp: [],
      pluginStorageRoot: root
    }

    const registered = new Map()
    const sent = []
    const stubPi = {
      registerCommand: (name, options) => {
        registered.set(name, options)
      },
      sendUserMessage: (content) => {
        sent.push(content)
      },
      getCommands: () => []
    }

    const diagnostics = []
    const inline = bridge.createPluginBridgeFactory(spec, diagnostics)
    const factory = typeof inline === 'function' ? inline : inline && inline.factory
    check(
      'factory is InlineExtension usable in extensionFactories',
      Boolean(inline) && typeof inline === 'object' && typeof inline.name === 'string' && typeof factory === 'function',
      typeof inline
    )
    await factory(stubPi)

    check(
      'bridge registers one command per .md file',
      registered.size === 2 && registered.has('demo') && registered.has('no-name'),
      [...registered.keys()].join(',') || 'none'
    )
    check(
      'command name/description from frontmatter',
      registered.get('demo')?.description === 'demo command for bridge',
      registered.get('demo')?.description || ''
    )
    check(
      'command name defaults to filename stem',
      registered.get('no-name')?.description === 'stem name fallback',
      registered.get('no-name')?.description || ''
    )
    check(
      'duplicate command skipped first-wins (no throw)',
      diagnostics.some((d) => d.code === 'command_duplicate'),
      JSON.stringify(diagnostics)
    )

    const demoCmd = registered.get('demo')
    if (demoCmd && typeof demoCmd.handler === 'function') {
      await demoCmd.handler('FIXTURE_ARGS', {})
      check(
        '$ARGUMENTS replaced by handler args (all occurrences)',
        sent.length === 1 && sent[0] === 'Run: FIXTURE_ARGS | FIXTURE_ARGS',
        JSON.stringify(sent[0] ?? null)
      )
      check('delivery via pi.sendUserMessage (captured once)', sent.length === 1, `sent=${sent.length}`)
    } else {
      check('$ARGUMENTS replaced by handler args (all occurrences)', false, 'handler missing')
      check('delivery via pi.sendUserMessage (captured once)', false, 'handler missing')
    }

    const missingSpec = { ...spec, commands: [join(root, 'nope')] }
    const missing = bridge.registerPluginCommands(missingSpec, stubPi, bridge.nodeBridgeFsRead)
    check(
      'missing commands dir → diagnostic, no throw',
      missing.diagnostics.some((d) => d.code === 'command_dir_missing'),
      JSON.stringify(missing.diagnostics)
    )
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }
}

async function main() {
  await runBridgeUnitChecks()
  await runHookUnitChecks()
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

    for (const fid of ['zprio-fixture@local', 'claude-fixture@local', 'codex-fixture@local']) {
      await ev(cdp, `window.electron.codex.uninstallPlugin(${JSON.stringify(fid)}).then(() => null)`)
    }

    const prioRoot = mkdtempSync(join(tmpdir(), 'flex-manifest-prio-'))
    const manifestDirs = [
      ['.zcode-plugin', 'zprio-fixture'],
      ['.claude-plugin', 'claude-fixture'],
      ['.codex-plugin', 'codex-fixture'],
      ['.cursor-plugin', 'cursor-fixture'],
      ['', 'root-fixture']
    ]
    for (const [dir, name] of manifestDirs) {
      const target = dir ? join(prioRoot, dir) : prioRoot
      mkdirSync(target, { recursive: true })
      writeFileSync(
        join(target, 'plugin.json'),
        JSON.stringify({ name, version: '1.0.0', description: `${name} manifest` }, null, 2),
        'utf8'
      )
    }
    mkdirSync(join(prioRoot, 'commands'), { recursive: true })
    writeFileSync(
      join(prioRoot, 'commands', 'demo.md'),
      '---\nname: demo\ndescription: demo command for acceptance\n---\nSummarize: $ARGUMENTS',
      'utf8'
    )

    const prioInstall = await ev(
      cdp,
      `window.electron.codex.installPlugin({ source: { kind: 'directory', path: ${JSON.stringify(prioRoot)} } })`
    )
    check(
      'manifest discovery: .zcode-plugin wins over claude/codex/cursor/root',
      prioInstall.ok === true && prioInstall.v?.id === 'zprio-fixture@local',
      prioInstall.v?.id || prioInstall.error || ''
    )
    check(
      'componentCounts command=1 (commands dir convention)',
      prioInstall.ok === true && prioInstall.v?.componentCounts?.command === 1,
      JSON.stringify(prioInstall.v?.componentCounts || {})
    )

    const prioDetail = await ev(cdp, `window.electron.codex.getPlugin('zprio-fixture@local')`)
    const cmds = prioDetail.ok
      ? prioDetail.v.components.filter((c) => c.kind === 'command')
      : []
    check(
      'commands/demo.md enumerated as component kind command',
      prioDetail.ok === true && cmds.length === 1 && cmds[0]?.path === 'commands/demo.md',
      JSON.stringify(cmds)
    )
    check(
      'command component frontmatter name/description',
      cmds[0]?.name === 'demo' && cmds[0]?.description === 'demo command for acceptance',
      JSON.stringify(cmds[0] || null)
    )
    await ev(cdp, `window.electron.codex.uninstallPlugin('zprio-fixture@local')`)
    rmSync(prioRoot, { recursive: true, force: true })

    const claudeRoot = mkdtempSync(join(tmpdir(), 'flex-manifest-claude-'))
    for (const [dir, name] of [
      ['.claude-plugin', 'claude-fixture'],
      ['.codex-plugin', 'codex-fixture'],
      ['', 'claude-root-fixture']
    ]) {
      const target = dir ? join(claudeRoot, dir) : claudeRoot
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
    }
    const claudeInstall = await ev(
      cdp,
      `window.electron.codex.installPlugin({ source: { kind: 'directory', path: ${JSON.stringify(claudeRoot)} } })`
    )
    check(
      'manifest discovery: .claude-plugin wins over .codex-plugin/root',
      claudeInstall.ok === true && claudeInstall.v?.id === 'claude-fixture@local',
      claudeInstall.v?.id || claudeInstall.error || ''
    )
    await ev(cdp, `window.electron.codex.uninstallPlugin('claude-fixture@local')`)
    rmSync(claudeRoot, { recursive: true, force: true })

    const codexRoot = mkdtempSync(join(tmpdir(), 'flex-manifest-codex-'))
    for (const [dir, name] of [
      ['.codex-plugin', 'codex-fixture'],
      ['.cursor-plugin', 'cursor-fixture'],
      ['', 'codex-root-fixture']
    ]) {
      const target = dir ? join(codexRoot, dir) : codexRoot
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
    }
    const codexInstall = await ev(
      cdp,
      `window.electron.codex.installPlugin({ source: { kind: 'directory', path: ${JSON.stringify(codexRoot)} } })`
    )
    check(
      'manifest discovery: .codex-plugin wins over .cursor-plugin/root',
      codexInstall.ok === true && codexInstall.v?.id === 'codex-fixture@local',
      codexInstall.v?.id || codexInstall.error || ''
    )
    await ev(cdp, `window.electron.codex.uninstallPlugin('codex-fixture@local')`)
    rmSync(codexRoot, { recursive: true, force: true })

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

async function runHookUnitChecks() {
  const { readFileSync, existsSync } = await import('fs')
  const throwMessage = (fn) => {
    try {
      fn()
      return ''
    } catch (err) {
      return String((err && err.message) || err)
    }
  }

  let userConfig = null
  let hookSources = null
  let hookRunner = null
  let bridge = null

  try {
    userConfig = await import(new URL('../src/main/userConfig.ts', import.meta.url).href)
    check('hook: userConfig module import (type-stripped, no Electron)', true)
  } catch (err) {
    check('hook: userConfig module import (type-stripped, no Electron)', false, String((err && err.message) || err))
  }
  try {
    hookSources = await import(new URL('../src/main/hookSources.ts', import.meta.url).href)
    check('hook: hookSources module import (type-stripped, no Electron)', true)
  } catch (err) {
    check('hook: hookSources module import (type-stripped, no Electron)', false, String((err && err.message) || err))
  }
  try {
    hookRunner = await import(new URL('../src/main/hooks/hookRunner.ts', import.meta.url).href)
    check('hook: hookRunner module import (type-stripped, no Electron)', true)
  } catch (err) {
    check('hook: hookRunner module import (type-stripped, no Electron)', false, String((err && err.message) || err))
  }
  try {
    bridge = await import(new URL('../src/main/pluginBridge.ts', import.meta.url).href)
    check(
      'hook: bridge hook exports import (type-stripped, no Electron)',
      typeof bridge.registerPluginHooks === 'function' &&
        typeof bridge.HOOK_EVENT_MAP === 'object' &&
        typeof bridge.matchesHookMatcher === 'function'
    )
  } catch (err) {
    check('hook: bridge hook exports import (type-stripped, no Electron)', false, String((err && err.message) || err))
  }
  if (!userConfig || !hookSources || !hookRunner || !bridge) return

  {
    const decl = { greet: { default: 'hello' }, retries: { default: 1 }, drop: { default: 'x' } }
    const values = userConfig.resolveUserConfigValues(decl, { retries: 5, extra: 'kept' })
    check(
      'hook: resolveUserConfigValues default, configured wins, extra kept',
      values.greet === 'hello' && values.retries === 5 && values.drop === 'x' && values.extra === 'kept',
      JSON.stringify(values)
    )
    const ctx = {
      values: { greet: 'hi', retries: 5 },
      sensitiveKeys: ['token'],
      plugin: { rootPath: '/plug/root', dataPath: '/plug/data', id: 'p@local', name: 'P' },
      projectDir: '/work'
    }
    check(
      'hook: interpolate user_config value',
      userConfig.interpolateHookTemplate('msg ${user_config.greet}', ctx) === 'msg hi'
    )
    check(
      'hook: interpolate userConfig camelCase alias',
      userConfig.interpolateHookTemplate('r=${userConfig.retries}', ctx) === 'r=5'
    )
    check(
      'hook: interpolate zcode and flex plugin variables',
      userConfig.interpolateHookTemplate(
        '${ZCODE_PLUGIN_ROOT}|${FLEX_PLUGIN_DATA}|${ZCODE_PLUGIN_ID}|${ZCODE_PLUGIN_NAME}|${FLEX_PROJECT_DIR}',
        ctx
      ) === '/plug/root|/plug/data|p@local|P|/work'
    )
    check(
      'hook: interpolate claude plugin and project variables',
      userConfig.interpolateHookTemplate('${CLAUDE_PLUGIN_ROOT}|${CLAUDE_PLUGIN_DATA}|${CLAUDE_PROJECT_DIR}', ctx) ===
        '/plug/root|/plug/data|/work'
    )
    check(
      'hook: unknown template left as-is',
      userConfig.interpolateHookTemplate('x ${unknown_thing} y', ctx) === 'x ${unknown_thing} y'
    )
    const sensitiveMsg = throwMessage(() => userConfig.interpolateHookTemplate('${user_config.token}', ctx))
    check('hook: sensitive user_config throws', /Sensitive/.test(sensitiveMsg), sensitiveMsg)
    const missingMsg = throwMessage(() => userConfig.interpolateHookTemplate('${user_config.nope}', ctx))
    check('hook: missing user_config throws', /Missing/.test(missingMsg), missingMsg)
    const sessionMsg = throwMessage(() => userConfig.interpolateHookTemplate('${CLAUDE_CODE_SESSION_ID}', ctx))
    check('hook: session variable throws', /session context/.test(sessionMsg), sessionMsg)
    const skillMsg = throwMessage(() => userConfig.interpolateHookTemplate('${FLEX_SKILL_DIR}', ctx))
    check('hook: skill variable throws', /skill context/.test(skillMsg), skillMsg)
    check(
      'hook: interpolateHookArgs maps elements',
      JSON.stringify(userConfig.interpolateHookArgs(['${user_config.greet}', 'lit'], ctx)) === '["hi","lit"]'
    )
  }

  {
    const expectedMap = {
      SessionStart: 'session_start',
      SessionEnd: 'session_shutdown',
      PreCompact: 'session_before_compact',
      PostCompact: 'session_compact',
      SessionCompact: 'session_compact',
      PreToolUse: 'tool_execution_start',
      PostToolUse: 'tool_execution_end'
    }
    const entries = Object.entries(expectedMap)
    check(
      'hook: HOOK_EVENT_MAP has the 7 mandated mappings',
      entries.length === Object.keys(bridge.HOOK_EVENT_MAP).length &&
        entries.every(([event, kernelEvent]) => bridge.HOOK_EVENT_MAP[event] === kernelEvent),
      JSON.stringify(bridge.HOOK_EVENT_MAP)
    )
    check('hook: isMappedHookEvent rejects UserPromptSubmit', bridge.isMappedHookEvent('UserPromptSubmit') === false)
    check('hook: isMappedHookEvent accepts SessionStart', bridge.isMappedHookEvent('SessionStart') === true)
    check(
      'hook: matcher star or undefined matches any',
      bridge.matchesHookMatcher(undefined, '*') === true &&
        bridge.matchesHookMatcher('Write', '*') === true &&
        bridge.matchesHookMatcher('Write', undefined) === true
    )
    check(
      'hook: matcher pipe splits on pipe',
      bridge.matchesHookMatcher('write', 'write|edit') === true &&
        bridge.matchesHookMatcher('read', 'write|edit') === false
    )
    check(
      'hook: matcher regex tested when not simple',
      bridge.matchesHookMatcher('edit', '^e.+t$') === true && bridge.matchesHookMatcher('run', '^e.+t$') === false
    )
    check('hook: invalid regex matcher returns false', bridge.matchesHookMatcher('anything', '[') === false)
    check(
      'hook: concrete matcher with no match value false',
      bridge.matchesHookMatcher(undefined, 'write') === false
    )
  }

  const discRoot = mkdtempSync(join(tmpdir(), 'flex-hookdisc-'))
  try {
    mkdirSync(join(discRoot, 'hooks'), { recursive: true })
    writeFileSync(join(discRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }), 'utf8')

    const standard = hookSources.discoverHookSources({ rootPath: discRoot })
    check(
      'hook: standard hooks/hooks.json discovered without manifest',
      standard.sources.length === 1 &&
        standard.sources[0].path === join(discRoot, 'hooks', 'hooks.json') &&
        standard.diagnostics.length === 0,
      JSON.stringify({ sources: standard.sources.length, diagnostics: standard.diagnostics })
    )
    const dup = hookSources.discoverHookSources({ rootPath: discRoot, manifestHooks: 'hooks/hooks.json' })
    check(
      'hook: manifest duplicate of standard path warns plugin_hook_duplicate',
      dup.sources.length === 1 && dup.diagnostics.some((d) => d.code === 'plugin_hook_duplicate'),
      JSON.stringify(dup.diagnostics)
    )
    const escape = hookSources.discoverHookSources({ rootPath: discRoot, manifestHooks: '../outside.json' })
    check(
      'hook: manifest path escaping root errors plugin_component_path_invalid',
      escape.diagnostics.some((d) => d.code === 'plugin_component_path_invalid'),
      JSON.stringify(escape.diagnostics)
    )
    const missing = hookSources.discoverHookSources({ rootPath: discRoot, manifestHooks: 'hooks/missing.json' })
    check(
      'hook: missing manifest hooks path errors plugin_hook_read_failed',
      missing.diagnostics.some((d) => d.code === 'plugin_hook_read_failed' && /not found/.test(d.message)),
      JSON.stringify(missing.diagnostics)
    )
    const inline = hookSources.discoverHookSources({ rootPath: discRoot, manifestHooks: { SessionStart: [] } })
    check(
      'hook: inline manifest hooks warns plugin_unsupported_component',
      inline.diagnostics.some((d) => d.code === 'plugin_unsupported_component'),
      JSON.stringify(inline.diagnostics)
    )
  } finally {
    try {
      rmSync(discRoot, { recursive: true, force: true })
    } catch {}
  }

  {
    const parseContent = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'greet-cmd', timeout: 2 }] }],
        PreToolUse: [
          { matcher: 'write|edit', hooks: [{ type: 'process', command: 'run-cmd', args: ['-e', 'b'], timeoutMs: 500 }] }
        ],
        PostToolUse: [
          {
            hooks: [
              { type: 'command', command: 'on-end' },
              { type: 'command', command: 'off-end', enabled: false }
            ]
          },
          { matcher: '', hooks: [{ type: 'command', command: 'empty-matcher' }] }
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'prompt-cmd' }] }]
      }
    })
    const parsed = hookSources.parseHooksContent(parseContent, join('hooks', 'hooks.json'))
    check(
      'hook: parse yields 4 entries',
      parsed.entries.length === 4,
      JSON.stringify(parsed.entries.map((e) => e.event))
    )
    const sessionStart = parsed.entries.find((e) => e.event === 'SessionStart')
    check(
      'hook: SessionStart star matcher and timeout seconds converted to ms',
      sessionStart !== undefined &&
        sessionStart.matcher === '*' &&
        sessionStart.timeoutMs === 2000 &&
        sessionStart.type === 'command' &&
        sessionStart.command === 'greet-cmd',
      JSON.stringify(sessionStart ?? null)
    )
    const preTool = parsed.entries.find((e) => e.event === 'PreToolUse')
    check(
      'hook: PreToolUse pipe matcher args and timeoutMs passthrough',
      preTool !== undefined &&
        preTool.matcher === 'write|edit' &&
        preTool.type === 'process' &&
        JSON.stringify(preTool.args ?? null) === JSON.stringify(['-e', 'b']) &&
        preTool.timeoutMs === 500,
      JSON.stringify(preTool ?? null)
    )
    const postToolEntries = parsed.entries.filter((e) => e.event === 'PostToolUse')
    check(
      'hook: enabled false skipped and empty matcher group invalid',
      postToolEntries.length === 1 &&
        postToolEntries[0].command === 'on-end' &&
        parsed.diagnostics.some((d) => d.code === 'plugin_hook_invalid'),
      JSON.stringify(parsed.diagnostics)
    )
    check(
      'hook: unsupported event preserved at parse time',
      parsed.entries.some((e) => e.event === 'UserPromptSubmit' && e.command === 'prompt-cmd')
    )
    const malformed = hookSources.parseHooksContent('{not json', 'hooks.json')
    check(
      'hook: malformed JSON errors plugin_hook_read_failed',
      malformed.entries.length === 0 && malformed.diagnostics.some((d) => d.code === 'plugin_hook_read_failed'),
      JSON.stringify(malformed.diagnostics)
    )
    const notHooks = hookSources.parseHooksContent('{"nope":true}', 'hooks.json')
    check(
      'hook: root without hooks object errors plugin_hook_invalid',
      notHooks.entries.length === 0 && notHooks.diagnostics.some((d) => d.code === 'plugin_hook_invalid'),
      JSON.stringify(notHooks.diagnostics)
    )
  }

  {
    const rcwd = process.cwd()
    const echoEnvScript =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({stdin:d,root:process.env.ZCODE_PLUGIN_ROOT||'',data:process.env.FLEX_PLUGIN_DATA||'',proj:process.env.FLEX_PROJECT_DIR||''}))})"
    const echoRun = await hookRunner.runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', echoEnvScript],
      cwd: rcwd,
      stdin: '{"hook_event_name":"SessionStart"}\n',
      plugin: { rootPath: '/plug/root', dataPath: '/plug/data', id: 'p@local', name: 'P' }
    })
    let echoOut = null
    if (echoRun.status === 'ok' && echoRun.output) {
      echoOut = echoRun.output
    }
    let echoStdin = null
    if (echoOut && typeof echoOut.stdin === 'string') {
      try {
        echoStdin = JSON.parse(echoOut.stdin)
      } catch {}
    }
    check(
      'hook: runHook echoes stdin and applies plugin env overlay',
      echoRun.status === 'ok' &&
        echoOut !== null &&
        echoStdin !== null &&
        echoStdin.hook_event_name === 'SessionStart' &&
        echoOut.root === '/plug/root' &&
        echoOut.data === '/plug/data' &&
        echoOut.proj === rcwd,
      JSON.stringify({ status: echoRun.status, out: echoOut, diagnostics: echoRun.diagnostics })
    )

    const plainRun = await hookRunner.runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', "process.stdout.write('plain text')"],
      cwd: rcwd
    })
    check(
      'hook: exit 0 non-JSON stdout stays ok with output undefined',
      plainRun.status === 'ok' &&
        plainRun.exitCode === 0 &&
        plainRun.output === undefined &&
        plainRun.diagnostics.length === 0,
      JSON.stringify({ status: plainRun.status, output: plainRun.output ?? null })
    )

    const invalidScript = 'process.stdout.write(' + JSON.stringify('{"continue":"yes"}') + ')'
    const invalidRun = await hookRunner.runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', invalidScript],
      cwd: rcwd
    })
    check(
      'hook: schema-invalid stdout fails with hook_output_invalid',
      invalidRun.status === 'failed' &&
        invalidRun.diagnostics.some((d) => d.code === 'hook_output_invalid'),
      JSON.stringify(invalidRun.diagnostics)
    )

    const validScript = 'process.stdout.write(' + JSON.stringify('{"continue":false,"reason":"nope"}') + ')'
    const validRun = await hookRunner.runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', validScript],
      cwd: rcwd
    })
    check(
      'hook: valid JSON stdout parses into output',
      validRun.status === 'ok' &&
        validRun.output &&
        validRun.output.continue === false &&
        validRun.output.reason === 'nope',
      JSON.stringify(validRun.output ?? null)
    )

    const failRun = await hookRunner.runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', "process.stderr.write('boom');process.exit(1)"],
      cwd: rcwd
    })
    check(
      'hook: nonzero exit fails with hook_exit_nonzero carrying stderr',
      failRun.status === 'failed' &&
        failRun.diagnostics.some((d) => d.code === 'hook_exit_nonzero' && /boom/.test(d.message)),
      JSON.stringify(failRun.diagnostics)
    )

    const blockRun = await hookRunner.runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', "process.stderr.write('blocked by test');process.exit(2)"],
      cwd: rcwd
    })
    check(
      'hook: exit 2 sets ok with blockRequested and blockReason',
      blockRun.status === 'ok' &&
        blockRun.blockRequested === true &&
        blockRun.blockReason === 'blocked by test',
      JSON.stringify({
        status: blockRun.status,
        blockRequested: blockRun.blockRequested,
        blockReason: blockRun.blockReason
      })
    )

    const startedAt = Date.now()
    const timeoutRun = await hookRunner.runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},10000)'],
      cwd: rcwd,
      timeoutMs: 300
    })
    check(
      'hook: timeoutMs 300 kills sleep with hook_timeout under 5000ms',
      timeoutRun.status === 'timeout' &&
        timeoutRun.diagnostics.some((d) => d.code === 'hook_timeout') &&
        Date.now() - startedAt < 5000,
      JSON.stringify({ status: timeoutRun.status, diagnostics: timeoutRun.diagnostics })
    )

    const spawnRun = await hookRunner.runHook({
      type: 'process',
      command: join(rcwd, 'flex-missing-hook-binary-' + Date.now()),
      args: [],
      cwd: rcwd
    })
    check(
      'hook: missing binary resolves spawn_error with hook_spawn_error',
      spawnRun.status === 'spawn_error' &&
        spawnRun.diagnostics.some((d) => d.code === 'hook_spawn_error'),
      JSON.stringify(spawnRun.diagnostics)
    )

    const truncRun = await hookRunner.runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(500))'],
      cwd: rcwd,
      maxOutputBytes: 100
    })
    check(
      'hook: maxOutputBytes 100 truncates large stdout',
      truncRun.status === 'ok' && truncRun.truncated === true && truncRun.stdout.length === 100,
      JSON.stringify({ status: truncRun.status, len: truncRun.stdout.length, truncated: truncRun.truncated })
    )

    check(
      'hook: resolveHookTimeoutMs converts command seconds to ms',
      hookRunner.resolveHookTimeoutMs({ type: 'command', timeout: 2 }) === 2000
    )
    check(
      'hook: resolveHookTimeoutMs prefers explicit timeoutMs',
      hookRunner.resolveHookTimeoutMs({ type: 'command', timeoutMs: 1234, timeout: 9 }) === 1234
    )
    check(
      'hook: resolveHookTimeoutMs process ignores seconds uses default',
      hookRunner.resolveHookTimeoutMs({ type: 'process', timeout: 2 }) === 60000
    )
    check(
      'hook: resolveHookTimeoutMs default is 60000',
      hookRunner.resolveHookTimeoutMs({ type: 'command' }) === 60000
    )

    const overlay = hookRunner.createHookEnvOverlay({ rootPath: '/r', dataPath: '/d', id: 'i', name: 'n' }, '/cwd')
    check(
      'hook: createHookEnvOverlay sets plugin and project vars',
      overlay.CLAUDE_PROJECT_DIR === '/cwd' &&
        overlay.ZCODE_PROJECT_DIR === '/cwd' &&
        overlay.FLEX_PROJECT_DIR === '/cwd' &&
        overlay.CLAUDE_PLUGIN_ROOT === '/r' &&
        overlay.CLAUDE_PLUGIN_DATA === '/d' &&
        overlay.ZCODE_PLUGIN_ROOT === '/r' &&
        overlay.ZCODE_PLUGIN_ID === 'i' &&
        overlay.ZCODE_PLUGIN_NAME === 'n' &&
        overlay.FLEX_PLUGIN_ROOT === '/r' &&
        overlay.FLEX_PLUGIN_DATA === '/d' &&
        overlay.FLEX_PLUGIN_ID === 'i' &&
        overlay.FLEX_PLUGIN_NAME === 'n',
      JSON.stringify(overlay)
    )
    const bareOverlay = hookRunner.createHookEnvOverlay(undefined, '/cwd2')
    check(
      'hook: createHookEnvOverlay without plugin only project vars',
      bareOverlay.FLEX_PROJECT_DIR === '/cwd2' &&
        bareOverlay.ZCODE_PLUGIN_ROOT === undefined &&
        Object.keys(bareOverlay).length === 3,
      JSON.stringify(bareOverlay)
    )
  }

  const fireRoot = mkdtempSync(join(tmpdir(), 'flex-hookfire-'))
  try {
    const missingDiagnostics = []
    const missingResult = bridge.registerPluginHooks(
      {
        extensionPaths: [],
        skillRoots: [],
        commands: [],
        hooks: [join(fireRoot, 'hooks', 'nope.json')],
        hookContexts: {},
        mcp: [],
        pluginStorageRoot: fireRoot
      },
      () => {},
      bridge.nodeBridgeFsRead,
      {
        parseHooksContent: hookSources.parseHooksContent,
        interpolate: userConfig.interpolateHookTemplate,
        runHook: hookRunner.runHook
      },
      missingDiagnostics
    )
    check(
      'hook: unreadable hooks file registers nothing with read failed',
      missingResult.registered === 0 &&
        missingDiagnostics.some((d) => d.code === 'plugin_hook_read_failed'),
      JSON.stringify(missingDiagnostics)
    )

    mkdirSync(join(fireRoot, 'hooks'), { recursive: true })
    const markerA = join(fireRoot, 'marker-a.json')
    const markerB = join(fireRoot, 'marker-b.json')
    const stdinEnvScript =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{require('fs').writeFileSync(" +
      JSON.stringify(markerA) +
      ",JSON.stringify({stdin:d,root:process.env.ZCODE_PLUGIN_ROOT||'',data:process.env.FLEX_PLUGIN_DATA||'',proj:process.env.FLEX_PROJECT_DIR||''}))})"
    const writeMarkerScript =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{require('fs').writeFileSync(" +
      JSON.stringify(markerB) +
      ',d)})'
    const hooksPath = join(fireRoot, 'hooks', 'hooks.json')
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'process', command: process.execPath, args: ['-e', stdinEnvScript] }] }
            ],
            PreToolUse: [
              {
                matcher: 'write',
                hooks: [{ type: 'process', command: process.execPath, args: ['-e', writeMarkerScript] }]
              }
            ],
            SessionEnd: [
              { hooks: [{ type: 'process', command: '${user_config.nope}' }] },
              { hooks: [{ type: 'process', command: '${user_config.token}' }] }
            ],
            SessionCompact: [
              {
                hooks: [
                  {
                    type: 'process',
                    command: process.execPath,
                    args: ['-e', "process.stderr.write('blocked by test');process.exit(2)"]
                  }
                ]
              }
            ],
            UserPromptSubmit: [
              { hooks: [{ type: 'process', command: process.execPath, args: ['-e', 'process.exit(0)'] }] }
            ]
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const fireDiagnostics = []
    const handlers = new Map()
    const on = (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    }
    const deps = {
      parseHooksContent: hookSources.parseHooksContent,
      interpolate: userConfig.interpolateHookTemplate,
      runHook: hookRunner.runHook
    }
    const spec = {
      extensionPaths: [],
      skillRoots: [],
      commands: [],
      hooks: [hooksPath],
      hookContexts: {
        [hooksPath]: {
          pluginRoot: fireRoot,
          pluginId: 'fire@local',
          pluginName: 'Fire Fixture',
          userConfig: { greet: 'hi' },
          sensitiveKeys: ['token']
        }
      },
      mcp: [],
      pluginStorageRoot: fireRoot
    }
    const result = bridge.registerPluginHooks(spec, on, bridge.nodeBridgeFsRead, deps, fireDiagnostics)
    check(
      'hook: registerPluginHooks registers 5 mapped entries',
      result.registered === 5,
      `registered=${result.registered}`
    )
    const unsupported = fireDiagnostics.filter((d) => d.code === 'plugin_unsupported_hook')
    check(
      'hook: unsupported UserPromptSubmit reported exactly once',
      unsupported.length === 1 && /UserPromptSubmit/.test(unsupported[0].message),
      JSON.stringify(fireDiagnostics)
    )
    check(
      'hook: handlers bound to mandated kernel events only',
      handlers.has('session_start') &&
        handlers.has('tool_execution_start') &&
        handlers.has('session_shutdown') &&
        handlers.has('session_compact') &&
        !handlers.has('session_before_compact') &&
        (handlers.get('session_shutdown') || []).length === 2,
      JSON.stringify([...handlers.keys()])
    )
    const dataDir = join(fireRoot, 'data', 'fire@local')
    check('hook: plugin data dir created at registration', existsSync(dataDir), dataDir)

    const fire = async (event, payload = {}, ctx = {}) => {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, { cwd: fireRoot, ...ctx })
      }
    }

    await fire('session_start')
    let startMarker = null
    try {
      startMarker = JSON.parse(readFileSync(markerA, 'utf8'))
    } catch {}
    check(
      'hook: SessionStart fire writes stdin and plugin env to marker',
      startMarker !== null &&
        String(startMarker.stdin).includes('SessionStart') &&
        startMarker.root === fireRoot &&
        startMarker.data === dataDir &&
        startMarker.proj === fireRoot,
      JSON.stringify(startMarker)
    )

    await fire('tool_execution_start', { toolName: 'read', toolCallId: 't0', args: {} })
    const readSkipped = !existsSync(markerB)
    await fire('tool_execution_start', { toolName: 'write', toolCallId: 't1', args: { file: 'x' } })
    check('hook: PreToolUse matcher skips non-write tool', readSkipped, `markerB absent after read=${readSkipped}`)
    let writeMarker = null
    try {
      writeMarker = JSON.parse(readFileSync(markerB, 'utf8'))
    } catch {}
    check(
      'hook: PreToolUse matcher runs on write tool with tool_name in stdin',
      writeMarker !== null && writeMarker.tool_name === 'write' && writeMarker.tool_use_id === 't1',
      JSON.stringify(writeMarker)
    )

    await fire('session_shutdown')
    const interp = fireDiagnostics.filter((d) => d.code === 'hook_interpolation_failed')
    check(
      'hook: interpolation failures yield missing and sensitive diagnostics',
      interp.length === 2 &&
        interp.some((d) => /Missing/.test(d.message)) &&
        interp.some((d) => /Sensitive/.test(d.message)),
      JSON.stringify(interp)
    )

    await fire('session_compact')
    const blockDiags = fireDiagnostics.filter((d) => d.code === 'hook_block_ignored')
    check(
      'hook: exit 2 block surfaced as hook_block_ignored with reason',
      blockDiags.length === 1 &&
        /not enforced in P2c/.test(blockDiags[0].message) &&
        /blocked by test/.test(blockDiags[0].message),
      JSON.stringify(blockDiags)
    )
  } finally {
    try {
      rmSync(fireRoot, { recursive: true, force: true })
    } catch {}
  }

  try {
    const workerSrc = readFileSync(new URL('../src/main/worker.ts', import.meta.url), 'utf8')
    check(
      'hook: worker wires hookDeps into bridge factory',
      workerSrc.includes('createPluginBridgeFactory(pluginResourceSpec, undefined, hookDeps)')
    )
    check(
      'hook: worker drains inflight hook runs before exit',
      workerSrc.includes('await settleHookRuns()') && workerSrc.includes('inflightHookRuns')
    )
  } catch (err) {
    const message = String((err && err.message) || err)
    check('hook: worker wires hookDeps into bridge factory', false, message)
    check('hook: worker drains inflight hook runs before exit', false, message)
  }

  let cdp = null
  let hookFixtureDir = null
  try {
    const targets = await listTargets()
    const page = pickPage(targets)
    if (!page) {
      check('hook CDP: page target available', false, 'no page target with CDP')
      return
    }
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.connect()
    const bridged = await waitForBridge(cdp)
    check('hook CDP: bridge available for hook fixture', bridged)
    if (!bridged) return

    const hookId = 'accept-hook-fixture@local'
    await ev(cdp, `window.electron.codex.uninstallPlugin(${JSON.stringify(hookId)}).then(() => null)`)

    hookFixtureDir = mkdtempSync(join(tmpdir(), 'flex-hookfixture-'))
    mkdirSync(join(hookFixtureDir, '.flex-plugin'), { recursive: true })
    writeFileSync(
      join(hookFixtureDir, '.flex-plugin', 'plugin.json'),
      JSON.stringify(
        { name: 'accept-hook-fixture', version: '1.0.0', description: 'hook enumeration fixture' },
        null,
        2
      ),
      'utf8'
    )
    mkdirSync(join(hookFixtureDir, 'hooks'), { recursive: true })
    writeFileSync(
      join(hookFixtureDir, 'hooks', 'hooks.json'),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo hook-ok' }] }],
            PostToolUse: [
              { matcher: 'write', hooks: [{ type: 'command', command: 'echo hook-ok' }] }
            ],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hook-ok' }] }]
          }
        },
        null,
        2
      ),
      'utf8'
    )
    mkdirSync(join(hookFixtureDir, 'commands'), { recursive: true })
    writeFileSync(
      join(hookFixtureDir, 'commands', 'demo.md'),
      '---\nname: demo-hook\ndescription: slash completion fixture\n---\nRun: $ARGUMENTS',
      'utf8'
    )

    const install = await ev(
      cdp,
      `window.electron.codex.installPlugin({ source: { kind: 'directory', path: ${JSON.stringify(hookFixtureDir)} } })`
    )
    check('hook CDP: install hook fixture', install.ok === true, install.error || install.v?.id || '')
    check(
      'hook CDP: componentCounts hook=2',
      install.ok === true && install.v?.componentCounts?.hook === 2,
      JSON.stringify(install.v?.componentCounts || {})
    )

    const detail = await ev(cdp, `window.electron.codex.getPlugin(${JSON.stringify(hookId)})`)
    check('hook CDP: getPlugin hook fixture', detail.ok === true, detail.error || '')
    if (detail.ok) {
      const hookComponents = detail.v.components.filter((c) => c.kind === 'hook')
      const hookNames = hookComponents.map((c) => c.name).sort()
      check(
        'hook CDP: hook components are SessionStart and PostToolUse from hooks/hooks.json',
        hookComponents.length === 2 &&
          hookNames[0] === 'PostToolUse' &&
          hookNames[1] === 'SessionStart' &&
          hookComponents.every((c) => c.path === 'hooks/hooks.json'),
        JSON.stringify(hookComponents)
      )
      const unsupportedDiags = (detail.v.diagnostics || []).filter((d) => d.code === 'plugin_unsupported_hook')
      check(
        'hook CDP: UserPromptSubmit surfaces as warning diagnostic',
        unsupportedDiags.length === 1 &&
          unsupportedDiags[0].severity === 'warning' &&
          /UserPromptSubmit/.test(unsupportedDiags[0].message),
        JSON.stringify(unsupportedDiags)
      )
    } else {
      check('hook CDP: hook components are SessionStart and PostToolUse from hooks/hooks.json', false, detail.error || '')
      check('hook CDP: UserPromptSubmit surfaces as warning diagnostic', false, detail.error || '')
    }

    const slash = await ev(cdp, `window.electron.codex.listSlashCommands()`)
    check(
      'slash IPC: listSlashCommands resolves to an array',
      slash.ok === true && Array.isArray(slash.v),
      slash.error || JSON.stringify(slash.v)
    )
    const slashEntry = slash.ok ? slash.v.find((c) => c.name === 'demo-hook') : null
    check(
      'slash IPC: includes installed command with description and pluginId',
      !!slashEntry &&
        slashEntry.description === 'slash completion fixture' &&
        slashEntry.pluginId === hookId,
      JSON.stringify(slashEntry || slash.error || null)
    )

    const uninstall = await ev(cdp, `window.electron.codex.uninstallPlugin(${JSON.stringify(hookId)})`)
    check('hook CDP: uninstall hook fixture', uninstall.ok === true, uninstall.error || '')

    const slashAfter = await ev(cdp, `window.electron.codex.listSlashCommands()`)
    const slashGone =
      slashAfter.ok &&
      Array.isArray(slashAfter.v) &&
      !slashAfter.v.some((c) => c.pluginId === hookId)
    check(
      'slash IPC: entries removed after uninstall',
      slashGone,
      JSON.stringify(slashAfter.v || slashAfter.error || null)
    )
  } catch (err) {
    check('hook CDP: fixture flow', false, String((err && err.message) || err))
    await ev(cdp, `window.electron.codex.uninstallPlugin(${JSON.stringify(hookId)}).then(() => null)`)
  } finally {
    if (hookFixtureDir) {
      try {
        rmSync(hookFixtureDir, { recursive: true, force: true })
      } catch {}
    }
    if (cdp) cdp.close()
  }
}
