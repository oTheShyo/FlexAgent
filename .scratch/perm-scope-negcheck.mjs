/**
 * Negative verification for issue #19.
 *
 * Every new assertion in `scripts/perm-rule-assertions.mjs` is re-run against
 * the implementation it replaced — the sources at HEAD, extracted untouched —
 * and an assertion that passes there too is a description, not a test. This is
 * the "would this have caught the bug" check: run it before trusting the suite.
 *
 *   node .scratch/perm-scope-negcheck.mjs
 *
 * Exit code is 0 only when each case behaves as its `oldBehaviour` field says:
 * 'fails' must fail against the old code, 'same' must still pass there.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { RULE_CASES, runRuleAssertions } from '../scripts/perm-rule-assertions.mjs'

const ROOT = process.cwd()
const OLD_FILES = [
  'src/main/permissionGate.ts',
  'src/main/permissionRules.ts',
  'src/main/security/sensitivePaths.ts',
  'src/shared/contract/index.ts'
]
// One scratch tree per run: reusing a fixed path makes the second run clean up
// the first run's leftovers, which is exactly where these scripts used to die.
const WORK = mkdtempSync(join(tmpdir(), 'flexagent-negcheck-'))
const PERM_HOME = join(WORK, 'home')
const OLD_ROOT = join(WORK, 'head')
const OUT_DIR = join(OLD_ROOT, 'out')

for (const file of OLD_FILES) {
  const target = join(OLD_ROOT, file)
  mkdirSync(dirname(target), { recursive: true })
  // Async spawn: the synchronous one trips over EBUSY on this Windows/git pair.
  const { stdout } = await promisify(execFile)('git', ['show', `HEAD:${file}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  writeFileSync(target, stdout)
}

mkdirSync(OUT_DIR, { recursive: true })
const gateBundle = join(OUT_DIR, 'oldPermissionGate.mjs')
const rulesBundle = join(OUT_DIR, 'oldPermissionRules.mjs')
await build({
  entryPoints: [join(OLD_ROOT, 'src/main/permissionGate.ts')],
  outfile: gateBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'error'
})
await build({
  entryPoints: [join(OLD_ROOT, 'src/main/permissionRules.ts')],
  outfile: rulesBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'error'
})

process.env.USERPROFILE = PERM_HOME
process.env.HOME = PERM_HOME

const gateModule = await import(pathToFileURL(gateBundle).href)
const rulesModule = await import(pathToFileURL(rulesBundle).href)

console.log(`old implementation (HEAD) taken from ${OLD_ROOT}`)
console.log(`rule file redirected to ${PERM_HOME}\n`)

let problems = 0
const lines = []
const failed = await runRuleAssertions(
  { gate: gateModule, rules: rulesModule },
  { cwd: join(PERM_HOME, 'project-a'), otherCwd: join(PERM_HOME, 'project-b') },
  (line) => lines.push(line)
)

lines.forEach((line, index) => {
  const testCase = RULE_CASES[index]
  // `...` in the detail column is just line alignment.
  const ok = line.startsWith('PASS')
  const expected = testCase.oldBehaviour
  const satisfied = expected === 'fails' ? !ok : ok
  if (!satisfied) problems += 1
  console.log(
    `${satisfied ? 'OK  ' : 'BAD '} ${testCase.name.padEnd(46)} ${expected === 'fails' ? 'old code must FAIL this' : 'pre-existing, must still pass'}: ${line.slice(5)}`
  )
})

const mustFail = RULE_CASES.filter((testCase) => testCase.oldBehaviour === 'fails').length
const mustPass = RULE_CASES.length - mustFail
console.log(
  `\nold implementation: ${mustFail}/${mustFail} bug-catching assertions fail there, ` +
    `${mustPass}/${mustPass} pre-existing ones still pass, ${problems} expectation(s) violated.`
)
// Best-effort: a tree that will not give up is left in the temp dir rather
// than allowed to crash the run.
try {
  rmSync(WORK, { recursive: true, force: true })
} catch {
  console.log(`(left behind for inspection: ${WORK})`)
}
process.exit(problems === 0 ? 0 : 1)
