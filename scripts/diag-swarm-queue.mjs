/**
 * Logic check for the Swarm task queue and the role parallel-compatibility
 * table — no Electron, no model calls. Exercises the real module via Node's
 * type stripping:
 *
 *   node --experimental-strip-types scripts/diag-swarm-queue.mjs
 *
 * Runs against a throwaway FLEXAGENT_SWARM_HOME so the user's live queue at
 * ~/.flexagent/swarm is never touched.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'flexagent-swarm-diag-'))
process.env.FLEXAGENT_SWARM_HOME = join(home, 'swarm')

const { SwarmTaskQueue, resetSwarmQueueForTests, SWARM_HOME } = await import(
  '../src/main/agents/swarmQueue.ts'
)
const { canRunInParallel, ROLES, auditSymmetry } = await import('../src/main/agents/roles.ts')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  // -- role table -----------------------------------------------------------
  check('role symmetry audit clean', auditSymmetry().length === 0, auditSymmetry().join('; '))
  check('researcher ∥ analyst (article table)', canRunInParallel(ROLES.researcher, ROLES.analyst))
  check('developer ∥ designer (article table)', canRunInParallel(ROLES.developer, ROLES.designer))
  check('developer ∥ developer is serial', !canRunInParallel(ROLES.developer, ROLES.developer))
  check('asymmetric pair falls back to serial', !canRunInParallel(ROLES.developer, ROLES.researcher))

  // -- queue basics ---------------------------------------------------------
  resetSwarmQueueForTests()
  const queue = new SwarmTaskQueue()
  const a = queue.submit({ title: 'scan repo', detail: 'list entry points', createdBy: 'coord' })
  check('submit yields pending task', a.status === 'pending' && a.id === 't-0001')

  const first = queue.claim('peer-A')
  check('claim marks claimed', first?.id === 'a-placeholder' ? false : first?.status === 'claimed')
  const second = queue.claim('peer-B')
  check('atomic claim: one task cannot be claimed twice', second === undefined)

  // -- dependencies ---------------------------------------------------------
  const b = queue.submit({
    title: 'synthesise',
    detail: 'merge findings',
    deps: [a.id],
    createdBy: 'coord'
  })
  check('dependent task not claimable before dep done', queue.claim('peer-B')?.id !== b.id)
  queue.complete(a.id, 'peer-A', 'found 3 entry points')
  const bClaim = queue.claim('peer-B')
  check('dependent claimable after dep done', bClaim?.id === b.id)

  const wrongPeer = (() => {
    try {
      queue.complete(b.id, 'peer-C', 'nope')
      return false
    } catch {
      return true
    }
  })()
  check('complete by non-holder rejected', wrongPeer)
  queue.complete(b.id, 'peer-B', 'merged')
  check('done is terminal', queue.status().done === 2)

  // -- dep validation -------------------------------------------------------
  const failures = [
    ['unknown dep', () => queue.submit({ title: 'x', detail: 'x', deps: ['t-9999'], createdBy: 'c' })],
    ['self dep', () => queue.submit({ title: 'x', detail: 'x', deps: ['t-0003'], createdBy: 'c' })],
    ['failed dep', () => {
      const t = queue.submit({ title: 'y', detail: 'y', createdBy: 'c' })
      const c = queue.claim('peer-A')
      queue.fail(c.id, 'peer-A', 'impossible')
      return queue.submit({ title: 'z', detail: 'z', deps: [c.id], createdBy: 'c' })
    }]
  ]
  for (const [name, fn] of failures) {
    let threw = false
    try {
      fn()
    } catch {
      threw = true
    }
    check(`dep validation rejects ${name}`, threw)
  }

  // -- crash recovery -------------------------------------------------------
  // Fresh queue file: earlier phases share the throwaway home, and recovery
  // must be judged on its own tasks only.
  rmSync(join(SWARM_HOME, 'tasks.json'), { force: true })
  resetSwarmQueueForTests()
  const queue2 = new SwarmTaskQueue()
  queue2.submit({ title: 'r1', detail: 'd1', createdBy: 'c' })
  queue2.submit({ title: 'r2', detail: 'd2', createdBy: 'c' })
  const claimed = queue2.claim('peer-doomed')
  queue2.complete(queue2.claim('peer-lucky').id, 'peer-lucky', 'ok')
  // Worker restart = peers die; the file on disk still says "claimed".
  resetSwarmQueueForTests()
  const queue3 = new SwarmTaskQueue()
  const snapshot = queue3.status()
  check(
    'recovery: claimed → pending, done stays done',
    snapshot.tasks.find((t) => t.id === claimed.id).status === 'pending' && snapshot.done === 1,
    JSON.stringify({ pending: snapshot.pending, done: snapshot.done })
  )
  check('recovery: results survive restart', snapshot.tasks.every((t) => t.status !== 'done' || t.result === 'ok'))

  // -- durability file ------------------------------------------------------
  const rawFile = join(SWARM_HOME, 'tasks.json')
  check('queue persisted atomically to disk', existsSync(rawFile))
  const parsed = JSON.parse(readFileSync(rawFile, 'utf8'))
  check('persisted file parses with version 1', parsed.version === 1 && Array.isArray(parsed.tasks))

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
