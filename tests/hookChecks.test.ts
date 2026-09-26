import { describe, expect, it } from 'vitest'
import { runHook } from '../src/main/hooks/hookRunner'
import {
  matchesHookMatcher,
  runPreToolUseHooks,
  runPromptSubmitHooks,
  type HookCheckResult,
  type PluginHookDeps,
  type RegisteredHookCheck
} from '../src/main/pluginBridge'
import type { HookRunOptions, HookRunResult } from '../src/main/hooks/hookRunner'
import type { HookEntry } from '../src/main/hookSources'

function hookEntry(partial: Partial<HookEntry>): HookEntry {
  return {
    event: 'PreToolUse',
    type: 'command',
    command: 'node examples/hooks/veto-demo.mjs',
    sourcePath: 'test/hooks.json',
    ...partial
  }
}

function fakeResult(partial: Partial<HookRunResult>): HookRunResult {
  return {
    status: 'ok',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 1,
    blockRequested: false,
    diagnostics: [],
    ...partial
  }
}

function makeDeps(runHookImpl: (options: HookRunOptions) => Promise<HookRunResult>): PluginHookDeps {
  return {
    parseHooksContent: () => ({ entries: [], diagnostics: [] }),
    interpolate: (template) => template,
    runHook: runHookImpl,
    preToolUseChecks: [],
    promptSubmitChecks: []
  }
}

function check(partial: Partial<RegisteredHookCheck>): RegisteredHookCheck {
  return {
    event: 'PreToolUse',
    entry: hookEntry({}),
    plugin: undefined,
    hookContext: {
      pluginRoot: 'C:\\plugins\\demo',
      pluginId: 'demo',
      pluginName: 'demo',
      userConfig: {},
      sensitiveKeys: []
    },
    ...partial
  }
}

describe('matchesHookMatcher', () => {
  it('matches an exact pipe list', () => {
    expect(matchesHookMatcher('Write', 'Write|Edit')).toBe(true)
    expect(matchesHookMatcher('Edit', 'Write|Edit')).toBe(true)
    expect(matchesHookMatcher('Bash', 'Write|Edit')).toBe(false)
  })

  it('treats * and undefined as match-all', () => {
    expect(matchesHookMatcher('Write', '*')).toBe(true)
    expect(matchesHookMatcher('Write', undefined)).toBe(true)
  })

  it('requires a match value when a matcher is set', () => {
    expect(matchesHookMatcher(undefined, 'Write|Edit')).toBe(false)
  })

  it('falls back to regex for non-list matchers', () => {
    expect(matchesHookMatcher('write.tool', '^write\\.')).toBe(true)
    expect(matchesHookMatcher('other.tool', '^write\\.')).toBe(false)
  })

  it('never matches on an invalid regex', () => {
    expect(matchesHookMatcher('Write', '[invalid')).toBe(false)
  })
})

describe('runHook (real subprocess)', () => {
  it('parses JSON stdout and reports allow', async () => {
    const result = await runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ decision: "approve" }))'],
      cwd: process.cwd(),
      timeoutMs: 5000
    })
    expect(result.status).toBe('ok')
    expect(result.blockRequested).toBe(false)
    expect(result.output?.decision).toBe('approve')
  })

  it('reports blockRequested with the hook reason on exit 2', async () => {
    const result = await runHook({
      type: 'process',
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({ decision: "block", reason: "no" }));process.exit(2)'
      ],
      cwd: process.cwd(),
      timeoutMs: 5000
    })
    expect(result.blockRequested).toBe(true)
    expect(result.blockReason).toBe('no')
  })

  it('kills a hook that exceeds its timeout', async () => {
    const result = await runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: process.cwd(),
      timeoutMs: 300
    })
    expect(result.status).toBe('timeout')
  })

  it('survives a missing binary as spawn_error, not a crash', async () => {
    const result = await runHook({
      type: 'process',
      command: 'definitely-not-a-real-binary-xyz',
      cwd: process.cwd(),
      timeoutMs: 2000
    })
    expect(result.status).toBe('spawn_error')
    expect(result.blockRequested).toBe(false)
  })

  it('tolerates non-JSON stdout', async () => {
    const result = await runHook({
      type: 'process',
      command: process.execPath,
      args: ['-e', 'console.log("plain text output")'],
      cwd: process.cwd(),
      timeoutMs: 5000
    })
    expect(result.status).toBe('ok')
    expect(result.output).toBeUndefined()
  })
})

describe('runPreToolUseHooks', () => {
  it('is a no-op with no registered checks', async () => {
    const deps = makeDeps(async () => {
      throw new Error('runHook must not be called')
    })
    const result = await runPreToolUseHooks(deps, {
      toolName: 'Write',
      args: {},
      toolCallId: 't1',
      cwd: process.cwd()
    })
    expect(result.blocked).toBe(false)
  })

  it('skips checks whose matcher does not match the tool name', async () => {
    let called = 0
    const deps = makeDeps(async () => {
      called += 1
      return fakeResult({})
    })
    deps.preToolUseChecks.push(
      check({ matcher: 'Write|Edit', entry: hookEntry({ matcher: 'Write|Edit' }) })
    )
    const result = await runPreToolUseHooks(deps, {
      toolName: 'Bash',
      args: {},
      toolCallId: 't1',
      cwd: process.cwd()
    })
    expect(called).toBe(0)
    expect(result.blocked).toBe(false)
  })

  it('blocks with the hook reason on a veto', async () => {
    const deps = makeDeps(async () => fakeResult({ blockRequested: true, blockReason: 'demo veto' }))
    deps.preToolUseChecks.push(check({}))
    const result = await runPreToolUseHooks(deps, {
      toolName: 'Write',
      args: { file_path: 'x' },
      toolCallId: 't1',
      cwd: process.cwd()
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('demo veto')
  })

  it('short-circuits on the first block', async () => {
    let secondCalled = 0
    const wrap = async (options: HookRunOptions): Promise<HookRunResult> => {
      if (options.command === 'second') secondCalled += 1
      return fakeResult({ blockRequested: true, blockReason: 'first' })
    }
    const deps = makeDeps(wrap)
    deps.preToolUseChecks.push(check({}))
    deps.preToolUseChecks.push(
      check({
        entry: hookEntry({ command: 'second' })
      })
    )
    const result = await runPreToolUseHooks(deps, {
      toolName: 'Write',
      args: {},
      toolCallId: 't1',
      cwd: process.cwd()
    })
    expect(result.blocked).toBe(true)
    expect(secondCalled).toBe(0)
  })

  it('passes the kernel stdin payload shape to the hook', async () => {
    let seenStdin = ''
    const deps = makeDeps(async (options) => {
      seenStdin = options.stdin ?? ''
      return fakeResult({})
    })
    deps.preToolUseChecks.push(check({}))
    await runPreToolUseHooks(deps, {
      toolName: 'Write',
      args: { file_path: 'a.txt' },
      toolCallId: 'call-9',
      cwd: 'C:\\proj'
    })
    const payload = JSON.parse(seenStdin) as Record<string, unknown>
    expect(payload.hook_event_name).toBe('PreToolUse')
    expect(payload.tool_name).toBe('Write')
    expect(payload.tool_use_id).toBe('call-9')
    expect(payload.cwd).toBe('C:\\proj')
  })
})

describe('runPromptSubmitHooks', () => {
  it('collects additionalContext from every matching hook', async () => {
    const deps = makeDeps(async (options) => {
      const payload = JSON.parse((options.stdin ?? '{}').trim()) as Record<string, unknown>
      return fakeResult({ output: { additionalContext: `ctx for ${String(payload.prompt)}` } })
    })
    deps.promptSubmitChecks.push(check({ event: 'UserPromptSubmit', entry: hookEntry({ event: 'UserPromptSubmit' }) }))
    deps.promptSubmitChecks.push(check({ event: 'UserPromptSubmit', entry: hookEntry({ event: 'UserPromptSubmit' }) }))
    const result: HookCheckResult = await runPromptSubmitHooks(deps, {
      prompt: 'hello',
      cwd: process.cwd()
    })
    expect(result.blocked).toBe(false)
    expect(result.additionalContext).toBe('ctx for hello\n\nctx for hello')
  })

  it('blocks a prompt and returns the reason', async () => {
    const deps = makeDeps(async () => fakeResult({ blockRequested: true, blockReason: 'not allowed' }))
    deps.promptSubmitChecks.push(check({ event: 'UserPromptSubmit', entry: hookEntry({ event: 'UserPromptSubmit' }) }))
    const result = await runPromptSubmitHooks(deps, { prompt: 'BLOCK-DEMO', cwd: process.cwd() })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('not allowed')
  })

  it('records an interpolation failure as a diagnostic without blocking', async () => {
    const deps = makeDeps(async () => fakeResult({}))
    deps.interpolate = () => {
      throw new Error('bad template')
    }
    deps.promptSubmitChecks.push(check({ event: 'UserPromptSubmit', entry: hookEntry({ event: 'UserPromptSubmit' }) }))
    const result = await runPromptSubmitHooks(deps, { prompt: 'x', cwd: process.cwd() })
    expect(result.blocked).toBe(false)
    expect(result.diagnostics.some((line) => line.includes('interpolation failed'))).toBe(true)
  })
})
