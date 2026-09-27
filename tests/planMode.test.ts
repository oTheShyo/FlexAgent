import { describe, expect, it } from 'vitest'
import {
  PLAN_EXECUTION_MODE,
  approvePlan,
  buildPlanPrompt,
  buildRejectionPrompt,
  cancelPlan,
  createPlan,
  goalBlocksPlan,
  isPending,
  parsePlanSteps,
  rejectPlan
} from '../src/main/planMode'
import type { PlanState } from '../src/shared/contract'

const NOW = 1_700_000_000_000

function draft(text: string): PlanState {
  return createPlan('s1', text, NOW)
}

describe('parsePlanSteps', () => {
  it('reads an ordered list', () => {
    const steps = parsePlanSteps('1. Read the file\n2. Patch it\n3. Test')
    expect(steps.map((s) => s.text)).toEqual(['Read the file', 'Patch it', 'Test'])
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3])
  })

  it('reads bullets, dashes and checkboxes alike', () => {
    const steps = parsePlanSteps('- one\n* two\n- [ ] three\n+ four')
    expect(steps.map((s) => s.text)).toEqual(['one', 'two', 'three', 'four'])
  })

  it('reads markdown headings as steps', () => {
    expect(parsePlanSteps('## Step one\n### Step two').map((s) => s.text)).toEqual([
      'Step one',
      'Step two'
    ])
  })

  it('skips fenced code — a pasted diff is not a checklist', () => {
    const text = ['1. Patch it', '```', '- not a step', '2. not a step either', '```', '2. Test'].join(
      '\n'
    )
    expect(parsePlanSteps(text).map((s) => s.text)).toEqual(['Patch it', 'Test'])
  })

  it('returns nothing for prose with no list structure', () => {
    expect(parsePlanSteps('I will look around and then decide.')).toEqual([])
  })

  it('caps the step count so a dump cannot become a plan', () => {
    const text = Array.from({ length: 80 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n')
    expect(parsePlanSteps(text).length).toBe(50)
  })
})

describe('plan lifecycle', () => {
  it('starts as a draft with parsed steps', () => {
    const plan = draft('1. A\n2. B')
    expect(plan.status).toBe('draft')
    expect(plan.steps.length).toBe(2)
    expect(isPending(plan)).toBe(true)
  })

  it('approval leaves the draft state and keeps the steps', () => {
    const approved = approvePlan(draft('1. A\n2. B'), NOW + 1)
    expect(approved.status).toBe('approved')
    expect(approved.steps.length).toBe(2)
    expect(isPending(approved)).toBe(false)
  })

  it('rejection carries the feedback the agent must act on', () => {
    const rejected = rejectPlan(draft('1. A'), 'drop step 1', NOW + 1)
    expect(rejected.status).toBe('rejected')
    expect(rejected.note).toBe('drop step 1')
    expect(isPending(rejected)).toBe(false)
  })

  it('cancellation drops the note along with the pending state', () => {
    const cancelled = cancelPlan(rejectPlan(draft('1. A'), 'later', NOW), NOW + 2)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.note).toBeUndefined()
  })

  it('a missing plan is not pending', () => {
    expect(isPending(undefined)).toBe(false)
  })
})

describe('prompts handed back to the agent', () => {
  it('approval restates the plan verbatim', () => {
    const prompt = buildPlanPrompt(draft('1. Read it\n2. Patch it'))
    expect(prompt).toContain('approved')
    expect(prompt).toContain('1. Read it')
    expect(prompt).toContain('2. Patch it')
  })

  it('approval falls back to the raw text when there is no checklist', () => {
    const prompt = buildPlanPrompt(draft('Rewrite the parser, carefully.'))
    expect(prompt).toContain('Rewrite the parser, carefully.')
  })

  it('rejection passes the feedback and keeps the agent read-only', () => {
    const prompt = buildRejectionPrompt('use a migration instead')
    expect(prompt).toContain('use a migration instead')
    expect(prompt).toContain('do not write files')
  })

  it('approval trusts file writes but still judges commands', () => {
    expect(PLAN_EXECUTION_MODE).toBe('acceptEdits')
  })
})

describe('mutual exclusion with goal mode', () => {
  it('refuses to plan while a goal is running, and says what to do', () => {
    const message = goalBlocksPlan('make the tests pass')
    expect(message).not.toBeNull()
    expect(message).toContain('/goal pause')
    expect(message).toContain('make the tests pass')
  })

  it('does not block planning when there is no goal', () => {
    expect(goalBlocksPlan(undefined)).toBeNull()
    expect(goalBlocksPlan('   ')).toBeNull()
  })
})
