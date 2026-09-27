#!/usr/bin/env node
// Example hook — demonstrates all four enforcement-capable events:
//   PreToolUse        veto a Write/Edit to any path containing DO-NOT-WRITE (13)
//   UserPromptSubmit  inject context on every prompt, block BLOCK-DEMO (13)
//   Stop              block the end of a turn that never reported a test (14)
//   PermissionRequest auto-answer a prompt, or refuse one outright (14)
//
// Contract (see docs/plugin-backend.md): the kernel writes one JSON payload on
// stdin; the hook answers on stdout. Exit 0 = allow (stdout may carry JSON),
// exit 2 = veto (stdout JSON carries the reason the model will see).

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  raw += chunk
})
process.stdin.on('end', () => {
  let input = {}
  try {
    input = JSON.parse(raw)
  } catch {
    process.exit(0)
  }
  const event = input.hook_event_name ?? input.hookEventName

  if (event === 'PreToolUse') {
    const tool = input.tool_name ?? input.toolName
    const toolInput = input.tool_input ?? input.toolInput ?? {}
    const filePath = String(toolInput.file_path ?? '')
    if ((tool === 'Write' || tool === 'Edit') && filePath.includes('DO-NOT-WRITE')) {
      process.stdout.write(
        JSON.stringify({
          decision: 'block',
          reason: 'Example hook: paths containing DO-NOT-WRITE are protected'
        }) + '\n'
      )
      process.exit(2)
    }
    process.exit(0)
  }

  // Ticket 14: the model is about to end its turn. Nothing here is enforced by
  // the hook itself — it answers, and the worker decides (cap: 3 blocks).
  if (event === 'Stop') {
    const lastMessage = String(input.last_assistant_message ?? '')
    if (lastMessage.length > 0 && !/test|spec|npm run/i.test(lastMessage)) {
      process.stdout.write(
        JSON.stringify({
          decision: 'block',
          reason: 'Example hook: report the test command and its result before ending the turn'
        }) + '\n'
      )
      process.exit(2)
    }
    process.exit(0)
  }

  // Ticket 14: fires only where the chain would have asked the human. Never
  // answers `allow` for a command that looks destructive — and it does not need
  // to, because an allow cannot lift a hard-denied shape anyway.
  if (event === 'PermissionRequest') {
    const toolInput = input.tool_input ?? input.toolInput ?? {}
    const command = String(toolInput.command ?? '')
    if (/rm\s+-rf|git\s+push.*--force/i.test(command)) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: 'Example hook: destructive commands are never auto-approved'
          }
        }) + '\n'
      )
      process.exit(0)
    }
    if (typeof toolInput.path === 'string' && toolInput.path.includes('/scratch/')) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: 'allow',
            permissionDecisionReason: 'Example hook: writes under /scratch/ are pre-approved'
          }
        }) + '\n'
      )
    }
    process.exit(0)
  }

  if (event === 'UserPromptSubmit') {
    const prompt = String(input.prompt ?? '')
    if (prompt.includes('BLOCK-DEMO')) {
      process.stdout.write(
        JSON.stringify({
          decision: 'block',
          reason: 'Example hook: prompts containing BLOCK-DEMO are blocked'
        }) + '\n'
      )
      process.exit(2)
    }
    process.stdout.write(
      JSON.stringify({
        additionalContext: '(example UserPromptSubmit hook ran: this workspace has hooks enabled)'
      }) + '\n'
    )
    process.exit(0)
  }

  process.exit(0)
})
