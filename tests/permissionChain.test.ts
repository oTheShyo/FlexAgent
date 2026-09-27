import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GateOptions } from '../src/main/permissionGate'
import type { PermissionRule, PermissionVerdict } from '../src/shared/contract'
import { useHermeticHome } from './helpers/hermeticHome'

const { home, cleanup } = useHermeticHome('flexagent-perm-')
const workspace = join(home, 'workspace')
mkdirSync(workspace, { recursive: true })

const gate = await import('../src/main/permissionGate')
const permissionRules = await import('../src/main/permissionRules')

afterAll(cleanup)

const { PermissionGate, PermissionMemory, hardDenyFor } = gate

function baseOptions(overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    mode: 'default',
    cwd: workspace,
    rules: [],
    memory: new PermissionMemory('perm-suite'),
    sessionId: 'perm-suite',
    ...overrides
  }
}

function classifierSpy(): { calls: string[]; classifyBash: NonNullable<GateOptions['classifyBash']> } {
  const calls: string[] = []
  const classifyBash = async (command: string): Promise<PermissionVerdict> => {
    calls.push(command)
    return { outcome: 'allow', via: 'classifier', reason: 'stubbed classifier allows' }
  }
  return { calls, classifyBash }
}

describe('permission chain — the five decision layers run in order', () => {
  it('layer 1 — session memory outranks a deny rule for the same call', async () => {
    const memory = new PermissionMemory('mem-1')
    const args = { command: 'npm test' }
    memory.record('bash', PermissionMemory.fingerprintArgs(args))

    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args },
      baseOptions({
        memory,
        rules: [{ id: 'deny-tests', tool: 'bash', action: 'deny', note: 'no tests here' }]
      })
    )

    expect(result.outcome).toBe('allow')
    expect(result.verdict.via).toBe('user')
    expect(result.verdict.reason).toContain('same parameters')
  })

  it('layer 1 — an allowance never leaks to different parameters', async () => {
    const memory = new PermissionMemory('mem-1')
    memory.record('bash', PermissionMemory.fingerprintArgs({ command: 'npm test' }))
    const spy = classifierSpy()

    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'rm -rf /tmp/build' } },
      baseOptions({ memory, classifyBash: spy.classifyBash })
    )

    expect(result.outcome).toBe('deny')
    expect(result.verdict.reason).toContain('recursive force delete')
    expect(spy.calls).toEqual([])
  })

  it('hard deny is a capability limit — no rule can allow it', async () => {
    const spy = classifierSpy()
    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'rm -rf build' } },
      baseOptions({
        classifyBash: spy.classifyBash,
        rules: [{ id: 'allow-rm', command: 'rm -rf', action: 'allow', note: 'user insists' }]
      })
    )

    expect(result.outcome).toBe('deny')
    expect(result.verdict.via).toBe('heuristic')
    expect(result.verdict.reason).toContain('recursive force delete')
    expect(result.verdict.reason).toContain('no rule can allow this')
    expect(spy.calls).toEqual([])
  })

  it('hard deny survives bypass mode and never reaches the classifier', async () => {
    const spy = classifierSpy()
    const forcePush = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'git push --force origin main' } },
      baseOptions({ mode: 'bypass', classifyBash: spy.classifyBash })
    )
    expect(forcePush.outcome).toBe('deny')
    expect(forcePush.verdict.reason).toContain('force push')

    const sudo = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'sudo apt-get install jq' } },
      baseOptions({ mode: 'bypass', classifyBash: spy.classifyBash })
    )
    expect(sudo.outcome).toBe('deny')
    expect(sudo.verdict.reason).toContain('elevated execution')

    expect(spy.calls).toEqual([])
  })

  it('hardDenyFor names the refused shapes and declines benign commands', () => {
    expect(hardDenyFor('rm -rf dist')).toBe('recursive force delete')
    expect(hardDenyFor('git push --force')).toBe('force push')
    expect(hardDenyFor('git reset --hard HEAD~3')).toBe('hard reset discards work')
    expect(hardDenyFor('sudo rm -rf /')).toBe('elevated execution')
    expect(hardDenyFor('dd if=/dev/zero of=/dev/sda')).toBe('writing to a block device with dd')
    expect(hardDenyFor('ls -la')).toBeUndefined()
    expect(hardDenyFor('rm notes.txt')).toBeUndefined()
    expect(hardDenyFor('')).toBeUndefined()
  })

  it('layer 2 — a deny rule outranks the read-only heuristic', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'read', args: { path: 'secrets-notes.txt' } },
      baseOptions({
        rules: [{ id: 'no-read', tool: '*read*', action: 'deny', note: 'no reads' }]
      })
    )

    expect(result.outcome).toBe('deny')
    expect(result.verdict.via).toBe('rule')
    expect(result.verdict.reason).toBe('no reads')
  })

  it('layer 2 — refusal beats an earlier allow (deny → ask → allow collection)', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'rm old.txt' } },
      baseOptions({
        rules: [
          { id: 'allow-all', tool: '*', action: 'allow' },
          { id: 'no-rm', command: 'rm ', action: 'deny' }
        ]
      })
    )

    expect(result.outcome).toBe('deny')
    expect(result.verdict.via).toBe('rule')
    expect(result.verdict.reason).toContain('no-rm')
  })

  it('layer 2 — an allow rule beats the heuristic ask for a mutating command', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'rm docs/draft.txt' } },
      baseOptions({
        rules: [{ id: 'allow-rm-docs', command: 'rm docs/draft.txt', action: 'allow' }]
      })
    )

    expect(result.outcome).toBe('allow')
    expect(result.verdict.via).toBe('rule')
  })

  it('layer 3 — heuristic-resolved calls never reach the classifier', async () => {
    const spy = classifierSpy()
    const gate = new PermissionGate()

    const read = await gate.evaluate(
      { toolName: 'read', args: { path: 'notes.md' } },
      baseOptions({ classifyBash: spy.classifyBash })
    )
    expect(read.outcome).toBe('allow')
    expect(read.verdict.via).toBe('heuristic')

    const destructiveAsk = await gate.evaluate(
      { toolName: 'bash', args: { command: 'rm old.txt' } },
      baseOptions({ classifyBash: spy.classifyBash })
    )
    expect(destructiveAsk.outcome).toBe('ask')
    expect(destructiveAsk.verdict.via).toBe('heuristic')

    expect(spy.calls).toEqual([])
  })

  it('layer 4 — the classifier runs only for unresolved commands, and its verdict is cached', async () => {
    const spy = classifierSpy()
    const gate = new PermissionGate()
    const options = baseOptions({ classifyBash: spy.classifyBash })
    const request = { toolName: 'bash', args: { command: 'python deploy.py --release' } }

    const first = await gate.evaluate(request, options)
    expect(first.outcome).toBe('allow')
    expect(first.verdict.via).toBe('classifier')
    expect(spy.calls).toEqual(['python deploy.py --release'])

    const second = await gate.evaluate(request, options)
    expect(second.outcome).toBe('allow')
    expect(spy.calls).toHaveLength(1)
  })

  it('layer 4 — an unreachable classifier degrades to ask, never allow', async () => {
    const calls: string[] = []
    const classifyBash = async (command: string): Promise<undefined> => {
      calls.push(command)
      return undefined
    }

    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'python deploy.py' } },
      baseOptions({ classifyBash })
    )

    expect(result.outcome).toBe('ask')
    expect(result.verdict.reason).toContain('classifier unreachable')
    expect(calls).toHaveLength(1)
  })

  it('layer 5 — plan mode denies a write even when the classifier allowed it', async () => {
    const spy = classifierSpy()
    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'python deploy.py --release' } },
      baseOptions({ mode: 'plan', classifyBash: spy.classifyBash })
    )

    expect(spy.calls).toHaveLength(1)
    expect(result.outcome).toBe('deny')
    expect(result.verdict.via).toBe('mode')
    expect(result.verdict.reason).toBe('plan mode blocks writes')
  })

  it('layer 5 — plan mode still lets reads through', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'read', args: { path: 'notes.md' } },
      baseOptions({ mode: 'plan' })
    )

    expect(result.outcome).toBe('allow')
    expect(result.verdict.via).toBe('mode')
  })

  it('layer 5 — bypass mode converts ask to allow but never overrides deny', async () => {
    const asked = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'rm old.txt' } },
      baseOptions({ mode: 'bypass' })
    )
    expect(asked.outcome).toBe('allow')
    expect(asked.verdict.via).toBe('mode')

    const denied = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'rm old.txt' } },
      baseOptions({
        mode: 'bypass',
        rules: [{ id: 'no-rm', command: 'rm ', action: 'deny' }]
      })
    )
    expect(denied.outcome).toBe('deny')
    expect(denied.verdict.via).toBe('rule')
  })
})

describe('mode rails are the final reduction — nothing short-circuits them', () => {
  it('plan mode denies a write even when session memory allowed this exact call', async () => {
    const memory = new PermissionMemory('plan-memory')
    const args = { path: join(workspace, 'notes.md'), content: 'draft' }
    memory.record('write', PermissionMemory.fingerprintArgs(args))

    const result = await new PermissionGate().evaluate(
      { toolName: 'write', args },
      baseOptions({ mode: 'plan', memory })
    )

    expect(result.outcome).toBe('deny')
    expect(result.verdict.via).toBe('mode')
    expect(result.verdict.reason).toBe('plan mode blocks writes')
  })

  it('plan mode denies an allow-rule match for a write', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'write', args: { path: join(workspace, 'notes.md'), content: 'x' } },
      baseOptions({
        mode: 'plan',
        rules: [{ id: 'allow-writes', tool: 'write', action: 'allow' }]
      })
    )

    expect(result.outcome).toBe('deny')
    expect(result.verdict.via).toBe('mode')
  })

  it('acceptEdits honours an explicit session grant instead of revoking it', async () => {
    const memory = new PermissionMemory('accept-memory')
    const args = { command: 'python deploy.py --release' }
    memory.record('bash', PermissionMemory.fingerprintArgs(args))

    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args },
      baseOptions({ mode: 'acceptEdits', memory })
    )

    expect(result.outcome).toBe('allow')
    expect(result.verdict.via).toBe('user')
  })

  it('acceptEdits does not auto-allow an ungranted shell command', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'bash', args: { command: 'python deploy.py --release' } },
      baseOptions({ mode: 'acceptEdits' })
    )

    expect(result.outcome).not.toBe('allow')
  })

  it('a credential read stays a question in plan mode rather than becoming an allow', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'read', args: { path: join(process.env.HOME ?? '', '.ssh', 'id_rsa') } },
      baseOptions({ mode: 'plan' })
    )

    expect(result.outcome).toBe('ask')
  })
})

describe('MCP tool names are never read-only by shape', () => {
  it('an mcp read-named tool is not auto-allowed in plan mode', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'mcp__server__read_files', args: {} },
      baseOptions({ mode: 'plan' })
    )

    expect(result.outcome).toBe('deny')
    expect(result.verdict.reason).toBe('plan mode blocks writes')
  })

  it('an mcp read-named tool asks rather than inheriting the read heuristic', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'mcp__server__read_files', args: {} },
      baseOptions()
    )

    expect(result.outcome).toBe('ask')
    expect(result.verdict.reason).toContain('external server, not sandboxed')
  })

  it('the discovery carve-out still passes in plan mode — it never reaches a server', async () => {
    const result = await new PermissionGate().evaluate(
      { toolName: 'mcp', args: { mode: 'search' } },
      baseOptions({ mode: 'plan' })
    )

    expect(result.outcome).toBe('allow')
    expect(result.verdict.via).toBe('mode')
  })
})

describe('session memory is scoped to the exact call and the exact session', () => {
  it('reuses an allowance for identical parameters only', async () => {
    const memory = new PermissionMemory('scope-1')
    const gate = new PermissionGate()
    const allowed = { path: join(workspace, 'a.md'), content: 'x' }
    memory.record('write', PermissionMemory.fingerprintArgs(allowed))

    const same = await gate.evaluate(
      { toolName: 'write', args: allowed },
      baseOptions({ memory })
    )
    expect(same.outcome).toBe('allow')
    expect(same.verdict.via).toBe('user')

    const different = await gate.evaluate(
      { toolName: 'write', args: { path: join(workspace, 'b.md'), content: 'y' } },
      baseOptions({ memory })
    )
    expect(different.outcome).toBe('allow')
    expect(different.verdict.via).toBe('heuristic')
  })

  it('an allowance does not carry into another session', async () => {
    const args = { path: join(workspace, 'a.md'), content: 'x' }
    const first = new PermissionMemory('session-a')
    first.record('write', PermissionMemory.fingerprintArgs(args))

    const otherSession = await new PermissionGate().evaluate(
      { toolName: 'write', args },
      baseOptions({ memory: new PermissionMemory('session-b') })
    )

    expect(otherSession.verdict.via).not.toBe('user')
  })
})

describe('permissionRules — the source of the rules layer', () => {
  const flexDir = join(home, '.flexagent')
  const permissionsFile = join(flexDir, 'permissions.json')

  it('effectiveRuleSet puts user rules after every built-in', () => {
    mkdirSync(flexDir, { recursive: true })
    writeFileSync(
      permissionsFile,
      JSON.stringify({ rules: [{ id: 'user-allow', tool: 'bash', action: 'allow' }] }),
      'utf8'
    )

    const set = permissionRules.effectiveRuleSet()
    expect(set.sourcePath).toBe(permissionRules.PERMISSIONS_FILE)
    expect(set.rules).toHaveLength(permissionRules.BUILTIN_RULES.length + 1)
    const userIndex = set.rules.findIndex((rule: PermissionRule) => rule.id === 'user-allow')
    expect(userIndex).toBeGreaterThanOrEqual(permissionRules.BUILTIN_RULES.length)
  })

  it('a malformed rule file degrades to built-ins instead of throwing', () => {
    mkdirSync(flexDir, { recursive: true })
    writeFileSync(permissionsFile, '{ this is not json', 'utf8')

    expect(permissionRules.loadRuleSet().rules).toEqual([])
    expect(permissionRules.effectiveRuleSet().rules).toHaveLength(
      permissionRules.BUILTIN_RULES.length
    )
  })

  it('invalid rule entries are dropped and missing fields synthesised', () => {
    mkdirSync(flexDir, { recursive: true })
    writeFileSync(
      permissionsFile,
      JSON.stringify({ rules: [{ action: 'nope' }, 42, { tool: 'bash', action: 'deny' }] }),
      'utf8'
    )

    const rules = permissionRules.loadRuleSet().rules
    expect(rules).toHaveLength(1)
    expect(rules[0]!.id).toBe('legacy-rule-1')
    expect(rules[0]!.origin).toBe('user')
    expect(rules[0]!.createdAt).toBe(0)
  })

  it('a rule derived from a call records the command, not a blanket bash allow', async () => {
    const before = permissionRules.listUserRules().length
    const input = {
      tool: 'bash',
      args: { command: 'npm test' },
      scope: 'global' as const,
      action: 'allow' as const,
      cwd: workspace
    }

    await permissionRules.addUserRule(input)
    const rules = permissionRules.listUserRules()
    expect(rules).toHaveLength(before + 1)
    const derived = rules[rules.length - 1]!
    expect(derived.tool).toBe('bash')
    expect(derived.command).toBe('npm test')
    expect(derived.origin).toBe('user')

    await permissionRules.addUserRule(input)
    expect(permissionRules.listUserRules()).toHaveLength(before + 1)
  })
})
