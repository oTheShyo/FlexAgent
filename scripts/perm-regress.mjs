/**
 * Regression harness for the permission gate — runs the real transpiled gate,
 * no provider, no Electron.
 *
 *   node scripts/perm-regress.mjs
 *
 * Covers the MCP semantics (discovery allow / call ask) plus the bash and
 * file-tool behaviour that the classifier work already established, so a change
 * to one layer cannot silently regress another.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const OUT = join(process.cwd(), 'out', 'probe')
mkdirSync(OUT, { recursive: true })
const bundle = join(OUT, 'permissionGate.mjs')
await build({
  entryPoints: ['src/main/permissionGate.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'error'
})
const { PermissionGate, PermissionMemory } = await import(pathToFileURL(bundle).href)

const CWD = process.cwd()
const BUILTIN = [
  { id: 'read-tools', tool: '*read*', action: 'allow' },
  { id: 'search-tools', tool: '*search*', action: 'allow' }
]

const cases = [
  { name: 'mcp search', mode: 'default', tool: 'mcp', args: { mode: 'search', query: 'file' }, want: 'allow' },
  { name: 'mcp describe', mode: 'default', tool: 'mcp', args: { mode: 'describe', tool: 'mcp__user_fs__read_file' }, want: 'allow' },
  { name: 'mcp status', mode: 'default', tool: 'mcp', args: { mode: 'status' }, want: 'allow' },
  { name: 'mcp search in plan mode', mode: 'plan', tool: 'mcp', args: { mode: 'search' }, want: 'allow' },
  { name: 'mcp call', mode: 'default', tool: 'mcp', args: { mode: 'call', tool: 'mcp__user_fs__write_file', args: {} }, want: 'ask' },
  { name: 'mcp call in plan mode', mode: 'plan', tool: 'mcp', args: { mode: 'call' }, want: 'deny' },
  { name: 'direct mcp tool', mode: 'default', tool: 'mcp__user_fs__read_file', args: { path: join(CWD, 'README.md') }, want: 'ask' },
  { name: 'direct mcp tool in bypass', mode: 'bypass', tool: 'mcp__user_fs__read_file', args: { path: join(CWD, 'README.md') }, want: 'allow' },
  { name: 'bash ls -la', mode: 'default', tool: 'bash', args: { command: 'ls -la' }, want: 'allow' },
  { name: 'bash rm -rf /', mode: 'default', tool: 'bash', args: { command: 'rm -rf /' }, want: 'deny' },
  { name: 'bash rm -rf in bypass', mode: 'bypass', tool: 'bash', args: { command: 'rm -rf /' }, want: 'deny' },
  { name: 'bash echo redirect', mode: 'default', tool: 'bash', args: { command: 'echo hi > note.md' }, want: 'ask' },
  { name: 'write inside workspace', mode: 'default', tool: 'write', args: { path: join(CWD, 'a.txt') }, want: 'allow' },
  { name: 'write outside workspace', mode: 'default', tool: 'write', args: { path: 'C:/secret.env' }, want: 'ask' },
  // A write tool is a write tool: inside the workspace it is allowed, which is
  // the whole point of the workspace rule. It must still never be mistaken for
  // a read tool by substring matching.
  { name: 'find_and_replace', mode: 'default', tool: 'find_and_replace', args: { path: join(CWD, 'a.ts') }, want: 'allow' },
  { name: 'find_and_replace outside', mode: 'default', tool: 'find_and_replace', args: { path: 'C:/secret.ts' }, want: 'ask' },
  { name: 'read', mode: 'default', tool: 'read', args: {}, want: 'allow' }
]

let failed = 0
for (const item of cases) {
  const gate = new PermissionGate()
  const { outcome, verdict } = await gate.evaluate(
    { toolName: item.tool, args: item.args },
    { mode: item.mode, cwd: CWD, rules: BUILTIN, memory: new PermissionMemory(`case-${item.name}`), sessionId: item.name }
  )
  const ok = outcome === item.want
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(28)} ${outcome.padEnd(5)} (want ${item.want})  ${verdict.via}: ${verdict.reason}`
  )
}

// 坑一: an allowance for one parameter set must not cover another.
const memory = new PermissionMemory('leak')
memory.record('mcp', PermissionMemory.fingerprintArgs({ mode: 'call', tool: 'mcp__user_fs__read_file' }))
const gate2 = new PermissionGate()
const replay = await gate2.evaluate(
  { toolName: 'mcp', args: { mode: 'call', tool: 'mcp__user_fs__write_file' } },
  { mode: 'default', cwd: CWD, rules: BUILTIN, memory, sessionId: 'leak' }
)
const leakOk = replay.outcome === 'ask'
if (!leakOk) failed += 1
console.log(
  `${leakOk ? 'PASS' : 'FAIL'}  ${'session memory is parameter-scoped'.padEnd(28)} ${replay.outcome.padEnd(5)} (want ask)  ${replay.verdict?.via}: ${replay.verdict?.reason}`
)

console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} PASS`)
process.exit(failed === 0 ? 0 : 1)
