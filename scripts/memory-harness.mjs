/**
 * Memory layer regression harness (esbuild → node).
 *
 * These are behavioural checks, not unit tests of trivia: each one encodes a
 * failure mode the chapter called out, and each one has a shape that would
 * still pass if the feature had been left to prompt discipline.
 *
 *   node scripts/memory-harness.mjs
 */

import { randomBytes } from 'crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSync } from 'esbuild'

const results = []

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail })
}

// ── Build a node-loadable bundle of the real modules ─────────────────────────
const outDir = mkdtempSync(join(tmpdir(), 'fx-mem-'))
buildSync({
  stdin: {
    contents: `
      export * from './src/main/skills/memoryLint'
      export * from './src/main/skills/memoryDedupe'
      export * from './src/main/skills/memoryStore'
      export { createSelfEvolutionExtension, flushPendingMemoryWrites } from './src/main/skills/selfEvolution'
      export * from './src/main/skills/sessionSearch'
      export * from './src/main/skills/skillManage'
      export * from './src/main/skills/skillHistory'
      export * from './src/main/skills/skillUsage'
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(outDir, 'bundle.mjs'),
  external: ['electron', 'node:*'],
  logLevel: 'silent'
})

const home = mkdtempSync(join(tmpdir(), 'fx-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
const mod = await import(`file://${join(outDir, 'bundle.mjs').replace(/\\/g, '/')}`)

// ════════════════════════════════════════════════════════════════════════════
// 1. Lint — checking that must not depend on the model agreeing
// ════════════════════════════════════════════════════════════════════════════

check(
  'lint: rejects a credential assignment',
  mod.lintCard('the api key is sk-live-abcdef123456').rejections.length === 1
)
check(
  'lint: rejects a bare credential prefix',
  mod.lintCard('github token ghp_abcdefghijklmnopqrstuvwxyz012345').rejections.length === 1
)
check(
  'lint: does not reject merely mentioning the word',
  mod.lintCard('the user hates retyping their api key every session').rejections.length === 0,
  'a value-less mention must survive'
)

const subjectCard = mod.lintCard('I summarize long transcripts before answering')
check(
  'lint: warns on subject confusion (agent described itself)',
  subjectCard.warnings.some((w) => w.rule === 'subject-confusion')
)
check(
  'lint: warns on transient run state',
  mod.lintCard('currently working on the memory page').warnings.some((w) => w.rule === 'transient')
)
check(
  'lint: warns when restating the system prompt',
  mod.lintCard('You are a coding agent').warnings.some((w) => w.rule === 'restates-prompt')
)
check(
  'lint: accepts a good fact card silently',
  mod.lintCard('Runtime config lives in realtime-cv-inversion-0521/config.json').warnings.length === 0
)

// ════════════════════════════════════════════════════════════════════════════
// 2. Dedupe bands — expensive step only in the middle band
// ════════════════════════════════════════════════════════════════════════════

const store = ['Prefers concise table-first answers with evidence']
check(
  'dedupe: identical text is decided locally (no model needed)',
  mod.findLocalDuplicate('Prefers concise table-first answers with evidence', store) === 0
)
check(
  'dedupe: unrelated text produces no local verdict',
  mod.findLocalDuplicate('The furnace controller is on COM3', store) === undefined
)
const rephrase = 'Prefers  concise,  table-first answers with evidence!'
check(
  'dedupe: a rephrase still lands in the local band',
  mod.findLocalDuplicate(rephrase, store) === 0,
  'punctuation and spacing should not create a second card'
)
const judged = 'The user likes short answers in tables rather than prose'
const hits = mod.candidatesAmong(judged, store)
check(
  'dedupe: same-topic reword lands in the model band',
  hits.length === 1,
  `score ${hits[0]?.score?.toFixed(2)} between ${mod.CANDIDATE_THRESHOLD} and ${mod.DUPLICATE_THRESHOLD}`
)
check(
  'dedupe: judge reply "2" → candidate index 1',
  mod.parseJudgeReply('2', 3) === 1
)
check(
  'dedupe: judge reply "0" → nothing is a duplicate',
  mod.parseJudgeReply('0', 3) === null
)
check(
  'dedupe: a garbled reply is treated as no decision',
  mod.parseJudgeReply('I think maybe 1?', 3) === null,
  'parse failures must not be read as "duplicate"'
)

// ════════════════════════════════════════════════════════════════════════════
// 3. Stable identity — removal must not corrupt later references
// ════════════════════════════════════════════════════════════════════════════

const idA = mod.cardId('Alpha preference')
const idB = mod.cardId('Beta preference')
const idC = mod.cardId('Gamma preference')
check('id: stable across calls', idA === mod.cardId('Alpha preference') && idA !== idB)
check('id: insensitive to spacing and case', mod.cardId('alpha  PREFERENCE') === idA)

mod.addMemoryCard('MEMORY', 'Alpha preference')
mod.addMemoryCard('MEMORY', 'Beta preference')
mod.addMemoryCard('MEMORY', 'Gamma preference')

const listed = mod.listMemoryCards().filter((c) => c.file === 'MEMORY')
check('store: three cards landed', listed.length === 3)
check('store: ids match what cardId predicted', listed.map((c) => c.id).join(',') === [idA, idB, idC].join(','))

// Remove the first by id, then remove the third by the id captured before.
mod.removeMemoryCard('MEMORY', idA)
mod.removeMemoryCard('MEMORY', idC)
const survivors = mod.listMemoryCards().filter((c) => c.file === 'MEMORY')
check(
  'store: removing by id survives intervening removals',
  survivors.length === 1 && survivors[0].id === idB,
  'the classic index-shift bug would have deleted the wrong line'
)

const dup = mod.addMemoryCard('MEMORY', 'Beta preference')
check('store: re-adding an existing card writes nothing', dup.written === false)

let rejected = false
try {
  mod.addMemoryCard('MEMORY', 'api key: hunter2hunter2')
} catch {
  rejected = true
}
check('store: the linter governs direct writes too', rejected)

// ════════════════════════════════════════════════════════════════════════════
// 4. Deferred writes — the self-reinforcement loop
// ════════════════════════════════════════════════════════════════════════════

const ext = mod.createSelfEvolutionExtension({})
const captured = { tools: {}, handlers: {} }
const fakePi = {
  registerTool: (tool) => {
    captured.tools[tool.name] = tool
  },
  on: (name, handler) => {
    captured.handlers[name] = handler
  }
}
ext.factory(fakePi)

check('ext: both tools registered', Boolean(captured.tools.memory_manage && captured.tools.skill_manage))
check(
  'ext: subscribes to lifecycle events needed for commit',
  Boolean(captured.handlers.turn_end && captured.handlers.session_shutdown)
)

const call = async (params) => {
  const result = await captured.tools.memory_manage.execute('t1', params)
  return result.content[0].text
}

const queuedOut = await call({ action: 'add', file: 'MEMORY', text: 'Prefers verified claims over guesses' })
check('queue: add does not hit disk immediately', /queued/.test(queuedOut))
const afterQueue = mod.listMemoryCards().filter((c) => c.text === 'Prefers verified claims over guesses')
check('queue: nothing visible in the store yet', afterQueue.length === 0)

// Every turn re-reads the store. Nothing this run produced may come back.
const beforeAgentStart = captured.handlers.before_agent_start
const promptText = 'what did we say about evidence?'
const section = await (async () => {
  const out = await beforeAgentStart({ systemPrompt: 'BASE', prompt: promptText })
  return out.systemPrompt
})()
check(
  'inject: excludes what this session wrote',
  !section.includes('Prefers verified claims over guesses'),
  'a card written mid-run must not return as an established fact'
)
check('inject: still carries the base prompt', section.includes('BASE'))

await captured.handlers.turn_end({ type: 'turn_end' })
const afterTurn = mod.listMemoryCards().filter((c) => c.text === 'Prefers verified claims over guesses')
check('commit: turn_end writes queued cards to disk', afterTurn.length === 1)

const nextTurn = await beforeAgentStart({ systemPrompt: 'BASE', prompt: 'again?' })
check(
  'inject: stays excluded in later turns of the same run',
  !nextTurn.systemPrompt.includes('Prefers verified claims over guesses'),
  'the loop is cut for the whole run, not just the first turn after writing'
)

// Warnings must reach the writer even though the card is accepted.
const warned = await call({ action: 'add', file: 'MEMORY', text: 'I always double check before answering' })
check('queue: advisory lint is reported back', /⚠/.test(warned) && /subject-confusion/.test(warned))

const blocked = await call({ action: 'add', file: 'MEMORY', text: 'token: abcdef123456' })
check('queue: a rejected card never enters the queue', /rejected/.test(blocked))

// A dispose that never sees turn_end must still not lose work.
await call({ action: 'add', file: 'USER', text: 'Works primarily in Chinese' })
mod.flushPendingMemoryWrites()
const flushedUser = mod.listMemoryCards().filter((c) => c.text === 'Works primarily in Chinese')
check('commit: dispose-time flush rescues uncommitted cards', flushedUser.length === 1)

// ── Atomic update ────────────────────────────────────────────────────────────
// The point is the failure mode remove+add has: the process dies between the
// two calls and the corrected fact is gone. update is one write, or none.

await call({ action: 'add', file: 'MEMORY', text: 'Builds with CMake and MSVC' })
await captured.handlers.turn_end({ type: 'turn_end' })
const cmakeCard = mod.listMemoryCards().find((c) => c.text === 'Builds with CMake and MSVC')
check('update: the seeded card is on disk', cmakeCard !== undefined)

const positionBefore = mod.listMemoryCards().findIndex((c) => c.text === 'Builds with CMake and MSVC')
const corrected = await call({
  action: 'update',
  file: 'MEMORY',
  id: cmakeCard.id,
  text: 'Builds with CMake and Ninja'
})
check('update: queues rather than writing immediately', /queued update/.test(corrected))

const midEdit = mod.listMemoryCards().filter((c) => c.text === 'Builds with CMake and Ninja')
check('update: nothing visible before the run ends', midEdit.length === 0)
const stillOld = mod.listMemoryCards().filter((c) => c.text === 'Builds with CMake and MSVC')
check('update: the pre-correction text is still what the store shows', stillOld.length === 1)

await captured.handlers.turn_end({ type: 'turn_end' })
const cardsNow = mod.listMemoryCards()
check(
  'update: lands as a single card, not a duplicate',
  cardsNow.filter((c) => c.text === 'Builds with CMake and Ninja').length === 1,
  'remove+add across a crash leaves the fact missing; update cannot'
)
check(
  'update: happens in place, not appended at the end',
  cardsNow.findIndex((c) => c.text === 'Builds with CMake and Ninja') === positionBefore &&
    positionBefore >= 0,
  'a replacement written as delete-plus-append moves the card to the tail'
)

const missingTarget = await call({
  action: 'update',
  file: 'MEMORY',
  id: 'deadbeef00',
  text: 'Updates a card that does not exist'
})
check('update: refuses to invent a target', /no card matches/.test(missingTarget))

// ── Queue consistency ────────────────────────────────────────────────────────
// Every write, delete included, is queued. Otherwise "delete then re-add in the
// same turn" depends on ordering, and one of the two halves can be lost.

const doomed = 'Temporary tool flag used during the port'
await call({ action: 'add', file: 'MEMORY', text: doomed })
const removedRightAfter = await call({ action: 'remove', file: 'MEMORY', id: mod.cardId(doomed) })
check('queue: remove is deferred like add', /queued remove/.test(removedRightAfter))

await captured.handlers.turn_end({ type: 'turn_end' })
check(
  'batch: add then remove nets out to nothing',
  mod.listMemoryCards().filter((c) => c.text === doomed).length === 0,
  'one write per file means the two cancel instead of leaving a ghost'
)

const toCorrect = 'Runs the wall scan at 300x1936'
await call({ action: 'add', file: 'MEMORY', text: toCorrect })
await captured.handlers.turn_end({ type: 'turn_end' })
const editId = mod.listMemoryCards().find((c) => c.text === toCorrect)?.id ?? mod.cardId(toCorrect)
const updated = await call({ action: 'update', file: 'MEMORY', id: editId, text: 'Runs the wall scan at 300x1936 px' })
const cancelled = await call({ action: 'remove', file: 'MEMORY', id: editId })
check(
  'update: an edit is not mistaken for a duplicate of the card it replaces',
  /queued update/.test(updated),
  'an edit is near-identical to its target by construction — dedupe must skip the target'
)
check('batch: remove cancels the queued update against the same card', /dropped the queued update/.test(cancelled))

await captured.handlers.turn_end({ type: 'turn_end' })
check(
  'batch: the cancelled update never lands',
  mod.listMemoryCards().some((c) => c.text === toCorrect) &&
    !mod.listMemoryCards().some((c) => c.text === 'Runs the wall scan at 300x1936 px')
)

// ════════════════════════════════════════════════════════════════════════════
// 5. Recall query extraction
// ════════════════════════════════════════════════════════════════════════════

const queries = mod.extractRecallQueries('为什么 channel_wall_positions_from_image3 的壁面位置会抖动')
check('recall: extracts CJK terms', queries.length >= 1 && queries[0].length >= 4, JSON.stringify(queries))
const mixed = mod.extractRecallQueries('recheck the wall detection jitter please')
check('recall: prefers the informative word', mixed[0] === 'jitter' || mixed.includes('detection'), JSON.stringify(mixed))
check(
  'recall: yields nothing usable from a short prompt',
  mod.extractRecallQueries('hi').length === 0
)

// ════════════════════════════════════════════════════════════════════════════
// 5b. Timestamps and scope — when a fact was learned, and where it holds
// ════════════════════════════════════════════════════════════════════════════

const scopedCwd = join(home, 'project-a')
const bootRun = (cwd) => {
  const instance = mod.createSelfEvolutionExtension({ cwd })
  const sink = { tools: {}, handlers: {} }
  instance.factory({
    registerTool: (tool) => {
      sink.tools[tool.name] = tool
    },
    on: (name, handler) => {
      sink.handlers[name] = handler
    }
  })
  return sink
}
const callOn = async (sink, params) => (await sink.tools.memory_manage.execute('t', params)).content[0].text

const runIn = bootRun(scopedCwd)
const runElsewhere = bootRun(join(home, 'project-b'))

const scopedFact = 'Pins CMake 3.24 for the wall-scan build'
await callOn(runIn, { action: 'add', file: 'MEMORY', text: scopedFact, scope: scopedCwd })
await runIn.handlers.turn_end({ type: 'turn_end' })
const scopedCard = mod.listMemoryCards().find((c) => c.text === scopedFact)
check('scope: the card records the directory it belongs to', scopedCard?.scope === scopedCwd)
check(
  'time: a stored card carries timestamps',
  typeof scopedCard?.createdAt === 'number' && typeof scopedCard?.updatedAt === 'number',
  'without a date there is no way to tell a fresh fact from one from six months ago'
)
check('time: the sidecar is a separate file, not card text', existsSync(join(mod.MEMORY_HOME, '.cards.json')))

// A separate run in the same directory: the card was written by `runIn`, and the
// run that wrote it is exactly the run forbidden to see it.
const runReader = bootRun(scopedCwd)
const inRun = await runReader.handlers.before_agent_start({ systemPrompt: 'BASE', prompt: 'which cmake?' })
const outRun = await runElsewhere.handlers.before_agent_start({ systemPrompt: 'BASE', prompt: 'which cmake?' })
check('scope: injected into the run it belongs to', inRun.systemPrompt.includes(scopedFact))
check(
  'scope: left out of a run in another directory',
  !outRun.systemPrompt.includes(scopedFact),
  'a memory store that injects every fact everywhere is a store the user stops trusting'
)

const createdAt = scopedCard.createdAt
await new Promise((resolve) => setTimeout(resolve, 15))
await callOn(runIn, {
  action: 'update',
  file: 'MEMORY',
  id: scopedCard.id,
  text: 'Pins CMake 3.26 for the wall-scan build',
  scope: scopedCwd
})
await runIn.handlers.turn_end({ type: 'turn_end' })
const correctedCard = mod.listMemoryCards().find((c) => c.text === 'Pins CMake 3.26 for the wall-scan build')
check('time: an edit refreshes updatedAt', (correctedCard?.updatedAt ?? 0) > (createdAt ?? 0))
check(
  'time: an edit keeps the original createdAt',
  correctedCard?.createdAt === createdAt,
  'correcting a card should not make it look like a new fact'
)

// ════════════════════════════════════════════════════════════════════════════
// 6. Skill write safety — gate, atomicity, history, undo
// ════════════════════════════════════════════════════════════════════════════

const { runSkillManage, revertSkillWrite, listSkillUndo, UNDO_LOG, SKILLS_HOME } = mod
mod.clearSkillHistory()

const readSkill = (name) => readFileSync(join(SKILLS_HOME, name, 'SKILL.md'), 'utf8')
const listSkillDir = (name) => readdirSync(join(SKILLS_HOME, name))

// The gate: a write without a prior read must be impossible, not discouraged.
let gateThrew = false
try {
  runSkillManage([{ action: 'create', name: 'gate-probe', content: '---\nname: gate-probe\n---\nbody' }], {
    stateReady: () => false
  })
} catch {
  gateThrew = true
}
check('skill gate: refuses a write when the inventory was never read', gateThrew)
check(
  'skill gate: reading is still allowed without the gate satisfied',
  runSkillManage([{ action: 'list' }], { stateReady: () => false }).applied.length === 0
)
check(
  'skill gate: the refusal says what to do next',
  (() => {
    try {
      runSkillManage([{ action: 'create', name: 'gate-probe', content: 'x' }], { stateReady: () => false })
      return false
    } catch (err) {
      return String(err.message).includes('action: "list"')
    }
  })(),
  'a model that ignores the message has no way to guess the remedy'
)

// With the gate satisfied, the write lands and is atomic.
const created = runSkillManage(
  [{ action: 'create', name: 'gate-probe', content: '---\nname: gate-probe\n---\nv1' }],
  { stateReady: () => true }
)
check('skill gate: admits the write once the inventory has been read', created.applied[0].action === 'create')
check('skill write: content lands exactly', readSkill('gate-probe').endsWith('v1'))
check('skill write: leaves no temp file behind', !listSkillDir('gate-probe').some((f) => f.startsWith('.tmp')))

// A crash mid-write used to leave a truncated SKILL.md; the rename path must not.
const before = readSkill('gate-probe')
runSkillManage([{ action: 'patch', name: 'gate-probe', content: '---\nname: gate-probe\n---\nv2' }], {
  stateReady: () => true
})
check('skill write: patch applied', readSkill('gate-probe').endsWith('v2'))

// History + undo: the reason a user will approve the next evolution.
const undo = listSkillUndo()
// create + patch both land, so both are recorded; creation is undoable too.
check('skill history: records every mutation', undo.length === 2 && undo[0].fileCount === 1, `${undo.length} entries`)
check('skill history: persists to disk rather than memory', existsSync(UNDO_LOG))
const patchUndoId = undo[0].id
const reverted = revertSkillWrite(patchUndoId)
check('skill undo: restores the previous content', readSkill('gate-probe') === before)
check('skill undo: reports what it touched', reverted.reverted.length === 1 && reverted.skipped.length === 0)
check(
  'skill undo: undoing does not erase the history entry, so it can be redone',
  listSkillUndo().some((entry) => entry.id === patchUndoId)
)

// A delete must be reversible too — that is the irreversible-seeming one.
runSkillManage([{ action: 'delete', name: 'gate-probe' }], { stateReady: () => true })
check('skill delete: removes the tree', !existsSync(join(SKILLS_HOME, 'gate-probe')))
const deleteEntry = listSkillUndo()[0]
revertSkillWrite(deleteEntry.id)
check('skill undo: brings a deleted skill back', existsSync(join(SKILLS_HOME, 'gate-probe', 'SKILL.md')))

// Depth cap: an edit loop must not grow one file's history forever.
for (let i = 0; i < 9; i += 1) {
  runSkillManage(
    [{ action: 'patch', name: 'gate-probe', content: `---\nname: gate-probe\n---\nround-${i}` }],
    { stateReady: () => true }
  )
}
const versions = listSkillUndo().filter((entry) => entry.summary.some((line) => line.includes('gate-probe')))
const perFile = new Map()
for (const entry of versions) {
  for (const line of entry.summary) {
    if (line.includes('gate-probe')) perFile.set('gate-probe', (perFile.get('gate-probe') ?? 0) + 1)
  }
}
check(
  'skill history: caps versions per file',
  (perFile.get('gate-probe') ?? 99) <= 6,
  `${perFile.get('gate-probe')} entries for one file`
)

// ════════════════════════════════════════════════════════════════════════════
// 7. Usage age — the half of "is anyone using this" that is actually observable
// ════════════════════════════════════════════════════════════════════════════

const wallUsage = mod.listSkillUsage().find((entry) => entry.name.includes('gate-probe'))
check('usage: a skill the agent wrote is reported', wallUsage !== undefined)
check('usage: attributed to the write log, not guessed', wallUsage?.source === 'history')
check(
  'usage: the timestamp is recent',
  (wallUsage?.touchedAt ?? 0) > Date.now() - 60_000,
  'a stale timestamp on a freshly written skill means the source is wrong'
)

// A skill installed and never edited again: only the log knows it exists, so
// seed the log rather than pretending an agent wrote it.
appendFileSync(
  mod.UNDO_LOG,
  `${JSON.stringify({
    id: 'seed-ancient',
    at: Date.now() - 200 * 24 * 60 * 60 * 1000,
    summary: ['create skill "ancient-thing"'],
    changes: [{ path: join(mod.SKILLS_HOME, 'ancient-thing', 'SKILL.md'), previousContent: null }]
  })}\n`
)

const staleList = mod.staleSkills()
check('usage: a skill untouched for months is flagged', staleList.some((e) => e.name === 'ancient-thing'))
check(
  'usage: a skill written today is not',
  !staleList.some((e) => e.name === 'wall-detection'),
  'flagging the wrong direction destroys the signal'
)

// ════════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════════

const failed = results.filter((r) => !r.pass)
for (const r of results) {
  const mark = r.pass ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
rmSync(outDir, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
