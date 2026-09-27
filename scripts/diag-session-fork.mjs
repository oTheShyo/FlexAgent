/**
 * Ticket 17 session-fork acceptance — real app, real worker, real transcripts.
 *
 * Three phases, because the interesting path is the one after a restart: the
 * forked file has to be adoptable cold, from disk, by a worker that never saw
 * the fork happen.
 *
 *   node scripts/diag-session-fork.mjs create    # fork a real session mid-transcript
 *   <restart the app>
 *   node scripts/diag-session-fork.mjs verify    # cold open + UI entry points
 *   node scripts/diag-session-fork.mjs click     # the user's path: click Fork, land on the copy
 *   node scripts/diag-session-fork.mjs cleanup   # delete the throwaway fork
 *
 * Requires: npm run dev -- -- --remote-debugging-port=9222 --no-proxy-server \
 *           --disable-gpu --disable-gpu-compositing --in-process-gpu --no-sandbox
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const ROOT = 'D:/2026/FlexAgent'
const STATE_FILE = join(ROOT, '.scratch', 'session-fork-e2e.json')
const REGISTRY = join(process.env.APPDATA ?? '', 'flex-agent', 'sessions.json')
const SOURCE_ID =
  process.env.FLEXAGENT_FORK_SOURCE ?? '2ff8739e-30c0-42c1-9ce7-721775389135'

const STABLE_STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'deferred'])

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
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

/** Wait until the expression is truthy; returns ms waited, or null on timeout. */
async function waitFor(cdp, expression, timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await ev(cdp, `!!(${expression})`)) return Date.now() - started
    await delay(250)
  }
  return null
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

/** Stable completed assistant entries that carry text — the only forkable ones. */
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

/** How many messages the UI would replay from a transcript prefix. */
function visibleMessages(lines) {
  let count = 0
  for (const line of lines) {
    const entry = entryOf(line)
    const message = entry?.message
    if (entry?.type !== 'message') continue
    if (message?.role === 'user') count += 1
    else if (message?.role === 'assistant' && textOf(message) !== '') count += 1
  }
  return count
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    console.error(`no state file at ${STATE_FILE} — run the "create" phase first`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

function done() {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
  for (const c of failed) console.log(`FAILED: ${c.name}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

// ─── phases ──────────────────────────────────────────────────────────────────

async function create(cdp) {
  const source = requireRecord(SOURCE_ID)
  const sourceFile = source.piSessionFile
  if (!sourceFile || !existsSync(sourceFile)) {
    console.error(`source session has no transcript on disk: ${sourceFile}`)
    process.exit(2)
  }
  const sourceHashBefore = sha256(sourceFile)
  const sourceLines = readTranscript(sourceFile)
  const candidates = forkCandidates(sourceLines)
  console.log(`source ${SOURCE_ID.slice(0, 8)}  ${sourceLines.length} entries, ${candidates.length} forkable`)

  // A fork point in the middle, so the run proves truncation instead of
  // copying the whole file (which is all the two pre-existing forks exercised).
  const target = Math.floor(sourceLines.length * 0.4)
  const point = candidates.reduce((best, c) =>
    Math.abs(c.index - target) < Math.abs(best.index - target) ? c : best
  )
  const prefix = point.text.slice(0, 64)
  const expectedKept = point.index + 1
  const expectedDropped = sourceLines.length - expectedKept
  console.log(
    `fork point: entry #${point.index} (${target} was the target), keeping ${expectedKept} / dropping ${expectedDropped}`
  )

  // The user's own entry point: the session is open in the worker before Fork
  // is reachable, so open it here too.
  await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(SOURCE_ID)})`)
  const baseline = await ev(cdp, 'window.electron.codex.listSessions().then(l => l.map(s => s.id))')
  check('分叉前：源会话已在基线列表中', baseline.includes(SOURCE_ID), `${baseline.length} sessions`)

  const forked = await ev(
    cdp,
    `window.electron.codex.forkSession({ sessionId: ${JSON.stringify(SOURCE_ID)}, messageTs: ${point.ts}, messagePrefix: ${JSON.stringify(prefix)} })`
  )
  console.log(`fork → ${forked?.id}  "${forked?.title}"`)
  check('分叉返回新会话 id（与源不同）', Boolean(forked?.id) && forked.id !== SOURCE_ID)
  check('标题为派生标题', forked?.title === `${source.title} · fork`, forked?.title)
  check('派生标记 derivedFrom 指向源会话', forked?.derivedFrom === SOURCE_ID, forked?.derivedFrom)
  check('新会话继承源工作区', forked?.cwd === source.cwd, forked?.cwd)
  check('新会话初始为空闲（未继承运行态）', forked?.runState === 'idle', forked?.runState)

  const record = requireRecord(forked.id)
  check('注册表落盘记录了 piSessionFile', typeof record.piSessionFile === 'string', record.piSessionFile?.slice(-40))
  check('注册表落盘记录了 derivedFrom', record.derivedFrom === SOURCE_ID)

  const newFile = record.piSessionFile
  const newLines = readTranscript(newFile)
  check('分叉转录文件已生成', existsSync(newFile), newFile.split('\\').pop())
  check(
    '历史截至分叉点（保留行数 = 分叉点行号 + 1）',
    newLines.length === expectedKept,
    `kept ${newLines.length}, expected ${expectedKept}`
  )
  check('分叉点之后的条目被丢弃', expectedDropped > 0 && newLines.length < sourceLines.length, `dropped ${expectedDropped}`)
  check(
    '保留的是源文件的前缀（逐行同源）',
    newLines.slice(1).every((line, i) => line === sourceLines[i + 1]),
    `${newLines.length - 1} lines compared`
  )

  const header = entryOf(newLines[0])
  const sourceHeader = entryOf(sourceLines[0])
  check('header.id 换成新的 PI 会话 id', header?.id !== sourceHeader?.id, `${header?.id?.slice(0, 8)}`)
  check('header.parentSession 指向源 PI 会话（PI 血缘）', header?.parentSession === sourceHeader?.id)

  check(
    '原会话转录未被改写（字节级）',
    sha256(sourceFile) === sourceHashBefore,
    `${sourceHashBefore} → ${sha256(sourceFile)}`
  )

  const visibleFork = visibleMessages(newLines)
  const visibleSource = visibleMessages(sourceLines)
  check(
    '前缀里可回放的消息确实更少（截断有意义）',
    visibleFork > 0 && visibleFork < visibleSource,
    `fork ${visibleFork} < source ${visibleSource}`
  )

  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        sourceId: SOURCE_ID,
        sourceFile,
        sourceHashBefore,
        forkId: forked.id,
        forkFile: newFile,
        expectedKept,
        expectedDropped,
        visibleFork,
        visibleSource,
        baseline
      },
      null,
      2
    )
  )
  console.log(`\nstate written to ${STATE_FILE} — restart the app, then run "verify"`)
  done()
}

async function verify(cdp) {
  const state = loadState()
  const { forkId, sourceId, sourceFile, forkFile, visibleFork, visibleSource } = state

  // Cold path: a fresh worker has never seen this fork, so it can only come
  // back from the file the registry persisted.
  const list = await ev(cdp, 'window.electron.codex.listSessions()')
  const row = list.find((s) => s.id === forkId)
  check('重启后：分叉会话仍在列表里', Boolean(row), row?.title)
  check('重启后：派生标记与标题都保住了', row?.derivedFrom === sourceId && /· fork$/.test(row?.title ?? ''))

  const detail = await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(forkId)})`)
  check('重启后：能从磁盘冷加载分叉会话', Array.isArray(detail?.messages), `${detail?.messages?.length} messages`)
  // The seam that was broken: openSession's summary is what the renderer swaps
  // its sidebar row for, so a field dropped here is dropped from the sidebar.
  check(
    'openSession 返回的 summary 字段完整（archived + derivedFrom）',
    detail?.summary?.archived === false && detail?.summary?.derivedFrom === sourceId,
    `archived=${detail?.summary?.archived} derivedFrom=${detail?.summary?.derivedFrom}`
  )
  check(
    '重启后：回放的历史等于分叉点前缀',
    detail?.messages?.length === visibleFork,
    `replayed ${detail?.messages?.length}, prefix expects ${visibleFork}`
  )
  check(
    '重启后：确实短于原会话',
    visibleFork < visibleSource,
    `${visibleFork} < ${visibleSource}`
  )
  check('重启后：没有队列/后台任务跟着复制过来', detail?.summary?.runState === 'idle')

  // UI: open the fork by clicking its row, then look at the entry points.
  const clicked = await ev(
    cdp,
    `(() => {
      const li = document.querySelector('li[data-session-menu-root=' + JSON.stringify(${JSON.stringify(forkId)}) + ']')
      if (!li) return 'no-row'
      const btn = li.querySelector('button')
      if (!btn) return 'no-button'
      btn.click()
      return 'clicked'
    })()`
  )
  check('侧栏里能点到分叉会话这一行', clicked === 'clicked', clicked)
  const becameActive = await waitFor(
    cdp,
    `document.querySelector('li[data-session-menu-root=' + JSON.stringify(${JSON.stringify(forkId)}) + '] button[aria-current="true"]') !== null`,
    15000
  )
  check('点开后它成为 active 会话', becameActive !== null, becameActive === null ? 'timeout' : `${becameActive}ms`)

  const dom = await ev(
    cdp,
    `(() => {
      const id = ${JSON.stringify(forkId)}
      const rows = [...document.querySelectorAll('[data-selection-source]')]
      const forks = [...document.querySelectorAll('[data-testid="message-actions-fork"]')]
      const inSource = (sel) => forks.filter((b) => b.closest(sel)).length
      const target = document.querySelector('li[data-session-menu-root=' + JSON.stringify(id) + ']')
      return {
        assistant: rows.filter((r) => r.dataset.selectionSource === 'assistant').length,
        user: rows.filter((r) => r.dataset.selectionSource === 'user').length,
        tool: rows.filter((r) => r.dataset.selectionSource === 'tool').length,
        forks: forks.length,
        inAssistant: inSource('[data-selection-source="assistant"]'),
        inUser: inSource('[data-selection-source="user"]'),
        inTool: inSource('[data-selection-source="tool"]'),
        title: forks[0]?.getAttribute('title') ?? null,
        badgeInRow: target ? Boolean(target.querySelector('[data-testid="session-derived-badge"]')) : false
      }
    })()`
  )
  console.log(`DOM: assistant=${dom.assistant} user=${dom.user} tool=${dom.tool} forks=${dom.forks}`)
  check('分叉会话的侧栏行带着 fork 标记', dom.badgeInRow === true)
  check('分叉入口出现在稳定完成的助手消息上', dom.forks > 0 && dom.forks === dom.assistant, `${dom.forks} forks / ${dom.assistant} assistant rows`)
  check('每一个分叉入口都挂在助手行上', dom.inAssistant === dom.forks, `${dom.inAssistant}/${dom.forks}`)
  check('用户消息没有分叉入口', dom.inUser === 0, `${dom.inUser}`)
  check('工具结果没有分叉入口', dom.inTool === 0, `${dom.inTool} tool rows rendered`)
  check(
    '入口文案写明不回滚磁盘文件',
    typeof dom.title === 'string' && /disk files/i.test(dom.title),
    dom.title
  )
  const replayed = Array.isArray(detail?.messages) ? detail.messages : []
  const assistantMsgs = replayed.filter((m) => m.role === 'assistant' && m.content !== '').length
  const userMsgs = replayed.filter((m) => m.role === 'user').length
  check(
    '渲染出的行数与内核回放的消息对得上',
    dom.assistant === assistantMsgs && dom.user === userMsgs,
    `dom ${dom.assistant}/${dom.user} vs kernel ${assistantMsgs}/${userMsgs}`
  )

  const sourceNow = sha256(sourceFile)
  check('这一步之后源转录仍未被改写', sourceNow === state.sourceHashBefore, `${sourceNow}`)

  // The fork must be usable as a source in its own right (chained forks are a
  // real pattern — two already exist in this registry).
  check('分叉文件仍是合法 transcript（可再次分叉）', forkCandidates(readTranscript(forkFile)).length > 0)

  done()
}

async function cleanup(cdp) {
  const state = loadState()
  const before = await ev(cdp, 'window.electron.codex.listSessions().then(l => l.map(s => s.id))')
  check('清理前：分叉会话在列表里', before.includes(state.forkId))

  await ev(cdp, `window.electron.codex.deleteSession(${JSON.stringify(state.forkId)})`)
  const after = await ev(cdp, 'window.electron.codex.listSessions().then(l => l.map(s => s.id))')
  check('分叉会话已从注册表删除', !after.includes(state.forkId))
  check(
    '其余会话一条没少',
    after.length === before.length - 1 && after.every((id) => before.includes(id)),
    `${before.length} → ${after.length}`
  )
  check('源会话还在', after.includes(state.sourceId))
  check('源转录字节未变', sha256(state.sourceFile) === state.sourceHashBefore)

  if (existsSync(state.forkFile)) {
    rmSync(state.forkFile)
    check('分叉转录文件已删除', !existsSync(state.forkFile))
  } else {
    check('分叉转录文件已删除', true, 'already gone')
  }
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE)
  console.log('\ncleanup done')
  done()
}

/**
 * The user's path, end to end: open a chat, click Fork on one of its messages,
 * land on the copy. Nothing here talks to `forkSession` directly — the button
 * does, through the renderer hook, so the wiring is exercised rather than
 * assumed. The fork it creates is deleted again at the end.
 */
async function click(cdp) {
  const source = requireRecord(SOURCE_ID)
  const sourceHashBefore = sha256(source.piSessionFile)
  const sourceLines = readTranscript(source.piSessionFile)

  // The row has to be visible before it can be clicked: expand the Chats group
  // if a previous run left it collapsed.
  const heading = await waitFor(cdp, `document.querySelector('[data-testid="session-list-heading"]') !== null`, 10000)
  if (heading === null) {
    check('侧栏已渲染会话列表', false, 'no session list heading')
    return done()
  }
  const collapsed = await ev(
    cdp,
    `document.querySelector('[data-testid="session-list-heading"]').getAttribute('aria-expanded') === 'false'`
  )
  if (collapsed) {
    await ev(cdp, `document.querySelector('[data-testid="session-list-heading"]').click()`)
    await delay(400)
  }

  const selected = await ev(
    cdp,
    `(() => {
      const li = document.querySelector('li[data-session-menu-root="${SOURCE_ID}"]')
      if (!li) return 'no-row'
      li.querySelector('button').click()
      return 'clicked'
    })()`
  )
  check('能在侧栏里打开源会话', selected === 'clicked', selected)
  const active = await waitFor(
    cdp,
    `document.querySelector('li[data-session-menu-root="${SOURCE_ID}"] button[aria-current="true"]') !== null`,
    20000
  )
  check('源会话成为 active', active !== null, active === null ? 'timeout' : `${active}ms`)

  const rowsReady = await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="message-actions-fork"]').length >= 4`,
    30000
  )
  check('历史渲染出可点分叉的助手行', rowsReady !== null, rowsReady === null ? 'timeout' : `${rowsReady}ms`)

  const before = await ev(cdp, 'window.electron.codex.listSessions().then(l => l.map(s => s.id))')
  const picked = await ev(
    cdp,
    `(() => {
      const buttons = [...document.querySelectorAll('[data-testid="message-actions-fork"]')]
      const button = buttons[3] ?? buttons[buttons.length - 1]
      if (!button) return 'no-button'
      const row = button.closest('[data-selection-source="assistant"]')
      button.click()
      return row ? row.innerText.slice(0, 40).replace(/\\s+/g, ' ') : 'clicked'
    })()`
  )
  check('点到了第 4 条助手消息上的分叉入口', picked !== 'no-button' && picked !== 'no-row', picked)

  let newId = null
  const started = Date.now()
  while (Date.now() - started < 60000) {
    const now = await ev(cdp, 'window.electron.codex.listSessions().then(l => l.map(s => s.id))')
    const added = now.filter((id) => !before.includes(id))
    if (added.length === 1) {
      newId = added[0]
      break
    }
    await delay(400)
  }
  check('点一下分叉就落地了一个新会话', newId !== null, newId ?? 'never appeared')
  if (newId === null) return done()

  try {
    // The registry gains the row before the kernel file exists (the same
    // "registered but not attached yet" window the address book warns about),
    // so wait for the transcript rather than assuming it is there.
    let record = null
    const attachedStarted = Date.now()
    while (Date.now() - attachedStarted < 60000) {
      const candidate = requireRecord(newId)
      if (typeof candidate.piSessionFile === 'string' && existsSync(candidate.piSessionFile)) {
        record = candidate
        break
      }
      await delay(300)
    }
    check(
      '新会话的转录文件已落地',
      record !== null,
      record === null ? 'timeout waiting for piSessionFile' : `${Date.now() - attachedStarted}ms`
    )
    if (record === null) return done()

    check('新会话的记录来自源会话', record.derivedFrom === SOURCE_ID, record.derivedFrom)
    check('标题是派生标题', record.title === `${source.title} · fork`, record.title)
    check('新会话与源会话同一工作区', record.cwd === source.cwd)

    const newLines = readTranscript(record.piSessionFile)
    check(
      '点击路径也真的截断了历史',
      newLines.length > 1 && newLines.length < sourceLines.length,
      `kept ${newLines.length} of ${sourceLines.length}`
    )
    check(
      '保留的仍是源文件前缀',
      newLines.slice(1).every((line, i) => line === sourceLines[i + 1]),
      `${newLines.length} lines`
    )
    const last = entryOf(newLines[newLines.length - 1])
    check(
      '分叉点落在稳定完成的助手条目上',
      last?.type === 'message' &&
        last?.message?.role === 'assistant' &&
        STABLE_STOP_REASONS.has(String(last?.message?.stopReason ?? 'stop')),
      `${last?.message?.role}/${last?.message?.stopReason}`
    )
    const header = entryOf(newLines[0])
    check('父链接指向源 PI 会话', header?.parentSession === entryOf(sourceLines[0])?.id)
    check('源会话转录字节未变', sha256(source.piSessionFile) === sourceHashBefore)

    const landed = await waitFor(
      cdp,
      `document.querySelector('li[data-session-menu-root="${newId}"] button[aria-current="true"]') !== null`,
      20000
    )
    check('界面直接落在分叉出来的会话上', landed !== null, landed === null ? 'timeout' : `${landed}ms`)
    const badge = await ev(
      cdp,
      `(() => {
        const li = document.querySelector('li[data-session-menu-root="${newId}"]')
        return li ? Boolean(li.querySelector('[data-testid="session-derived-badge"]')) : false
      })()`
    )
    check('刚落地的分叉带着 fork 标记（openSession 没把它抹掉）', badge === true)
    const parentStillListed = await ev(
      cdp,
      `!!document.querySelector('li[data-session-menu-root="${SOURCE_ID}"]')`
    )
    check('原会话仍在侧栏里，没被顶掉', parentStillListed === true)
  } finally {
    // ── teardown: never leave a throwaway fork behind, even on a failed check ──
    await ev(cdp, `window.electron.codex.deleteSession(${JSON.stringify(newId)}).catch(() => {})`)
    const after = await ev(cdp, 'window.electron.codex.listSessions().then(l => l.map(s => s.id))')
    check('清理：新会话已删除', !after.includes(newId))
    check('清理：会话总数回到点击前', after.length === before.length, `${before.length} → ${after.length}`)
    // A row can outlive its file when deletion races the attach, and a crashed
    // earlier run leaves a file with no row at all. Sweep anything this source
    // produced that the registry no longer points at.
    const referenced = new Set(readRegistry().map((s) => s.piSessionFile))
    for (const file of forkFilesOf(source.piSessionFile)) {
      if (referenced.has(file)) continue
      rmSync(file)
      check('清理：孤儿分叉转录文件已删除', true, file.split('\\').pop())
    }
  }
  check('清理：源会话转录仍未变', sha256(source.piSessionFile) === sourceHashBefore)
  done()
}

/** `drop <sessionId>` — remove a session this script created in an earlier run. */
async function drop(cdp, sessionId) {
  const rec = readRegistry().find((s) => s.id === sessionId)
  if (!rec) {
    check('目标会话存在于注册表', false, `${sessionId} not found`)
    return done()
  }
  await ev(cdp, `window.electron.codex.deleteSession(${JSON.stringify(sessionId)}).catch(() => {})`)
  const after = await ev(cdp, 'window.electron.codex.listSessions().then(l => l.map(s => s.id))')
  check('会话已从注册表删除', !after.includes(sessionId))
  if (rec.piSessionFile) {
    if (existsSync(rec.piSessionFile)) rmSync(rec.piSessionFile)
    check('转录文件已删除', !existsSync(rec.piSessionFile), rec.piSessionFile.split('\\').pop())
  }
  done()
}

/** Fork transcripts derived from `sourceFile`, wherever they sit next to it. */
function forkFilesOf(sourceFile) {
  const cut = sourceFile.lastIndexOf('\\')
  const dir = sourceFile.slice(0, cut)
  const stem = sourceFile.slice(cut + 1).replace(/\.jsonl$/, '')
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${stem}.fork-`) && f.endsWith('.jsonl'))
      .map((f) => `${dir}\\${f}`)
  } catch {
    return []
  }
}

const phase = process.argv[2]
if (!['create', 'verify', 'click', 'cleanup', 'drop'].includes(phase)) {
  console.error('usage: node scripts/diag-session-fork.mjs <create|verify|click|cleanup|drop <sessionId>>')
  process.exit(2)
}
const cdp = await connect()
try {
  if (phase === 'create') await create(cdp)
  else if (phase === 'verify') await verify(cdp)
  else if (phase === 'click') await click(cdp)
  else if (phase === 'drop') await drop(cdp, process.argv[3])
  else await cleanup(cdp)
} finally {
  cdp.close()
}
