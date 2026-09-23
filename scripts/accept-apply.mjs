/**
 * applyFileChanges acceptance (contract v1.2) against real Electron via CDP.
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 * Path:
 *   apply under temp session cwd → file content matches patch result
 *   re-apply → alreadyApplied (idempotent)
 *   path escape ../ and absolute → failed[] or reject, nothing outside cwd written
 *   running session → SESSION_BUSY
 *   unknown sessionId → SESSION_NOT_FOUND
 *   empty files / bad input → INVALID_INPUT
 */
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const CDP_HTTP = 'http://127.0.0.1:9222'
const HOST_CWD = 'D:/2026/FlexAgent'
const TEST_ROOT = join(HOST_CWD, '.tmp-apply-accept')
const TIMEOUT_MS = 60_000

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
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
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
      }, method === 'Runtime.evaluate' ? 60_000 : 15_000)
    })
  }
  close() { try { this.ws.close() } catch { /* already closed */ } }
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
    throw new Error(d.exception?.description || d.text || 'evaluate exception')
  }
  return result.result?.value
}

function setupWorkspace() {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(join(TEST_ROOT, 'src'), { recursive: true })
  writeFileSync(
    join(TEST_ROOT, 'src', 'app.txt'),
    'line1\nline2\nline3\n',
    'utf8'
  )
}

function outsideMarker() {
  return join(HOST_CWD, 'escape-should-not-exist.txt')
}

const MODIFY_PATCH = [
  '--- a/src/app.txt',
  '+++ b/src/app.txt',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-line2',
  '+line2-changed',
  ' line3'
].join('\n')

const ADDED_PATCH = [
  '--- a/src/new-file.txt',
  '+++ b/src/new-file.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world'
].join('\n')

async function main() {
  setupWorkspace()
  const marker = outsideMarker()
  if (existsSync(marker)) rmSync(marker, { force: true })

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

  const report = await evaluate(cdp, `(async () => {
    const api = window.electron.codex
    const out = {}
    let session = null
    try {
      session = await api.createSession({
        cwd: ${JSON.stringify(TEST_ROOT)},
        title: 'apply-accept'
      })
      out.sessionId = session.id

      const modify = {
        path: 'src/app.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: ${JSON.stringify(MODIFY_PATCH)}
      }
      const added = {
        path: 'src/new-file.txt',
        status: 'added',
        additions: 2,
        deletions: 0,
        patch: ${JSON.stringify(ADDED_PATCH)}
      }

      const first = await api.applyFileChanges({ sessionId: session.id, files: [modify, added] })
      out.first = first

      const second = await api.applyFileChanges({ sessionId: session.id, files: [modify, added] })
      out.second = second

      const escapeRel = await api.applyFileChanges({
        sessionId: session.id,
        files: [{
          path: '../escape-should-not-exist.txt',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: '--- a/../escape-should-not-exist.txt\\n+++ b/../escape-should-not-exist.txt\\n@@ -0,0 +1,1 @@\\n+pwn'
        }]
      })
      out.escapeRel = escapeRel

      const escapeAbs = await api.applyFileChanges({
        sessionId: session.id,
        files: [{
          path: 'C:/Windows/Temp/escape-abs-should-not-exist.txt',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: '--- a/C:/Windows/Temp/escape-abs-should-not-exist.txt\\n+++ b/C:/Windows/Temp/escape-abs-should-not-exist.txt\\n@@ -0,0 +1,1 @@\\n+pwn'
        }]
      })
      out.escapeAbs = escapeAbs

      try {
        await api.applyFileChanges({ sessionId: 'no-such-' + Date.now(), files: [] })
        out.badSessionOk = false
      } catch (err) {
        out.badSessionOk = err && err.code === 'SESSION_NOT_FOUND'
        out.badSessionCode = err && err.code
      }

      try {
        await api.applyFileChanges({ sessionId: session.id, files: 'nope' })
        out.badInputOk = false
      } catch (err) {
        out.badInputOk = err && err.code === 'INVALID_INPUT'
        out.badInputCode = err && err.code
      }

      const promptAck = await api.prompt({
        sessionId: session.id,
        text: 'Start a long task so runState is running for SESSION_BUSY check'
      })
      out.promptDisposition = promptAck && promptAck.disposition
      await new Promise(r => setTimeout(r, 400))
      try {
        await api.applyFileChanges({ sessionId: session.id, files: [modify] })
        out.busyOk = false
      } catch (err) {
        out.busyOk = err && err.code === 'SESSION_BUSY'
        out.busyCode = err && err.code
      }
      try { await api.abort(session.id) } catch { /* may already be idle */ }

      return out
    } catch (err) {
      out.thrown = String(err && err.message ? err.message : err)
      out.code = err && err.code
      return out
    } finally {
      if (session) { try { await api.deleteSession(session.id) } catch {} }
    }
  })()`)

  cdp.close()

  const disk = {
    app: existsSync(join(TEST_ROOT, 'src', 'app.txt'))
      ? readFileSync(join(TEST_ROOT, 'src', 'app.txt'), 'utf8')
      : null,
    neu: existsSync(join(TEST_ROOT, 'src', 'new-file.txt'))
      ? readFileSync(join(TEST_ROOT, 'src', 'new-file.txt'), 'utf8')
      : null,
    escapedRel: existsSync(marker),
    escapedAbs: existsSync('C:/Windows/Temp/escape-abs-should-not-exist.txt')
  }

  console.log(JSON.stringify({ report, disk }, null, 2))

  const first = report && report.first
  const second = report && report.second
  const checks = {
    bridge: hasBridge,
    noThrow: !report || !report.thrown,
    firstApplied:
      first &&
      Array.isArray(first.applied) &&
      first.applied.includes('src/app.txt') &&
      first.applied.includes('src/new-file.txt') &&
      (first.failed || []).length === 0,
    diskModify: disk.app === 'line1\nline2-changed\nline3\n',
    diskAdd: disk.neu === 'hello\nworld\n',
    idempotent:
      second &&
      Array.isArray(second.alreadyApplied) &&
      second.alreadyApplied.includes('src/app.txt') &&
      (second.failed || []).length === 0,
    escapeRelBlocked: !disk.escapedRel,
    escapeAbsBlocked: !disk.escapedAbs,
    badSession: report && report.badSessionOk === true,
    badInput: report && report.badInputOk === true,
    busy: report && report.busyOk === true
  }

  console.error('CHECKS', JSON.stringify(checks))
  const pass = Object.values(checks).every(Boolean)
  if (pass) {
    console.error('ACCEPT_APPLY_PASS')
    process.exit(0)
  }
  console.error('ACCEPT_APPLY_FAIL')
  process.exit(1)
}

main().catch((err) => {
  console.error('ACCEPT_APPLY_ERROR', err?.stack || err)
  process.exit(4)
})
