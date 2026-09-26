import { describe, expect, it } from 'vitest'
import {
  beginIteration,
  buildVerifyPrompt,
  canVerify,
  createGoal,
  parseGoalCommand,
  parseVerdict,
  pauseGoal,
  recordVerdict,
  resumeGoal
} from '../src/main/goalMode'

const T0 = 1_700_000_000_000

describe('parseGoalCommand', () => {
  it('parses the command family', () => {
    expect(parseGoalCommand('/goal')).toEqual({ action: 'show' })
    expect(parseGoalCommand('/goal pause')).toEqual({ action: 'pause' })
    expect(parseGoalCommand('/goal resume')).toEqual({ action: 'resume' })
    expect(parseGoalCommand('/goal clear')).toEqual({ action: 'clear' })
    expect(parseGoalCommand('/goal fix the wall detection')).toEqual({
      action: 'set',
      text: 'fix the wall detection'
    })
    expect(parseGoalCommand('/goal replace write the report')).toEqual({
      action: 'replace',
      text: 'write the report'
    })
  })

  it('is case-insensitive on the subcommand and rejects non-commands', () => {
    expect(parseGoalCommand('/GOAL PAUSE')).toEqual({ action: 'pause' })
    expect(parseGoalCommand('/goals')).toBeNull()
    expect(parseGoalCommand('fix the wall detection')).toBeNull()
    expect(parseGoalCommand('/goal replace')).toBeNull()
  })
})

describe('goal state machine', () => {
  it('verifies only while active and under the cap, one round at a time', () => {
    let goal = createGoal('fix it', T0, 2)
    expect(canVerify(goal, T0)).toBe(true)
    goal = beginIteration(goal, T0 + 1)
    // A round without a verdict is still in flight.
    expect(canVerify(goal, T0 + 2)).toBe(false)
    goal = recordVerdict(goal, 1, 'incomplete', true, 'run the tests', T0 + 3)
    expect(canVerify(goal, T0 + 4)).toBe(true)
    goal = beginIteration(goal, T0 + 5)
    goal = recordVerdict(goal, 2, 'incomplete', true, undefined, T0 + 6)
    // Cap reached: paused, not cleared.
    expect(goal.status).toBe('capped')
    expect(canVerify(goal, T0 + 7)).toBe(false)
  })

  it('resumes from pause and cap but not from reached', () => {
    let goal = createGoal('fix it', T0)
    goal = pauseGoal(goal, T0 + 1)
    expect(goal.status).toBe('paused')
    goal = resumeGoal(goal, T0 + 2)
    expect(goal.status).toBe('active')
    goal = recordVerdict(beginIteration(goal, T0 + 3), 1, 'complete', true, undefined, T0 + 4)
    expect(goal.status).toBe('reached')
    expect(resumeGoal(goal, T0 + 5)).toBe(goal)
  })

  it('a complete verdict without evidence does not reach the goal', () => {
    let goal = createGoal('fix it', T0)
    goal = beginIteration(goal, T0 + 1)
    goal = recordVerdict(goal, 1, 'complete', /* hasEvidence */ false, undefined, T0 + 2)
    expect(goal.status).toBe('active')
    expect(goal.iterations[0].verdict).toBe('complete')
  })
})

describe('verify prompt', () => {
  it('demands evidence and carries the proposed next step', () => {
    let goal = createGoal('fix the wall detection', T0, 20)
    goal = beginIteration(goal, T0 + 1)
    const prompt1 = buildVerifyPrompt(goal)
    expect(prompt1).toContain('fix the wall detection')
    expect(prompt1).toContain('NOT evidence of completion')
    expect(prompt1).toContain('Round 1')
    goal = recordVerdict(goal, 1, 'incomplete', true, 'run the C++ tests', T0 + 2)
    goal = beginIteration(goal, T0 + 3)
    const prompt2 = buildVerifyPrompt(goal)
    expect(prompt2).toContain('run the C++ tests')
    expect(prompt2).toContain('Round 2')
  })
})

describe('parseVerdict', () => {
  it('parses complete with justification', () => {
    const reply = 'VERDICT: COMPLETE\nThe wall positions match the MATLAB reference; tests pass.'
    expect(parseVerdict(reply)).toEqual({ verdict: 'complete', nextStep: undefined })
  })

  it('parses incomplete with a next step', () => {
    const reply = 'VERDICT: INCOMPLETE\nTwo tests still fail.\nNEXT: fix the 11px subimage parsing'
    const parsed = parseVerdict(reply)
    expect(parsed.verdict).toBe('incomplete')
    expect(parsed.nextStep).toBe('fix the 11px subimage parsing')
  })

  it('is case-insensitive and tolerant of prose first lines', () => {
    expect(parseVerdict('Sure — here is my assessment.\nverdict: incomplete\nnext: run tests').verdict).toBe(
      'incomplete'
    )
  })

  it('an unrecognized verdict is an error, not completion', () => {
    expect(parseVerdict('The goal looks done to me.')).toEqual({
      verdict: 'error',
      nextStep: undefined
    })
  })
})
