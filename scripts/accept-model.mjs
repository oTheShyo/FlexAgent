/**
 * Contract v1.3 acceptance — listModels / getModelConfig / setModel / setThinkingLevel.
 * Requires: npm run dev -- -- --remote-debugging-port=9222
 */
const CDP_HTTP = 'http://127.0.0.1:9222'
const CWD = 'D:/2026/FlexAgent'
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
        `Boolean(window.electron?.codex && typeof window.electron.codex.listModels === 'function')`
      )
      if (ok) return true
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function main() {
  const targets = await listTargets()
  const page = pickPage(targets)
  if (!page) {
    console.error('No page target with CDP')
    process.exit(1)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  try {
    const bridged = await waitForBridge(cdp)
    check('bridge.listModels', bridged)
    if (!bridged) {
      console.error('ACCEPT_MODEL_FAIL')
      process.exit(1)
    }

    const listJson = await cdp.evaluate(`window.electron.codex.listModels().then(m => JSON.stringify({ ok: true, models: m }, null, 2)).catch(e => JSON.stringify({ ok: false, error: String(e && e.message || e), code: e && e.code }))`)
    const list = JSON.parse(listJson)
    check('listModels resolves', list.ok === true, list.error || '')
    check(
      'listModels returns array (may be empty without auth)',
      list.ok === true && Array.isArray(list.models),
      `len=${list.models?.length ?? 'n/a'}`
    )

    const createJson = await cdp.evaluate(
      `window.electron.codex.createSession({ cwd: ${JSON.stringify(CWD)} }).then(s => JSON.stringify({ ok: true, s })).catch(e => JSON.stringify({ ok: false, error: String(e && e.message || e), code: e && e.code }))`
    )
    const created = JSON.parse(createJson)
    check('createSession', created.ok === true, created.error || created.s?.id || '')
    if (!created.ok) {
      console.error('ACCEPT_MODEL_FAIL')
      process.exit(1)
    }
    const sessionId = created.s.id

    const cfgJson = await cdp.evaluate(
      `window.electron.codex.getModelConfig(${JSON.stringify(sessionId)}).then(c => JSON.stringify({ ok: true, c })).catch(e => JSON.stringify({ ok: false, error: String(e && e.message || e), code: e && e.code }))`
    )
    const cfg = JSON.parse(cfgJson)
    check('getModelConfig', cfg.ok === true, cfg.error || JSON.stringify(cfg.c))

    const models = list.models || []
    if (models.length > 0 && cfg.ok) {
      const target = models[0]
      const setJson = await cdp.evaluate(
        `window.electron.codex.setModel({ sessionId: ${JSON.stringify(sessionId)}, provider: ${JSON.stringify(target.provider)}, id: ${JSON.stringify(target.id)} }).then(c => JSON.stringify({ ok: true, c })).catch(e => JSON.stringify({ ok: false, error: String(e && e.message || e), code: e && e.code }))`
      )
      const set = JSON.parse(setJson)
      check('setModel', set.ok === true, set.error || JSON.stringify(set.c))
      check(
        'setModel returns matching model',
        set.ok === true && set.c?.model?.provider === target.provider && set.c?.model?.id === target.id
      )

      const thinkJson = await cdp.evaluate(
        `window.electron.codex.setThinkingLevel({ sessionId: ${JSON.stringify(sessionId)}, level: 'high' }).then(c => JSON.stringify({ ok: true, c })).catch(e => JSON.stringify({ ok: false, error: String(e && e.message || e), code: e && e.code }))`
      )
      const think = JSON.parse(thinkJson)
      check('setThinkingLevel high', think.ok === true, think.error || JSON.stringify(think.c))
      check(
        'setThinkingLevel applied (or clamped)',
        think.ok === true && typeof think.c?.thinkingLevel === 'string',
        think.c?.thinkingLevel || ''
      )
    } else {
      check('setModel skipped (no available models)', true, 'list empty — auth-dependent')
      check('setThinkingLevel skipped (no available models)', true, 'list empty — auth-dependent')
    }

    const badJson = await cdp.evaluate(
      `window.electron.codex.setModel({ sessionId: ${JSON.stringify(sessionId)}, provider: 'nope', id: 'nope' }).then(() => JSON.stringify({ ok: true })).catch(e => JSON.stringify({ ok: false, code: e && e.code, message: String(e && e.message || e) }))`
    )
    const bad = JSON.parse(badJson)
    check(
      'setModel unknown → INVALID_INPUT',
      bad.ok === false && bad.code === 'INVALID_INPUT',
      bad.code || bad.message || ''
    )

    const missingJson = await cdp.evaluate(
      `window.electron.codex.getModelConfig('no-such-session').then(() => JSON.stringify({ ok: true })).catch(e => JSON.stringify({ ok: false, code: e && e.code }))`
    )
    const missing = JSON.parse(missingJson)
    check(
      'getModelConfig missing → SESSION_NOT_FOUND',
      missing.ok === false && missing.code === 'SESSION_NOT_FOUND',
      missing.code || ''
    )

    await cdp.evaluate(
      `window.electron.codex.deleteSession(${JSON.stringify(sessionId)}).catch(() => {})`
    )

    const failed = CHECKS.filter((c) => !c.ok)
    console.log(`\nCHECKS ${CHECKS.length - failed.length}/${CHECKS.length}`)
    if (failed.length) {
      console.error('ACCEPT_MODEL_FAIL')
      process.exit(1)
    }
    console.error('ACCEPT_MODEL_PASS')
    process.exit(0)
  } finally {
    cdp.close()
  }
}

main().catch((err) => {
  console.error(err)
  console.error('ACCEPT_MODEL_FAIL')
  process.exit(1)
})
