#!/usr/bin/env node
// Example hook for ticket 13 — demonstrates both enforcement-capable events:
//   PreToolUse      veto a Write/Edit to any path containing DO-NOT-WRITE
//   UserPromptSubmit inject context on every prompt, block prompts with BLOCK-DEMO
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
