import { describe, expect, it } from 'vitest'
import { formatElapsed, groupTodosByRound, mapGoalAdjustment } from '../src/renderer/src/lib/goalCard'
import type { GoalIteration } from '../src/main/goalMode'

describe('mapGoalAdjustment', () => {
  it('maps unambiguous phrases to actions', () => {
    expect(mapGoalAdjustment('这个目标不要了')).toEqual({ action: 'clear' })
    expect(mapGoalAdjustment('先停一下')).toEqual({ action: 'pause' })
    expect(mapGoalAdjustment('继续')).toEqual({ action: 'resume' })
    expect(mapGoalAdjustment('换个方向：改用高斯拟合')).toEqual({
      action: 'replace',
      newText: '改用高斯拟合'
    })
    expect(mapGoalAdjustment('change the goal to: write the report')).toEqual({
      action: 'replace',
      newText: 'write the report'
    })
  })

  it('leaves everything else alone', () => {
    expect(mapGoalAdjustment('fix the wall detection')).toEqual({ action: 'none' })
    expect(mapGoalAdjustment('看看测试结果')).toEqual({ action: 'none' })
  })
})

describe('groupTodosByRound', () => {
  it('keeps items in the round they first appeared, even when a later round completes them', () => {
    const iterations: GoalIteration[] = [
      { round: 1, startedAt: 1, verdict: 'incomplete', nextStep: 'fix the parser' },
      { round: 2, startedAt: 2, verdict: 'incomplete', nextStep: 'fix the parser' },
      { round: 3, startedAt: 3, verdict: 'incomplete', nextStep: 'run the tests' }
    ]
    const groups = groupTodosByRound(iterations)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ round: 1, items: [{ text: 'fix the parser', done: true }] })
    expect(groups[1]).toEqual({ round: 3, items: [{ text: 'run the tests', done: false }] })
  })

  it('ignores rounds without a next step', () => {
    const iterations: GoalIteration[] = [
      { round: 1, startedAt: 1, verdict: 'complete' },
      { round: 2, startedAt: 2, verdict: 'incomplete', nextStep: 'one more pass' }
    ]
    expect(groupTodosByRound(iterations)).toEqual([
      { round: 2, items: [{ text: 'one more pass', done: false }] }
    ])
  })
})

describe('formatElapsed', () => {
  it('renders m:ss', () => {
    expect(formatElapsed(1000, 1000 + 65_000)).toBe('1:05')
    expect(formatElapsed(1000, 1000)).toBe('0:00')
  })
})
