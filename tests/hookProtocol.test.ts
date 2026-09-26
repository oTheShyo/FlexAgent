import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { PluginBridgeDiagnostic, PluginHookDeps } from '../src/main/pluginBridge'
import type { HookRunOptions, HookRunResult } from '../src/main/hooks/hookRunner'
import type { PluginResourceSpec } from '../src/shared/kernel-protocol'
import { useHermeticHome } from './helpers/hermeticHome'

const { home, cleanup } = useHermeticHome('flexagent-hooks-')
const scratch = join(home, 'scratch')
mkdirSync(scratch, { recursive: true })

const hookRunner = await import('../src/main/hooks/hookRunner')
const hookSources = await import('../src/main/hookSources')
const pluginBridge = await import('../src/main/pluginBridge')

afterAll(cleanup)

const node = process.execPath

function runNode(script: string, extra: Partial<HookRunOptions> = {}): Promise<HookRunResult> {
  return hookRunner.runHook({ type: 'process', command: node, args: ['-e', script], cwd: scratch, ...extra })
}

const ECHO_STDIN_CHILD =
  "let d='';process.stdin.on('data',c=>{d+=c});process.stdin.on('end',()=>{" +
  'const i=JSON.parse(d);' +
  "process.stdout.write(JSON.stringify({continue:true,reason:'event='+i.hook_event_name+' tool='+(i.tool_name||'-')}))})"

describe('runHook — the hook process protocol', () => {
  it('delivers stdin as JSON and parses structured stdout back out', async () => {
    const result = await runNode(ECHO_STDIN_CHILD, {
      stdin: `${JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'bash' })}\n`
    })

    expect(result.status).toBe('ok')
    expect(result.exitCode).toBe(0)
    expect(result.output).toMatchObject({ continue: true, reason: 'event=PreToolUse tool=bash' })
    expect(result.diagnostics).toEqual([])
  })

  it('treats non-JSON stdout as a plain log — status ok, never promoted to context', async () => {
    const result = await runNode("process.stdout.write('plain diagnostic line\\n')")

    expect(result.status).toBe('ok')
    expect(result.output).toBeUndefined()
    expect(result.stdout).toContain('plain diagnostic line')
    expect(result.diagnostics).toEqual([])
  })

  it('rejects structurally invalid JSON objects as hook_output_invalid', async () => {
    const wrongType = await runNode("process.stdout.write('{\"continue\":\"yes\"}')")
    expect(wrongType.status).toBe('failed')
    expect(wrongType.blockRequested).toBe(false)
    expect(wrongType.diagnostics[0]).toMatchObject({ code: 'hook_output_invalid' })
    expect(wrongType.diagnostics[0]!.message).toContain('continue')

    const badDecision = await runNode("process.stdout.write('{\"decision\":\"maybe\"}')")
    expect(badDecision.status).toBe('failed')
    expect(badDecision.diagnostics[0]!.message).toContain('approve')
  })

  it('exit 0 carries structured output; exit 2 requests a block with the stderr reason', async () => {
    const structured = await runNode("process.stdout.write('{\"continue\":true,\"reason\":\"ok\"}')")
    expect(structured.status).toBe('ok')
    expect(structured.output).toMatchObject({ continue: true })

    const blocked = await runNode("process.stderr.write('blocked by policy');process.exit(2)")
    expect(blocked.status).toBe('ok')
    expect(blocked.exitCode).toBe(2)
    expect(blocked.blockRequested).toBe(true)
    expect(blocked.blockReason).toBe('blocked by policy')
    expect(blocked.diagnostics).toEqual([])
  })

  it('exit 1 and other non-zero codes are recoverable failures, not crashes', async () => {
    const exitOne = await runNode("process.stderr.write('boom');process.exit(1)")
    expect(exitOne.status).toBe('failed')
    expect(exitOne.blockRequested).toBe(false)
    expect(exitOne.diagnostics[0]).toMatchObject({ code: 'hook_exit_nonzero' })
    expect(exitOne.diagnostics[0]!.message).toContain('boom')

    const exitSeven = await runNode('process.exit(7)')
    expect(exitSeven.status).toBe('failed')
    expect(exitSeven.exitCode).toBe(7)
    expect(exitSeven.diagnostics[0]).toMatchObject({ code: 'hook_exit_nonzero' })
  })

  it('a hook that outlives its timeout is killed and reported as timeout', async () => {
    const result = await runNode('setTimeout(()=>{},30000)', { timeoutMs: 500 })

    expect(result.status).toBe('timeout')
    expect(result.blockRequested).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ code: 'hook_timeout' })
    expect(result.durationMs).toBeLessThan(15_000)
  })

  it('stdout beyond maxOutputBytes is capped, flagged, and the hook still succeeds', async () => {
    const result = await runNode("process.stdout.write('x'.repeat(50000))", { maxOutputBytes: 1024 })

    expect(result.status).toBe('ok')
    expect(result.truncated).toBe(true)
    expect(result.stdout).toHaveLength(1024)
  })

  it('a missing binary resolves to spawn_error instead of throwing', async () => {
    const result = await hookRunner.runHook({
      type: 'process',
      command: join(scratch, 'definitely-not-a-real-binary.exe'),
      cwd: scratch
    })

    expect(result.status).toBe('spawn_error')
    expect(result.diagnostics[0]).toMatchObject({ code: 'hook_spawn_error' })
  })
})

describe('parseHooksContent — hooks.json manifest parsing', () => {
  it('parses matcher groups into entries with timeouts resolved to milliseconds', () => {
    const content = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'bash|shell',
            hooks: [{ type: 'command', command: 'node', args: ['-e', 'process.exit(0)'], timeout: 5 }]
          },
          { hooks: [{ type: 'process', command: 'node', timeoutMs: 1500 }] }
        ]
      }
    })

    const { entries, diagnostics } = hookSources.parseHooksContent(content, 'hooks.json')

    expect(diagnostics).toEqual([])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      event: 'PreToolUse',
      matcher: 'bash|shell',
      type: 'command',
      command: 'node',
      timeoutMs: 5000
    })
    expect(entries[1]).toMatchObject({ event: 'PreToolUse', type: 'process', timeoutMs: 1500 })
    expect(entries[1]!.matcher).toBeUndefined()
  })

  it('malformed JSON degrades to a diagnostic instead of throwing', () => {
    const { entries, diagnostics } = hookSources.parseHooksContent('{not json', 'hooks.json')
    expect(entries).toEqual([])
    expect(diagnostics[0]).toMatchObject({ code: 'plugin_hook_read_failed' })
  })

  it('a missing hooks object is reported as plugin_hook_invalid', () => {
    const { entries, diagnostics } = hookSources.parseHooksContent('{"nope":1}', 'hooks.json')
    expect(entries).toEqual([])
    expect(diagnostics[0]).toMatchObject({ code: 'plugin_hook_invalid' })
  })

  it('disabled hooks are skipped; invalid hook configs are reported', () => {
    const content = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'process', command: 'node', enabled: false },
              { type: 'bogus', command: 'node' }
            ]
          }
        ]
      }
    })

    const { entries, diagnostics } = hookSources.parseHooksContent(content, 'hooks.json')
    expect(entries).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ code: 'plugin_hook_invalid' })
    expect(diagnostics[0]!.message).toContain('command or process')
  })
})

interface RecordedHookRun {
  options: HookRunOptions
}

interface HookHandlerResult {
  registered: number
  diagnostics: PluginBridgeDiagnostic[]
  handlers: Map<string, (payload: unknown, ctx: unknown) => void | Promise<void>>
  runs: RecordedHookRun[]
  deps: PluginHookDeps
}

function registerHooksFrom(
  manifest: Record<string, unknown>,
  manifestName: string
): HookHandlerResult {
  const manifestPath = join(scratch, manifestName)
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

  const spec: PluginResourceSpec = {
    extensionPaths: [],
    skillRoots: [],
    commands: [],
    hooks: [manifestPath],
    hookContexts: {},
    mcp: [],
    pluginStorageRoot: join(scratch, 'plugin-storage')
  }

  const handlers = new Map<string, (payload: unknown, ctx: unknown) => void | Promise<void>>()
  const on = (event: string, handler: (payload: unknown, ctx: unknown) => void): void => {
    handlers.set(event, handler)
  }
  const runs: RecordedHookRun[] = []
  const deps: PluginHookDeps = {
    parseHooksContent: hookSources.parseHooksContent,
    interpolate: (template: string): string => template,
    runHook: async (options: HookRunOptions): Promise<HookRunResult> => {
      runs.push({ options })
      return hookRunner.runHook(options)
    },
    preToolUseChecks: [],
    promptSubmitChecks: []
  }

  const diagnostics: PluginBridgeDiagnostic[] = []
  const { registered } = pluginBridge.registerPluginHooks(spec, on, pluginBridge.nodeBridgeFsRead, deps, diagnostics)
  return { registered, diagnostics, handlers, runs, deps }
}

const PRE_TOOL_EVENT = 'tool_execution_start'

describe('registerPluginHooks — enforcement-capable events become checks (ticket 13)', () => {
  it('registers a PreToolUse entry as a check and runs it with the kernel stdin shape', async () => {
    const bridge = registerHooksFrom(
      {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'process', command: node, args: ['-e', ECHO_STDIN_CHILD] }] }
          ]
        }
      },
      'bridge-stdin.json'
    )
    expect(bridge.registered).toBe(1)
    expect(bridge.diagnostics).toEqual([])
    expect(bridge.handlers.get(PRE_TOOL_EVENT)).toBeUndefined()

    const outcome = await pluginBridge.runPreToolUseHooks(bridge.deps, {
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 't1',
      cwd: scratch
    })

    expect(outcome.blocked).toBe(false)
    expect(bridge.runs).toHaveLength(1)
    const stdin = bridge.runs[0]!.options.stdin
    expect(stdin).toBeDefined()
    const parsed = JSON.parse(stdin!) as Record<string, unknown>
    expect(parsed.hook_event_name).toBe('PreToolUse')
    expect(parsed.tool_name).toBe('bash')
    expect(parsed.tool_use_id).toBe('t1')
    expect(parsed.tool_input).toEqual({ command: 'ls' })
    expect(parsed.cwd).toBe(scratch)
    expect(bridge.diagnostics).toEqual([])
  })

  it('enforces a PreToolUse block request as a veto with the hook reason', async () => {
    const bridge = registerHooksFrom(
      {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'process', command: node, args: ['-e', "process.stderr.write('nope: denied');process.exit(2)"] }] }
          ]
        }
      },
      'bridge-block.json'
    )

    const outcome = await pluginBridge.runPreToolUseHooks(bridge.deps, {
      toolName: 'bash',
      args: { command: 'rm x' },
      toolCallId: 't2',
      cwd: scratch
    })

    expect(outcome.blocked).toBe(true)
    expect(outcome.reason).toContain('nope: denied')
    expect(bridge.diagnostics).toEqual([])
  })

  it('propagates a recoverable exit-1 failure as a diagnostic without blocking', async () => {
    const bridge = registerHooksFrom(
      {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'process', command: node, args: ['-e', "process.stderr.write('kaboom');process.exit(1)"] }] }
          ]
        }
      },
      'bridge-fail.json'
    )

    const outcome = await pluginBridge.runPreToolUseHooks(bridge.deps, {
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 't3',
      cwd: scratch
    })

    expect(outcome.blocked).toBe(false)
    expect(outcome.diagnostics).toHaveLength(1)
    expect(outcome.diagnostics[0]).toContain('kaboom')
  })

  it('a non-matching matcher skips the hook entirely', async () => {
    const bridge = registerHooksFrom(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'read',
              hooks: [{ type: 'process', command: node, args: ['-e', 'process.exit(0)'] }]
            }
          ]
        }
      },
      'bridge-matcher.json'
    )

    const outcome = await pluginBridge.runPreToolUseHooks(bridge.deps, {
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 't4',
      cwd: scratch
    })

    expect(bridge.runs).toEqual([])
    expect(outcome.blocked).toBe(false)
  })
})
