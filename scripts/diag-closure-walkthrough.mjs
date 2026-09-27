/**
 * Closure walkthrough (tickets 04/05/06/11/16) — real model, real app, CDP.
 *
 *   node scripts/diag-closure-walkthrough.mjs probe         # model answers
 *   node scripts/diag-closure-walkthrough.mjs goal          # /goal + auto-verify
 *   node scripts/diag-closure-walkthrough.mjs goal-restart  # after app restart
 *   node scripts/diag-closure-walkthrough.mjs ui            # 04 manual regression
 *   node scripts/diag-closure-walkthrough.mjs subagent      # 16 real-task e2e
 *   node scripts/diag-closure-walkthrough.mjs image         # 11 vision e2e
 *
 * Requires: npm run dev -- -- --remote-debugging-port=9222 --no-proxy-server \
 *           --disable-gpu --disable-gpu-compositing --in-process-gpu --no-sandbox
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CDP_HTTP = 'http://127.0.0.1:9222'
const ROOT = 'D:/2026/FlexAgent'
const STATE_FILE = join(ROOT, '.scratch', 'closure-walkthrough.json')
const REGISTRY = join(process.env.APPDATA ?? '', 'flex-agent', 'sessions.json')

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
      }, 240000)
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
  for (let i = 0; i < 60; i += 1) {
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

async function waitFor(cdp, expression, timeoutMs = 30000, pollMs = 400) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await ev(cdp, `!!(${expression})`)) return Date.now() - started
    await delay(pollMs)
  }
  return null
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    console.error(`no state at ${STATE_FILE} — run an earlier phase first`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

function saveState(patch) {
  const prev = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {}
  writeFileSync(STATE_FILE, JSON.stringify({ ...prev, ...patch }, null, 2), 'utf8')
}

/** Session lifecycle helpers — every phase talks to the kernel through these. */
async function newSession(cdp, title) {
  return ev(
    cdp,
    `window.electron.codex.createSession({ title: ${JSON.stringify(title)} }).then(s => s.id)`
  )
}

/** Read the session id the renderer currently shows (sidebar aria-current). */
async function activeSessionId(cdp) {
  return ev(
    cdp,
    `(() => {
      const b = document.querySelector('li[data-session-menu-root] button[aria-current="true"]')
      return b ? b.closest('li').getAttribute('data-session-menu-root') : null
    })()`
  )
}

/**
 * Click "New chat" so the *renderer* creates and opens the session — only the
 * active view subscribes to kernel events, so goal cards and round dividers
 * exist only after this switch. Returns the new session id.
 */
async function newSessionInView(cdp) {
  const oldId = await activeSessionId(cdp)
  const clicked = await ev(
    cdp,
    `(() => {
      const nav = document.querySelector('nav[aria-label="Primary"]')
      const btn = nav && [...nav.querySelectorAll('button')].find(b => b.textContent.trim() === 'New chat')
      if (!btn) return false
      btn.click()
      return true
    })()`
  )
  if (!clicked) return null
  const started = Date.now()
  while (Date.now() - started < 15000) {
    const id = await activeSessionId(cdp)
    if (id && id !== oldId) return id
    await delay(300)
  }
  return null
}

/** Make the renderer show an existing session (sidebar click). */
async function openInView(cdp, sessionId) {
  if ((await activeSessionId(cdp)) === sessionId) return true
  const started = Date.now()
  while (Date.now() - started < 15000) {
    const done = await ev(
      cdp,
      `(() => {
        const li = document.querySelector(${JSON.stringify(`li[data-session-menu-root="${sessionId}"]`)})
        if (!li) return false
        const b = li.querySelector('button')
        if (b.getAttribute('aria-current') === 'true') return true
        b.click()
        return false
      })()`
    )
    if (done) return true
    await delay(400)
  }
  return false
}

async function runState(cdp, sessionId) {
  return ev(
    cdp,
    `window.electron.codex.openSession(${JSON.stringify(sessionId)}).then(d => d.summary.runState)`
  )
}

/** Send a prompt, then wait until the run settles back to idle. */
async function promptAndWait(cdp, sessionId, text, timeoutMs = 240000) {
  await ev(
    cdp,
    `window.electron.codex.prompt({ sessionId: ${JSON.stringify(sessionId)}, text: ${JSON.stringify(text)} })`
  )
  const started = Date.now()
  let sawRunning = false
  while (Date.now() - started < timeoutMs) {
    const state = await runState(cdp, sessionId)
    if (state === 'running' || state === 'awaiting_permission' || state === 'awaiting_input') {
      sawRunning = true
    }
    if (sawRunning && state === 'idle') return Date.now() - started
    await delay(700)
  }
  return null
}

async function lastAssistant(cdp, sessionId) {
  return ev(
    cdp,
    `window.electron.codex.openSession(${JSON.stringify(sessionId)}).then(d => {
      const msgs = d.messages.filter(m => m.role === 'assistant')
      const last = msgs[msgs.length - 1]
      return last ? last.content : ''
    })`
  )
}

async function getGoal(cdp, sessionId) {
  return ev(cdp, `window.electron.codex.getGoal(${JSON.stringify(sessionId)})`)
}

/**
 * Goal auto-verification chains extra turns after the work turn; a single
 * idle can be a gap between them. Wait until the goal leaves 'active', or
 * activity has ceased for a stable window.
 */
async function waitForGoalSettle(cdp, sessionId, timeoutMs = 180000) {
  const started = Date.now()
  let sawRunning = false
  let idleStreak = 0
  let lastStatus = null
  while (Date.now() - started < timeoutMs) {
    const state = await runState(cdp, sessionId)
    const g = await getGoal(cdp, sessionId)
    const status = g && typeof g === 'object' ? g.status : null
    lastStatus = status
    if (status && status !== 'active') return { settled: true, status, ms: Date.now() - started }
    if (state === 'running' || state === 'awaiting_permission' || state === 'awaiting_input') {
      sawRunning = true
      idleStreak = 0
    } else if (sawRunning) {
      idleStreak += 1
      if (idleStreak >= 10) return { settled: true, status: status ?? 'active-stable', ms: Date.now() - started }
    }
    await delay(1000)
  }
  return { settled: false, status: lastStatus ?? 'timeout', ms: timeoutMs }
}

// ─── phases ──────────────────────────────────────────────────────────────────

async function probe(cdp) {
  const id = await newSession(cdp, 'closure-probe')
  check('会话已创建', typeof id === 'string' && id.length > 0, id)
  const waited = await promptAndWait(
    cdp,
    id,
    'Reply with exactly this token and nothing else: PROBE-OK',
    120000
  )
  check('模型回合跑完回到 idle', waited !== null, waited === null ? 'timeout' : `${Math.round(waited / 1000)}s`)
  const reply = await lastAssistant(cdp, id)
  check('真实模型返回了指定 token', typeof reply === 'string' && reply.includes('PROBE-OK'), JSON.stringify(String(reply).slice(0, 80)))
  saveState({ probeSessionId: id })
  done()
}

async function goal(cdp) {
  const id = await newSessionInView(cdp)
  check('新会话已由渲染层创建并切入视图', typeof id === 'string' && id.length > 0, id ?? 'no view switch')
  if (typeof id !== 'string' || !id) done()

  const cwd = await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(id)}).then(d => d.summary.cwd)`)
  for (const f of ['step1.txt', 'step2.txt']) rmSync(join(cwd, f), { force: true })

  const goalText =
    'step1.txt 与 step2.txt 都存在，且内容分别为 GOAL-STEP-1 和 GOAL-STEP-2'
  const cmdAck = await ev(
    cdp,
    `window.electron.codex.goalCommand({ sessionId: ${JSON.stringify(id)}, raw: ${JSON.stringify('/goal ' + goalText)} })`
  )
  check('/goal 被状态机接受', cmdAck !== null && cmdAck !== undefined && typeof cmdAck.message === 'string',
    cmdAck ? cmdAck.message : 'no ack')

  // Capture the card's status line while the chain runs: the verifying state
  // is transient (round pending → verdict lands), so only a poll sees it.
  const seenMetas = new Set()
  let polling = true
  const poller = (async () => {
    while (polling) {
      const meta = await ev(
        cdp,
        `document.querySelector('[data-testid="goal-card-meta"]')?.textContent ?? ''`
      ).catch(() => '')
      if (meta) seenMetas.add(meta)
      await delay(400)
    }
  })()

  const waited = await promptAndWait(
    cdp,
    id,
    '现在执行：本轮只创建 step1.txt（内容为 GOAL-STEP-1），不要创建 step2.txt。',
    240000
  )
  check('任务回合跑完回到 idle', waited !== null, waited === null ? 'timeout' : `${Math.round(waited / 1000)}s`)

  const settle = await waitForGoalSettle(cdp, id)
  polling = false
  await poller
  console.log(`INFO  goal settle: status=${settle.status} (${Math.round(settle.ms / 1000)}s)`)
  console.log(`INFO  card meta timeline: ${JSON.stringify([...seenMetas])}`)

  const g = await getGoal(cdp, id)
  check('目标状态存在且包含轮次', g !== null && g !== undefined && Array.isArray(g.iterations) && g.iterations.length > 0,
    g ? `status=${g.status} rounds=${g.iterations.length}` : 'no goal')

  const dividers = await ev(
    cdp,
    `document.querySelectorAll('[data-testid="goal-round-divider"]').length`
  )
  const rounds = g !== null && g !== undefined && Array.isArray(g.iterations) ? g.iterations.length : 0
  // ≥2 rounds ⇒ per-round "continue" markers plus the terminal "done" marker.
  const wantDividers = rounds >= 2 ? 3 : 1
  check('对话流出现迭代分隔指示（06 实时，轮间含完成标记）', dividers >= wantDividers,
    `${dividers} 个（rounds=${rounds}，期望 ≥${wantDividers}）`)

  const cardInfo = await ev(
    cdp,
    `(() => {
      const card = document.querySelector('[data-testid="goal-card"]') ?? document.querySelector('[data-testid="goal-banner"]')
      if (!card) return null
      const meta = document.querySelector('[data-testid="goal-card-meta"]')
      const progress = document.querySelector('[data-testid="goal-progress"]')
      return { text: card.textContent.slice(0, 120), meta: meta?.textContent ?? '', progress: progress?.textContent ?? '' }
    })()`
  )
  check('目标卡可见且状态文本已渲染（goal_update 到达渲染层）', cardInfo !== null, cardInfo ? JSON.stringify(cardInfo).slice(0, 200) : 'no card')

  const sawVerifying = [...seenMetas].some((m) => m.includes('verifying'))
  check('验证中状态在卡片上出现过（verifying…）', sawVerifying, sawVerifying ? [...seenMetas].find((m) => m.includes('verifying')) : 'not observed')

  const s1 = existsSync(join(cwd, 'step1.txt')) && readFileSync(join(cwd, 'step1.txt'), 'utf8').includes('GOAL-STEP-1')
  check('step1.txt 已由模型创建', s1, join(cwd, 'step1.txt'))
  const s2 = existsSync(join(cwd, 'step2.txt'))
  console.log(`INFO  step2.txt ${s2 ? '已存在（内容：' + readFileSync(join(cwd, 'step2.txt'), 'utf8').trim().slice(0, 40) + '）' : '未创建（等待后续轮次）'}`)

  saveState({ goalSessionId: id, goalText, goalCwd: cwd, goalStatus: settle.status })
  done()
}

async function goalRestart(cdp) {
  const state = loadState()
  const id = state.goalSessionId
  const g = await getGoal(cdp, id)
  const rounds = g !== null && g !== undefined && Array.isArray(g.iterations) ? g.iterations.length : 0
  check('重启后目标状态从磁盘恢复（05 持久化）',
    g !== null && g !== undefined && g.status === state.goalStatus &&
      typeof g.text === 'string' && g.text === state.goalText && rounds >= 2,
    g ? `status=${g.status} rounds=${rounds} (期望 ${state.goalStatus})` : 'lost')

  const detail = await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(id)})`)
  check('重启后会话可打开', detail !== null && detail !== undefined, `${detail?.messages?.length ?? 0} messages`)

  const shown = await openInView(cdp, id)
  check('重启后目标会话切入视图', shown === true)

  await delay(2000)
  const dividers = await ev(
    cdp,
    `document.querySelectorAll('[data-testid="goal-round-divider"]').length`
  )
  const wantDividers = rounds >= 2 ? 3 : 1
  check('重启后迭代分隔指示从转录重建（06 reload）', dividers >= wantDividers,
    `${dividers} 个（rounds=${rounds}，期望 ≥${wantDividers}）`)

  const card = await ev(
    cdp,
    `(() => {
      const el = document.querySelector('[data-testid="goal-card"]') ?? document.querySelector('[data-testid="goal-banner"]')
      if (!el) return null
      const meta = document.querySelector('[data-testid="goal-card-meta"]')
      return { text: el.textContent.slice(0, 160), meta: meta?.textContent ?? '' }
    })()`
  )
  check('重启后目标卡可见且状态为 reached', card !== null && card.meta.includes('reached'),
    card ? JSON.stringify(card).slice(0, 200) : 'no card')
  check('重启后轮次分组渲染已重建（Round 分组）',
    card !== null && card.text.includes('Round 1'),
    card ? card.text.slice(0, 120) : 'no card')
  done()
}

async function composerFocusType(cdp, text) {
  const focused = await ev(
    cdp,
    `(() => {
      const ta = document.querySelector('[data-testid="composer"] textarea')
      if (!ta) return false
      ta.focus()
      return document.activeElement === ta
    })()`
  )
  if (focused !== true) return false
  await cdp.send('Input.insertText', { text })
  const value = await ev(cdp, `document.querySelector('[data-testid="composer"] textarea')?.value ?? ''`)
  return typeof value === 'string' && value.includes(text.slice(0, 24))
}

async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r'
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
  })
}

async function pressCtrlT(cdp) {
  // CDP modifiers bitmask: Ctrl = 2.
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84
  })
}

/**
 * Run until idle, approving any permission dialog on the way (allow-once).
 * In default mode a redirecting shell command raises a request; the dialog is
 * the 04 regression target, so the walkthrough must not dodge it.
 */
async function settleApprovingDialog(cdp, sessionId, timeoutMs = 180000) {
  const started = Date.now()
  let sawRunning = false
  let sawDialog = false
  let approved = 0
  while (Date.now() - started < timeoutMs) {
    const dlg = await ev(
      cdp,
      `document.querySelector('[data-testid="permission-dialog"]') !== null`
    )
    if (dlg === true) {
      sawDialog = true
      const clicked = await ev(
        cdp,
        `(() => { const b = document.querySelector('[data-testid="permission-allow-once"]'); if (!b || b.disabled) return false; b.click(); return true })()`
      )
      if (clicked === true) approved += 1
      await delay(600)
      continue
    }
    const state = await runState(cdp, sessionId)
    if (state === 'running' || state === 'awaiting_permission' || state === 'awaiting_input') {
      sawRunning = true
    } else if (sawRunning && state === 'idle') {
      return { ms: Date.now() - started, sawDialog, approved }
    }
    await delay(600)
  }
  return { ms: timeoutMs, sawDialog, approved, timeout: true }
}

async function ui(cdp) {
  const id = await newSessionInView(cdp)
  check('新会话已由渲染层创建并切入视图', typeof id === 'string' && id.length > 0, id ?? 'no view switch')
  if (typeof id !== 'string' || !id) done()

  const cwd = await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(id)}).then(d => d.summary.cwd)`)
  for (const f of ['ui-dialog-probe.txt', 'ui-diff-probe.txt']) rmSync(join(cwd, f), { force: true })

  // The open panel is `aside[aria-label="Review"]`; its footer Dismiss
  // (`diff-dismiss`) only exists on the error flash, so it must never be the
  // presence probe. showReview lives in App state and survives session
  // switches, the overlay would swallow the allow-once click, and the
  // auto-open ref is spent per transition — close a leftover panel up front.
  const leftover = await ev(
    cdp,
    `document.querySelector('aside[aria-label="Review"]') !== null`
  )
  if (leftover === true) {
    await ev(
      cdp,
      `document.querySelector('aside[aria-label="Review"] button[aria-label="Close"]')?.click()`
    )
    await waitFor(cdp, `document.querySelector('aside[aria-label="Review"]') === null`, 5000)
  }

  // 04 regression runs in default (ask) mode — the session default is bypass,
  // which would auto-approve and skip the dialog entirely.
  await ev(cdp, `window.electron.codex.setPermissionMode({ sessionId: ${JSON.stringify(id)}, mode: 'default' })`)
  const mode = await ev(cdp, `window.electron.codex.getPermissionMode(${JSON.stringify(id)})`)
  check('权限模式已切到 default（ask 档）', mode === 'default', String(mode))

  // ── 发消息：typed into the composer, Enter to send ────────────────────────
  const typed = await composerFocusType(
    cdp,
    'Run this shell command exactly, then reply DONE: echo UI-DIALOG-OK > ui-dialog-probe.txt'
  )
  check('composer 可聚焦并输入文本', typed === true)
  await pressEnter(cdp)
  const step1 = await settleApprovingDialog(cdp, id)
  check('消息发送后回合跑完回到 idle', step1.timeout !== true,
    step1.timeout ? 'timeout' : `${Math.round(step1.ms / 1000)}s`)

  // ── 权限确认：dialog appeared, approve-once ran the command ──────────────
  check('权限对话框出现（default 档下重定向命令需批准）', step1.sawDialog === true,
    step1.sawDialog ? `allow-once 点击 ${step1.approved} 次` : 'dialog never appeared')
  const probeFile = join(cwd, 'ui-dialog-probe.txt')
  const probeOk = existsSync(probeFile) && readFileSync(probeFile, 'utf8').includes('UI-DIALOG-OK')
  check('批准后命令真实执行（ui-dialog-probe.txt）', probeOk, probeFile)

  // ── diff 查看：a file-writing turn raises file_changes → panel auto-opens ─
  await ev(
    cdp,
    `window.electron.codex.prompt({ sessionId: ${JSON.stringify(id)}, text: ${JSON.stringify(
      'Create the file ui-diff-probe.txt with exactly this one line (use your file-editing tool, not a shell redirect): UI-DIFF-OK'
    )} })`
  )
  const step2 = await settleApprovingDialog(cdp, id)
  check('文件写入回合跑完回到 idle', step2.timeout !== true,
    step2.timeout ? 'timeout' : `${Math.round(step2.ms / 1000)}s`)

  const diffShown = await waitFor(
    cdp,
    `document.querySelector('aside[aria-label="Review"]') !== null`,
    15000
  )
  check('diff 审查面板自动打开（04 review 通路）', diffShown !== null,
    diffShown === null ? 'no review aside' : `after ${diffShown}ms`)
  const acceptReady = diffShown === null ? false : await ev(
    cdp,
    `document.querySelector('[data-testid="diff-accept"]:not([disabled])') !== null`
  )
  check('Accept 在 idle 态可点击（无禁用死锁）', acceptReady === true)
  if (diffShown !== null) {
    await ev(
      cdp,
      `document.querySelector('aside[aria-label="Review"] button[aria-label="Close"]')?.click()`
    )
    const gone = await waitFor(
      cdp,
      `document.querySelector('aside[aria-label="Review"]') === null`,
      5000
    )
    check('diff 面板可关闭', gone !== null, gone === null ? 'still open' : `closed in ${gone}ms`)
  } else {
    check('diff 面板可关闭', false, 'skipped — panel never opened')
  }

  // ── 终端开关：Ctrl+T opens the drawer, composer still focusable ──────────
  await pressCtrlT(cdp)
  const drawerOpen = await waitFor(
    cdp,
    `document.querySelector('[data-testid="terminal-drawer"]') !== null`,
    15000
  )
  check('终端抽屉可打开（Ctrl+T）', drawerOpen !== null, drawerOpen === null ? 'no drawer' : `after ${drawerOpen}ms`)

  const focusWithDrawer = await ev(
    cdp,
    `(() => {
      const ta = document.querySelector('[data-testid="composer"] textarea')
      if (!ta) return false
      ta.focus()
      return document.activeElement === ta
    })()`
  )
  check('抽屉打开时 composer 仍可聚焦（04 遮挡修复）', focusWithDrawer === true)

  const typed2 = await composerFocusType(cdp, 'Reply with exactly this token and nothing else: TERMINAL-OK')
  check('抽屉打开时 composer 可输入', typed2 === true)
  await pressEnter(cdp)
  const step3 = await settleApprovingDialog(cdp, id, 120000)
  check('抽屉打开时消息发送并跑完', step3.timeout !== true,
    step3.timeout ? 'timeout' : `${Math.round(step3.ms / 1000)}s`)
  const reply = await lastAssistant(cdp, id)
  check('回合返回了指定 token', typeof reply === 'string' && reply.includes('TERMINAL-OK'),
    JSON.stringify(String(reply).slice(0, 60)))

  await pressCtrlT(cdp)
  const drawerClosed = await waitFor(
    cdp,
    `document.querySelector('[data-testid="terminal-drawer"]') === null`,
    8000
  )
  check('终端抽屉可关闭', drawerClosed !== null, drawerClosed === null ? 'still open' : `closed in ${drawerClosed}ms`)

  const focusAfterClose = await ev(
    cdp,
    `(() => {
      const ta = document.querySelector('[data-testid="composer"] textarea')
      if (!ta) return false
      ta.focus()
      return document.activeElement === ta
    })()`
  )
  check('抽屉关闭后 composer 仍可聚焦', focusAfterClose === true)

  saveState({ uiSessionId: id })
  done()
}

/**
 * 16 box8: create one custom subagent definition and have it complete a real
 * task end-to-end. Evidence: the registry loads it, the task report comes back
 * ok, and the child actually wrote walker-out.txt (read+write whitelist only).
 */
async function subagent(cdp) {
  const agentsDir = join(homedir(), '.flexagent', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  const defPath = join(agentsDir, 'walker-scribe.md')
  rmSync(defPath, { force: true })

  // Create through the real settings CRUD (saveCustomAgent), not raw fs: the
  // IPC invalidates the worker's cached resource loaders, which is what makes
  // a freshly created role visible to the task tool on the next session.
  const persona =
    'You are walker-scribe, a file-transcription subagent. ' +
    'Follow the task text exactly: read only the named input file, write only the named ' +
    'output file, keep the output byte-identical to what the task specifies, then reply ' +
    'with a one-line summary of what you read and wrote. Never run shell commands.'
  const saved = await ev(
    cdp,
    `window.electron.codex.saveCustomAgent(${JSON.stringify({
      name: 'walker-scribe',
      description:
        'Reads a designated input file and writes its verified copy to walker-out.txt.',
      tools: ['read', 'write'],
      maxTurns: 6,
      enabled: true,
      persona
    })})`
  )
  const savedAgent = Array.isArray(saved?.agents)
    ? saved.agents.find((a) => a && a.name === 'walker-scribe')
    : undefined
  check(
    'saveCustomAgent 返回含 walker-scribe 的注册表快照',
    !!savedAgent && savedAgent.tools.join(',') === 'read,write' && savedAgent.maxTurns === 6,
    savedAgent ? `tools=${savedAgent.tools.join(',')} maxTurns=${savedAgent.maxTurns}` : 'missing from snapshot'
  )
  check('定义文件已落盘 ~/.flexagent/agents/walker-scribe.md', existsSync(defPath), defPath)

  const id = await newSessionInView(cdp)
  check('新会话已由渲染层创建并切入视图', typeof id === 'string' && id.length > 0, id ?? 'no view switch')
  if (typeof id !== 'string' || !id) done()

  const cwd = await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(id)}).then(d => d.summary.cwd)`)
  check('新会话 cwd 已解析', typeof cwd === 'string' && cwd.length > 0, cwd)

  // Registry pickup: the extension is rebuilt per session attach, and the IPC
  // snapshot reads the definition files live.
  const snap = await ev(cdp, `window.electron.codex.listCustomAgents()`)
  const agent = Array.isArray(snap?.agents)
    ? snap.agents.find((a) => a && a.name === 'walker-scribe')
    : undefined
  check(
    '注册表已加载该子智能体（tools 白名单 + maxTurns + 非内置）',
    !!agent && Array.isArray(agent.tools) &&
      agent.tools.join(',') === 'read,write' &&
      agent.maxTurns === 6 && agent.builtin === false && agent.enabled === true,
    agent
      ? `tools=${(agent.tools ?? []).join(',')} maxTurns=${agent.maxTurns} builtin=${agent.builtin}`
      : `not in snapshot (${(snap?.diagnostics ?? []).map((d) => d.code).join(',') || 'no diagnostics'})`
  )

  const inPath = join(cwd, 'walker-scribe-in.txt')
  const outPath = join(cwd, 'walker-out.txt')
  writeFileSync(inPath, 'PROBE-IN-123\n', 'utf8')
  rmSync(outPath, { force: true })

  // Steer hard: the parent must delegate, not do the work itself — the whole
  // point of the e2e is the child run.
  const taskText =
    'Read walker-scribe-in.txt in the current working directory, then write a new file ' +
    'walker-out.txt containing exactly one line: COPY: PROBE-IN-123. Reply with DONE.'
  const prompt =
    'Use the task tool for everything below. Do NOT read or write any files yourself. ' +
    'Call task exactly once with role "walker-scribe" and this task text: ' +
    JSON.stringify(taskText) +
    ' When the task tool returns, reply with its full report verbatim.'

  // Default (ask) mode: the parent's task call and the child's forwarded
  // tool asks both raise the permission dialog — the same helper that the ui
  // phase approves with keeps this run moving and proves inheritance.
  await ev(
    cdp,
    `window.electron.codex.prompt({ sessionId: ${JSON.stringify(id)}, text: ${JSON.stringify(prompt)} })`
  )
  const step = await settleApprovingDialog(cdp, id, 300000)
  check('task 回合跑完回到 idle', step.timeout !== true,
    step.timeout ? 'timeout' : `${Math.round(step.ms / 1000)}s, allow-once ${step.approved} 次`)

  const reply = await lastAssistant(cdp, id)
  const reportOk =
    typeof reply === 'string' &&
    reply.includes('task results') &&
    /walker-scribe[^\n]*— ok/.test(reply)
  check(
    'task 报告包含 walker-scribe 成功段（— ok）',
    reportOk,
    JSON.stringify(String(reply ?? '').slice(0, 160))
  )

  const outOk =
    existsSync(outPath) && readFileSync(outPath, 'utf8').trim() === 'COPY: PROBE-IN-123'
  check(
    '子智能体真实产出 walker-out.txt 且内容正确',
    outOk,
    outOk ? outPath : existsSync(outPath) ? `bad content: ${JSON.stringify(readFileSync(outPath, 'utf8'))}` : 'missing'
  )

  // Whitelist evidence inside the same report: a child restricted to
  // read+write cannot shell out — the report must not show bash usage.
  const bashLeak = typeof reply === 'string' && /Ran `/.test(reply)
  check('白名单未被绕过（报告无 shell 执行记录）', bashLeak === false)

  saveState({ subagentSessionId: id, subagentCwd: cwd })
  done()
}

/**
 * 11 vision e2e: paste a screenshot whose only text is a known phrase, ask the
 * model what it says, and require the phrase back — the box asks for one
 * end-to-end success with evidence.
 */
async function image(cdp) {
  const PHRASE = 'FLEX-42 SAYS HELLO'
  const id = await newSessionInView(cdp)
  check('新会话已由渲染层创建并切入视图', typeof id === 'string' && id.length > 0, id ?? 'no view switch')
  if (typeof id !== 'string' || !id) return

  const cwd = await ev(cdp, `window.electron.codex.openSession(${JSON.stringify(id)}).then(d => d.summary.cwd)`)
  check('新会话 cwd 已解析', typeof cwd === 'string' && cwd.length > 0, String(cwd))

  // Vision requires a model whose catalogue entry declares input image — the
  // others answer "model does not support images" (Pi omits the block).
  const switched = await ev(
    cdp,
    `window.electron.codex.setModel({ sessionId: ${JSON.stringify(id)}, provider: 'USTC', id: 'claude-sonnet-4-6' })` +
      `.then(c => (c?.model?.id ?? 'unknown'), e => 'failed: ' + (e && e.message))`
  )
  check('会话模型切到 claude-sonnet-4-6（catalogue 声明 image 输入）',
    switched === 'claude-sonnet-4-6', String(switched))

  // Render the "screenshot" in-page: white canvas, the phrase as its only
  // text — no image dependency, and the ground truth is exact.
  const b64 = await ev(
    cdp,
    `(() => {
      const c = document.createElement('canvas'); c.width = 720; c.height = 180
      const x = c.getContext('2d')
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height)
      x.fillStyle = '#111111'; x.font = 'bold 52px sans-serif'
      x.fillText(${JSON.stringify(PHRASE)}, 36, 108)
      return c.toDataURL('image/png').split(',')[1]
    })()`
  )
  const b64Ok = typeof b64 === 'string' && b64.length > 500
  check('截图已渲染（canvas → PNG base64）', b64Ok, b64Ok ? `${b64.length} b64 chars` : 'render failed')
  if (!b64Ok) return
  const pngPath = join(ROOT, '.scratch', 'flex42.png')
  writeFileSync(pngPath, Buffer.from(b64, 'base64'))

  // Same path as a user Ctrl+V: React's onPaste reads clipboardData.files.
  const pasted = await ev(
    cdp,
    `(() => {
      const ta = document.querySelector('[data-testid="composer"] textarea')
      if (!ta) return 'no textarea'
      const bin = atob(${JSON.stringify(b64)})
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const file = new File([arr], 'flex42.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      ta.dispatchEvent(evt)
      return 'dispatched'
    })()`
  )
  check('合成 paste 事件已派发到 composer', pasted === 'dispatched', String(pasted))

  const trayed = await waitFor(
    cdp,
    `document.querySelector('[data-testid="composer-attachments"] [data-testid="composer-image-attachment"]') !== null`,
    15000
  )
  check('附件托盘出现图片附件（kind=image）', trayed !== null,
    trayed === null ? 'tray never showed' : `after ${trayed}ms`)

  const typed = await composerFocusType(
    cdp,
    'What exact phrase is written in this screenshot? Reply with the phrase only.'
  )
  check('composer 已输入发问文本', typed === true)
  // The Send button, not a CDP Enter key event: key input stops reaching the
  // DOM after a headless-flag restart, while the click path is DOM-level.
  const clicked = await ev(
    cdp,
    `(() => {
      const btn = [...document.querySelectorAll('[data-testid="composer"] button')]
        .find(b => (b.getAttribute('aria-label') || '') === 'Send message')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()`
  )
  check('Send 按钮可点击发送', clicked === true, String(clicked))
  const step = await settleApprovingDialog(cdp, id, 300000)
  check('带图消息回合跑完回到 idle', step.timeout !== true,
    step.timeout ? 'timeout' : `${Math.round(step.ms / 1000)}s, allow-once ${step.approved} 次`)

  const reply = await lastAssistant(cdp, id)
  const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
  const phraseOk =
    typeof reply === 'string' && norm(reply).includes(norm(PHRASE))
  check('模型正确读出截图文字（11 vision 成功用例）', phraseOk,
    JSON.stringify(String(reply ?? '').slice(0, 200)))

  saveState({ imageSessionId: id, imagePng: pngPath, imageReplyOk: phraseOk })
  done()
}
const phase = process.argv[2]
const PHASES = ['probe', 'goal', 'goal-restart', 'ui', 'subagent', 'image']
if (!PHASES.includes(phase)) {
  console.error(`usage: node scripts/diag-closure-walkthrough.mjs <${PHASES.join('|')}>`)
  process.exit(2)
}
const cdp = await connect()
try {
  if (phase === 'probe') await probe(cdp)
  else if (phase === 'goal') await goal(cdp)
  else if (phase === 'goal-restart') await goalRestart(cdp)
  else if (phase === 'ui') await ui(cdp)
  else if (phase === 'subagent') await subagent(cdp)
  else if (phase === 'image') await image(cdp)
  else {
    console.error(`phase "${phase}" not implemented yet`)
    process.exit(2)
  }
} finally {
  cdp.close()
}
