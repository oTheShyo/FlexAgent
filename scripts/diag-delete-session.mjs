/**
 * Ticket 29 deletion acceptance — real app, real registry, real transcript files.
 *
 *   node scripts/diag-delete-session.mjs stage    # SOURCE → F1 → F2, delete F1
 *   <restart the app>
 *   node scripts/diag-delete-session.mjs verify   # cold-load F2, delete F2
 *
 * stage: fork the source session twice in a row, then delete the middle one
 * (F1, the parent of F2). A deleted session's transcript must leave the disk
 * with it, while its fork child survives untouched.
 *
 * verify (after restart): openSession(F2) must replay messages even though
 * F1's file no longer exists — lineage is an annotation, not a dependency —
 * then delete F2 and prove its file goes too. The source transcript must be
 * byte-identical throughout, and the registry count returns to baseline.
 *
 * Requires: npm run dev -- -- --remote-debugging-port=9222 --no-proxy-server \
 *           --disable-gpu --disable-gpu-compositing --in-process-gpu --no-sandbox
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const ROOT = 'D:/2026/FlexAgent'
const STATE_FILE = join(ROOT, '.scratch', 'delete-session-e2e.json')
const REGISTRY = join(process.env.APPDATA ?? '', 'flex-agent', 'sessions.json')
const SOURCE_ID =
  process.env.FLEXAGENT_DELETE_SOURCE ?? '2ff8739e-30c0-42c1-9ce7-721775389135'

const STABLE_STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'deferred'])

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
}

function done() {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
  for (const c of failed) console.log(`FAILED: ${c.name}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

// ─── CDP ─────────────────────────────────────────────────────────────────────

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
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout ${method}`))
        }
      }, 120000)
    })
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}

async function connect() {
  let target = null
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${CDP_HTTP}/json`)
      const targets = await res.json()
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      target = pages.find((t) => /5173|flex-agent|localhost/i.test(t.url)) ?? pages[0] ?? null
      if (target) break
    } catch {
      /* not up yet */
    }
    await delay(1000)
  }
  if (!target) {
    console.error('no CDP page target — is `npm run dev` running with --remote-debugging-port=9222?')
    process.exit(2)
  }
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  return cdp
}

async function ev(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'eval failed'
    )
  }
  return res.result?.value
}

// ─── transcript + registry helpers ───────────────────────────────────────────

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

function readRegistry() {
  const raw = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  return raw.sessions ?? []
}

function requireRecord(id) {
  const rec = readRegistry().find((s) => s.id === id)
  if (!rec) throw new Error(`session ${id} is not in the registry`)
  return rec
}

function readTranscript(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

function entryOf(line) {
  try {
    const parsed = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && b.type === 'text' ? String(b.text ?? '') : ''))
      .join('')
  }
  return ''
}

function forkCandidates(lines) {
  const out = []
  lines.forEach((line, index) => {
    const entry = entryOf(line)
    const message = entry?.message
    if (entry?.type !== 'message' || message?.role !== 'assistant') return
    if (!STABLE_STOP_REASONS.has(String(message.stopReason ?? 'stop'))) return
    const text = textOf(message)
    if (text.trim() === '') return
    out.push({ index, ts: message.timestamp, text })
  })
  return out
}

function lastForkPoint(file) {
  const cands = forkCandidates(readTranscript(file))
  const withTs = [...cands].reverse().find((c) => typeof c.ts === 'number')
  if (withTs) return { ts: withTs.ts, prefix: withTs.text.slice(0, 64) }
  const any = cands[cands.length - 1]
  // Entries with no timestamp match any target.ts (see forkSessionFile).
  return any ? { ts: 0, prefix: any.text.slice(0, 64) } : null
}

async function forkFrom(cdp, sessionId, file) {
  const point = lastForkPoint(file)
  if (!point) return null
  const summary = await ev(
    cdp,
    `window.electron.codex.forkSession(${JSON.stringify({
      sessionId,
      messageTs: point.ts,
      messagePrefix: point.prefix
    })})`
  )
  return summary?.id ?? null
}

async function listIds(cdp) {
  return ev(cdp, 'window.electron.codex.listSessions().then(l => l.map(s => s.id))')
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    console.error(`no state file at ${STATE_FILE} — run the "stage" phase first`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

// ─── phases ──────────────────────────────────────────────────────────────────

async function stage(cdp) {
  const sourceRec = requireRecord(SOURCE_ID)
  if (!sourceRec.piSessionFile || !existsSync(sourceRec.piSessionFile)) {
    console.error(`source transcript missing: ${sourceRec.piSessionFile}`)
    process.exit(2)
  }
  const sourceHash = sha256(sourceRec.piSessionFile)
  const baseline = readRegistry().length

  await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(SOURCE_ID)})`)
  const f1 = await forkFrom(cdp, SOURCE_ID, sourceRec.piSessionFile)
  check('F1（SOURCE 的分叉）已创建', f1 !== null, f1 ?? 'fork failed')
  if (f1 === null) return done()

  const f1File = requireRecord(f1).piSessionFile
  await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(f1)})`)
  const f2 = await forkFrom(cdp, f1, f1File)
  check('F2（F1 的分叉）已创建', f2 !== null, f2 ?? 'fork failed')
  if (f2 === null) return done()

  const f2File = requireRecord(f2).piSessionFile
  check(
    '两个分叉的转录文件都在盘上',
    existsSync(f1File) && existsSync(f2File),
    `${f1File.split('\\').pop()} + ${f2File.split('\\').pop()}`
  )

  await ev(cdp, `window.electron.codex.deleteSession(${JSON.stringify(f1)})`)
  const ids = await listIds(cdp)
  check('删除 F1：注册表行已消失', !ids.includes(f1))
  check('删除 F1：转录文件随行一起消失（29 核心断言）', !existsSync(f1File), f1File.split('\\').pop())
  check('删除 F1：子会话 F2 的行仍在', ids.includes(f2))
  check('删除 F1：子会话 F2 的文件仍在', existsSync(f2File))
  check('删除 F1：SOURCE 转录字节未变', sha256(sourceRec.piSessionFile) === sourceHash)

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ f1, f1File, f2, f2File, sourceHash, baseline }, null, 2),
    'utf8'
  )
  console.log(`\nstate → ${STATE_FILE}\nrestart the app, then run: node scripts/diag-delete-session.mjs verify`)
  done()
}

async function verify(cdp) {
  const state = loadState()

  const idsBefore = await listIds(cdp)
  check('重启后 F1 的行没有复活', !idsBefore.includes(state.f1))
  check('重启后 F1 的文件没有复活', !existsSync(state.f1File), state.f1File.split('\\').pop())
  check('重启后 F2 的行还在', idsBefore.includes(state.f2))

  const detail = await ev(
    cdp,
    `window.electron.codex.openSession(${JSON.stringify(state.f2)})`
  )
  const messages = Array.isArray(detail?.messages) ? detail.messages : []
  check('F2 冷加载成功（父文件已删仍可打开）', detail !== null && typeof detail === 'object')
  check('F2 冷加载带回了历史消息', messages.length > 0, `${messages.length} messages`)

  await ev(cdp, `window.electron.codex.deleteSession(${JSON.stringify(state.f2)})`)
  const after = await listIds(cdp)
  check('删除 F2：注册表行已消失', !after.includes(state.f2))
  check('删除 F2：转录文件随行一起消失', !existsSync(state.f2File), state.f2File.split('\\').pop())

  const sourceRec = requireRecord(SOURCE_ID)
  check('SOURCE 转录全程字节未变', sha256(sourceRec.piSessionFile) === state.sourceHash)
  check(
    '会话总数回到基线',
    after.length === state.baseline,
    `${state.baseline} → ${after.length}`
  )

  rmSync(STATE_FILE, { force: true })
  done()
}

const phase = process.argv[2]
if (!['stage', 'verify'].includes(phase)) {
  console.error('usage: node scripts/diag-delete-session.mjs <stage|verify>')
  process.exit(2)
}
const cdp = await connect()
try {
  if (phase === 'stage') await stage(cdp)
  else await verify(cdp)
} finally {
  cdp.close()
}
