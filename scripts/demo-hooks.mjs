/**
 * One-command demo of all four enforcement-capable hook events.
 *
 *   node scripts/demo-hooks.mjs
 *
 * Spawns the example hook (examples/hooks/veto-demo.mjs) with the exact stdin
 * payloads the kernel produces (pluginBridge buildHookStdin) and checks the
 * documented decision contract: exit 0 = allow (stdout may carry JSON),
 * exit 2 = veto (stdout JSON carries the reason). Exercises the hooks and the
 * protocol end-to-end; the in-kernel wiring is covered by tests/hookChecks.test.ts.
 *
 * Ticket 13: PreToolUse, UserPromptSubmit. Ticket 14: Stop, PermissionRequest.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const hookScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'hooks', 'veto-demo.mjs')

function runHookOnce(event, payload) {
  const stdin = `${JSON.stringify({ hook_event_name: event, hookEventName: event, cwd: process.cwd(), timestamp: new Date().toISOString(), ...payload })}\n`
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookScript], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdin.write(stdin)
    child.stdin.end()
    child.on('close', (code) => {
      let output
      try {
        output = JSON.parse(stdout.trim())
      } catch {
        output = undefined
      }
      resolve({ code, stdout, stderr, output })
    })
  })
}

let failures = 0
function check(name, pass, detail) {
  if (!pass) failures += 1
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const results = []

results.push([
  'PreToolUse veto (Write to a DO-NOT-WRITE path)',
  await runHookOnce('PreToolUse', {
    toolName: 'Write',
    tool_name: 'Write',
    args: { file_path: 'some/DO-NOT-WRITE/file.txt' },
    tool_input: { file_path: 'some/DO-NOT-WRITE/file.txt' },
    toolCallId: 'demo-1',
    tool_use_id: 'demo-1'
  }),
  (r) => r.code === 2 && r.output?.decision === 'block' && typeof r.output?.reason === 'string'
])

results.push([
  'PreToolUse allow (Write to a normal path)',
  await runHookOnce('PreToolUse', {
    toolName: 'Write',
    tool_name: 'Write',
    args: { file_path: 'src/normal.txt' },
    tool_input: { file_path: 'src/normal.txt' },
    toolCallId: 'demo-2',
    tool_use_id: 'demo-2'
  }),
  (r) => r.code === 0
])

results.push([
  'PreToolUse matcher skip (Bash is not matched by Write|Edit)',
  await runHookOnce('PreToolUse', {
    toolName: 'Bash',
    tool_name: 'Bash',
    args: { command: 'echo hi' },
    tool_input: { command: 'echo hi' },
    toolCallId: 'demo-3',
    tool_use_id: 'demo-3'
  }),
  (r) => r.code === 0
])

results.push([
  'UserPromptSubmit additionalContext',
  await runHookOnce('UserPromptSubmit', { prompt: 'hello there' }),
  (r) => r.code === 0 && typeof r.output?.additionalContext === 'string'
])

results.push([
  'UserPromptSubmit block (prompt contains BLOCK-DEMO)',
  await runHookOnce('UserPromptSubmit', { prompt: 'please BLOCK-DEMO this' }),
  (r) => r.code === 2 && r.output?.decision === 'block' && typeof r.output?.reason === 'string'
])

// ── ticket 14: Stop (continue the turn) ──────────────────────────────────────
// The hook only answers; the worker owns the cap and the audit trail.

results.push([
  'Stop continue (turn ended without reporting a test)',
  await runHookOnce('Stop', { last_assistant_message: 'Done — I changed two files.' }),
  (r) => r.code === 2 && r.output?.decision === 'block' && typeof r.output?.reason === 'string'
])

results.push([
  'Stop allow (turn reported the test command and result)',
  await runHookOnce('Stop', {
    last_assistant_message: 'Ran npm run test — 228 passed.'
  }),
  (r) => r.code === 0
])

// ── ticket 14: PermissionRequest (auto-decide what would have asked) ─────────

results.push([
  'PermissionRequest deny (destructive command)',
  await runHookOnce('PermissionRequest', {
    toolName: 'Bash',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
    toolCallId: 'demo-4',
    tool_use_id: 'demo-4'
  }),
  (r) => r.code === 0 && r.output?.hookSpecificOutput?.permissionDecision === 'deny'
])

results.push([
  'PermissionRequest allow (write under /scratch/)',
  await runHookOnce('PermissionRequest', {
    toolName: 'Write',
    tool_name: 'Write',
    tool_input: { path: '/scratch/out.txt' },
    toolCallId: 'demo-5',
    tool_use_id: 'demo-5'
  }),
  (r) => r.code === 0 && r.output?.hookSpecificOutput?.permissionDecision === 'allow'
])

results.push([
  'PermissionRequest abstains (no vote = the chain asks the human as before)',
  await runHookOnce('PermissionRequest', {
    toolName: 'Bash',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    toolCallId: 'demo-6',
    tool_use_id: 'demo-6'
  }),
  (r) => r.code === 0 && r.output === undefined
])

for (const [name, result, pass] of results) {
  check(name, pass(result))
}

console.log(failures === 0 ? '\nAll hook demo checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
