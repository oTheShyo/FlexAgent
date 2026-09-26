import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteCustomAgent,
  isBuiltinName,
  listCustomAgents,
  loadAgentRegistry,
  parseCustomAgentDefinition,
  saveCustomAgent,
  setCustomAgentEnabled
} from '../src/main/agents/customAgents'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flexagent-agents-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

const VALID_DEF = `---
name: code-reviewer-x
description: "Reviews code for correctness and style"
tools: [read, grep, find, ls]
enabled: true
---

You review code carefully.
`

describe('parseCustomAgentDefinition', () => {
  it('parses a valid definition into a role', () => {
    const { role, diagnostics } = parseCustomAgentDefinition('x.md', VALID_DEF, {
      reservedNames: new Set()
    })
    expect(diagnostics).toEqual([])
    expect(role?.name).toBe('code-reviewer-x')
    expect(role?.description).toBe('Reviews code for correctness and style')
    expect(role?.tools).toEqual(['read', 'grep', 'find', 'ls'])
    expect(role?.persona).toContain('You review code carefully.')
  })

  it('ignores a file with no name and leaves a diagnostic', () => {
    const { role, diagnostics } = parseCustomAgentDefinition(
      'x.md',
      VALID_DEF.replace('name: code-reviewer-x\n', ''),
      { reservedNames: new Set() }
    )
    expect(role).toBeUndefined()
    expect(diagnostics.some((diag) => diag.code === 'missing_name')).toBe(true)
  })

  it('ignores a file with no description', () => {
    const { role, diagnostics } = parseCustomAgentDefinition(
      'x.md',
      VALID_DEF.replace('description: "Reviews code for correctness and style"\n', ''),
      { reservedNames: new Set() }
    )
    expect(role).toBeUndefined()
    expect(diagnostics.some((diag) => diag.code === 'missing_description')).toBe(true)
  })

  it('rejects a name colliding with a built-in', () => {
    const { role, diagnostics } = parseCustomAgentDefinition('x.md', VALID_DEF.replace('code-reviewer-x', 'researcher'), {
      reservedNames: new Set(['researcher'])
    })
    expect(role).toBeUndefined()
    expect(diagnostics.some((diag) => diag.code === 'name_conflict')).toBe(true)
  })

  it('rejects an MCP tool that is not explicitly declared by name', () => {
    const { diagnostics } = parseCustomAgentDefinition(
      'x.md',
      VALID_DEF.replace('tools: [read, grep, find, ls]', 'tools: [read, bash tool-without-decl]'),
      { reservedNames: new Set() }
    )
    expect(diagnostics.some((diag) => diag.code === 'invalid_tools')).toBe(true)
  })
})

describe('saveCustomAgent round-trip', () => {
  it('writes a definition file and lists it back', () => {
    const dir = freshDir()
    const { role } = saveCustomAgent(
      {
        name: 'test-writer-x',
        description: 'Writes tests',
        tools: ['read', 'bash'],
        enabled: true,
        persona: 'You write tests.'
      },
      dir
    )
    expect(role.name).toBe('test-writer-x')
    expect(existsSync(join(dir, 'test-writer-x.md'))).toBe(true)

    const { roles, diagnostics } = listCustomAgents(dir)
    expect(diagnostics).toEqual([])
    expect(roles.map((item) => item.name)).toContain('test-writer-x')
  })

  it('refuses to overwrite a built-in name', () => {
    const dir = freshDir()
    expect(() =>
      saveCustomAgent(
        {
          name: 'researcher',
          description: 'colliding',
          tools: ['read'],
          enabled: true,
          persona: 'x'
        },
        dir
      )
    ).toThrow(/cannot|reserved|built-in|already/i)
  })

  it('throws with the validation error on an invalid definition', () => {
    const dir = freshDir()
    expect(() =>
      saveCustomAgent({ name: 'bad-x', description: '', tools: ['read'], enabled: true, persona: 'p' }, dir)
    ).toThrow()
    expect(existsSync(join(dir, 'bad-x.md'))).toBe(false)
  })
})

describe('deleteCustomAgent', () => {
  it('deletes a custom definition', () => {
    const dir = freshDir()
    saveCustomAgent({ name: 'gone-x', description: 'd', tools: ['read'], enabled: true, persona: 'p' }, dir)
    deleteCustomAgent('gone-x', dir)
    expect(existsSync(join(dir, 'gone-x.md'))).toBe(false)
  })

  it('refuses to delete a built-in', () => {
    const dir = freshDir()
    expect(() => deleteCustomAgent('researcher', dir)).toThrow(/built-in/)
  })

  it('refuses to delete a missing definition', () => {
    const dir = freshDir()
    expect(() => deleteCustomAgent('nope-x', dir)).toThrow(/no subagent definition/)
  })
})

describe('setCustomAgentEnabled', () => {
  it('toggles enabled and survives a round-trip without stacking the contract', () => {
    const dir = freshDir()
    saveCustomAgent(
      { name: 'toggle-x', description: 'd', tools: ['read'], enabled: true, persona: 'You work.' },
      dir
    )
    const toggled = setCustomAgentEnabled('toggle-x', false, dir)
    expect(toggled.enabled).toBe(false)

    const raw = readFileSync(join(dir, 'toggle-x.md'), 'utf8')
    expect(raw).toContain('enabled: false')

    const { roles } = listCustomAgents(dir)
    const role = roles.find((item) => item.name === 'toggle-x')
    expect(role?.enabled).toBe(false)
    expect(role?.persona.match(/Rules:\n- Stay inside your role\./g)?.length).toBe(1)
  })

  it('refuses to modify a built-in', () => {
    const dir = freshDir()
    expect(() => setCustomAgentEnabled('researcher', false, dir)).toThrow(/built-in/)
  })
})

describe('loadAgentRegistry', () => {
  it('merges built-ins and enabled customs; disabled customs stay out of dispatch', () => {
    const dir = freshDir()
    saveCustomAgent(
      { name: 'on-x', description: 'enabled custom', tools: ['read'], enabled: true, persona: 'p' },
      dir
    )
    saveCustomAgent(
      { name: 'off-x', description: 'disabled custom', tools: ['read'], enabled: false, persona: 'p' },
      dir
    )
    const registry = loadAgentRegistry(dir)
    expect(registry.roles['researcher']).toBeDefined()
    expect(registry.roles['on-x']).toBeDefined()
    expect(registry.roles['off-x']).toBeUndefined()
    expect(registry.all.map((role) => role.name)).toContain('off-x')
    expect(isBuiltinName('researcher')).toBe(true)
    expect(isBuiltinName('on-x')).toBe(false)
  })
})
