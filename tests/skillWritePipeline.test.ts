import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { useHermeticHome } from './helpers/hermeticHome'

const { home, cleanup } = useHermeticHome('flexagent-skills-')

const skillManage = await import('../src/main/skills/skillManage')

afterAll(cleanup)

const { SKILLS_HOME, SETTINGS_FILE } = skillManage
const workspace = join(home, 'workspace')
mkdirSync(workspace, { recursive: true })

const SKILL_MD = [
  '---',
  'name: ${name}',
  'description: characterization fixture',
  '---',
  '',
  '# ${name}',
  '',
  'Procedure: run the thing.',
  ''
].join('\n')

function skillDoc(name: string): string {
  return SKILL_MD.replaceAll('${name}', name)
}

function skillFile(name: string): string {
  return join(SKILLS_HOME, name, 'SKILL.md')
}

function setWriteApproval(enabled: boolean): void {
  mkdirSync(join(home, '.flexagent'), { recursive: true })
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({ skills: { writeApproval: enabled } }),
    'utf8'
  )
}

let alphaUndoId: string
let betaPendingId: string

describe('skill write pipeline — stage, approve, reject, revert', () => {
  it('approval off — a batch applies immediately and records an undo entry', () => {
    setWriteApproval(false)

    const outcome = skillManage.runSkillManage(
      [{ action: 'create', name: 'alpha', content: skillDoc('alpha') }],
      { stateReady: () => true }
    )

    expect(outcome.applied).toHaveLength(1)
    expect(outcome.applied[0]!.action).toBe('create')
    expect(outcome.applied[0]!.skill).toBe('alpha')
    expect(existsSync(skillFile('alpha'))).toBe(true)
    expect(outcome.undoId).toBeDefined()
    alphaUndoId = outcome.undoId!
    expect(skillManage.listSkillUndo().some((entry) => entry.id === alphaUndoId)).toBe(true)
  })

  it('approval on — a batch is staged, not applied, until approved', () => {
    setWriteApproval(true)

    const outcome = skillManage.runSkillManage(
      [{ action: 'create', name: 'beta', content: skillDoc('beta') }],
      { stateReady: () => true }
    )

    expect(outcome.applied[0]!.message).toContain('staged for approval')
    expect(existsSync(skillFile('beta'))).toBe(false)

    const pending = skillManage.listPendingSkillWrites()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.skillName).toBe('beta')
    betaPendingId = pending[0]!.id
  })

  it('approve — the staged batch lands on disk, pending cleared, undo recorded', () => {
    const outcome = skillManage.approveSkillWrite(betaPendingId)

    expect(outcome.applied).toHaveLength(1)
    expect(existsSync(skillFile('beta'))).toBe(true)
    expect(skillManage.listPendingSkillWrites()).toHaveLength(0)
    expect(outcome.undoId).toBeDefined()
    expect(skillManage.listSkillUndo().some((entry) => entry.id === outcome.undoId)).toBe(true)
  })

  it('reject — the staged batch is discarded without touching the skills home', () => {
    setWriteApproval(true)

    const staged = skillManage.runSkillManage(
      [{ action: 'create', name: 'gamma', content: skillDoc('gamma') }],
      { stateReady: () => true }
    )
    expect(staged.applied[0]!.message).toContain('staged for approval')

    const pending = skillManage.listPendingSkillWrites()
    expect(pending).toHaveLength(1)

    skillManage.rejectSkillWrite(pending[0]!.id)

    expect(skillManage.listPendingSkillWrites()).toHaveLength(0)
    expect(existsSync(skillFile('gamma'))).toBe(false)
    setWriteApproval(false)
  })

  it('revert — undoing an approved create removes the files it added', () => {
    expect(existsSync(skillFile('alpha'))).toBe(true)

    const result = skillManage.revertSkillWrite(alphaUndoId)

    expect(existsSync(skillFile('alpha'))).toBe(false)
    expect(result.reverted).toContain(skillFile('alpha'))
    expect(result.skipped).toEqual([])
  })

  it('revert — undoing a patch restores the previous content', () => {
    skillManage.runSkillManage(
      [{ action: 'create', name: 'delta', content: skillDoc('delta') }],
      { stateReady: () => true }
    )
    const patched = skillManage.runSkillManage(
      [
        {
          action: 'patch',
          name: 'delta',
          oldString: 'Procedure: run the thing.',
          newString: 'Procedure: run the other thing.'
        }
      ],
      { stateReady: () => true }
    )
    expect(readFileSync(skillFile('delta'), 'utf8')).toContain('run the other thing')
    expect(patched.undoId).toBeDefined()

    const result = skillManage.revertSkillWrite(patched.undoId!)

    expect(readFileSync(skillFile('delta'), 'utf8')).toContain('run the thing.')
    expect(result.reverted).toEqual([skillFile('delta')])
  })

  it('the state gate refuses mutations until the inventory has been read', () => {
    expect(() =>
      skillManage.runSkillManage(
        [{ action: 'create', name: 'delta-two', content: skillDoc('delta-two') }],
        { stateReady: () => false }
      )
    ).toThrow(/read the current state first/)
    expect(existsSync(skillFile('delta-two'))).toBe(false)
  })
})

interface CapturedTool {
  name: string
  execute: (
    toolCallId: string,
    rawParams: unknown
  ) => Promise<{ content: Array<{ type: string; text: string }> }>
}

async function runTool(tool: CapturedTool, params: unknown): Promise<string> {
  const result = await tool.execute('call-1', params)
  return result.content.map((item) => item.text).join('\n')
}

describe('skill_manage tool — the state gate as the model meets it', () => {
  it('refuses writes before action=list, then allows them', async () => {
    setWriteApproval(false)
    const seedDir = join(SKILLS_HOME, 'seed-skill')
    mkdirSync(seedDir, { recursive: true })
    writeFileSync(join(seedDir, 'SKILL.md'), skillDoc('seed-skill'), 'utf8')

    const selfEvolution = await import('../src/main/skills/selfEvolution')
    const tools = new Map<string, CapturedTool>()
    const fakePi = {
      registerTool: (tool: CapturedTool): void => {
        tools.set(tool.name, tool)
      },
      on: (): void => undefined
    }
    const extension = selfEvolution.createSelfEvolutionExtension({ cwd: workspace })
    const factory = typeof extension === 'function' ? extension : extension.factory
    factory(fakePi as unknown as ExtensionAPI)

    const skillManageTool = tools.get('skill_manage')
    expect(skillManageTool).toBeDefined()

    const refused = await runTool(skillManageTool!, { action: 'create', name: 'epsilon', content: skillDoc('epsilon') })
    expect(refused).toContain('read the current state first')
    expect(existsSync(skillFile('epsilon'))).toBe(false)

    const listed = await runTool(skillManageTool!, { action: 'list' })
    expect(listed).toContain('seed-skill')

    const created = await runTool(skillManageTool!, {
      action: 'create',
      name: 'epsilon',
      content: skillDoc('epsilon')
    })
    expect(created).toContain('create epsilon')
    expect(existsSync(skillFile('epsilon'))).toBe(true)
  })
})
