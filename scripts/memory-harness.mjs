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
import { mkdtempSync, rmSync } from 'fs'
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
