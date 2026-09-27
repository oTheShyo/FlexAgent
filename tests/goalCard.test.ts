import { describe, expect, it } from 'vitest'
import {
  formatElapsed,
  goalRoundLabel,
  goalRoundMarkers,
  goalRoundPlacements,
  groupTodosByRound,
  mapGoalAdjustment
} from '../src/renderer/src/lib/goalCard'
import type { GoalIteration } from '../src/main/goalMode'
import type { GoalStateSummary } from '../src/shared/contract'

function goalOf(iterations: GoalIteration[], status: GoalStateSummary['status'] = 'active'): GoalStateSummary {
  return { text: 'ship it', status, iterations, maxRounds: 20, updatedAt: 1 }
}

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

describe('goalRoundMarkers', () => {
  it('opens a divider for every round a goal reports', () => {
    const goal = goalOf([
      { round: 1, startedAt: 1, verdict: 'incomplete', nextStep: 'write tests' },
      { round: 2, startedAt: 2 }
    ])
    expect(goalRoundMarkers(goal)).toEqual([
      { kind: 'goal-round', round: 1, phase: 'continue' },
      { kind: 'goal-round', round: 2, phase: 'continue' }
    ])
  })

  it('closes the round whose verdict completed', () => {
    const goal = goalOf(
      [
        { round: 1, startedAt: 1, verdict: 'complete' },
        { round: 2, startedAt: 2, verdict: 'incomplete' },
        { round: 3, startedAt: 3, verdict: 'complete' }
      ],
      'reached'
    )
    expect(goalRoundMarkers(goal)).toEqual([
      { kind: 'goal-round', round: 1, phase: 'continue' },
      { kind: 'goal-round', round: 1, phase: 'done' },
      { kind: 'goal-round', round: 2, phase: 'continue' },
      { kind: 'goal-round', round: 3, phase: 'continue' },
      { kind: 'goal-round', round: 3, phase: 'done' }
    ])
  })

  it('has nothing to show for an absent or fresh goal', () => {
    expect(goalRoundMarkers(null)).toEqual([])
    expect(goalRoundMarkers(undefined)).toEqual([])
    expect(goalRoundMarkers(goalOf([]))).toEqual([])
  })

  it('derives identical markers when state is re-reported (dedupe is the caller filter)', () => {
    const goal = goalOf([
      { round: 1, startedAt: 1, verdict: 'incomplete' },
      { round: 2, startedAt: 2 }
    ])
    expect(goalRoundMarkers(goal)).toEqual(goalRoundMarkers(goal))
  })
})

describe('goalRoundLabel', () => {
  it('labels the round and its phase', () => {
    expect(goalRoundLabel(3, 'continue')).toBe('第 3 次迭代 · 继续')
    expect(goalRoundLabel(1, 'done')).toBe('第 1 次迭代 · 完成')
  })
})

describe('goalRoundPlacements', () => {
  it('anchors each continue to its round start and the done marker to the end', () => {
    const goal = goalOf(
      [
        { round: 1, startedAt: 100, verdict: 'incomplete' },
        { round: 2, startedAt: 200, verdict: 'complete' }
      ],
      'reached'
    )
    expect(goalRoundPlacements(goal)).toEqual({
      continues: [
        { round: 1, startedAt: 100, beforeCreatedAt: 100 },
        { round: 2, startedAt: 200, beforeCreatedAt: 200 }
      ],
      doneRound: 2
    })
  })

  it('has no done marker while the goal is unfinished or absent', () => {
    expect(goalRoundPlacements(goalOf([{ round: 1, startedAt: 1 }]))).toEqual({
      continues: [{ round: 1, startedAt: 1, beforeCreatedAt: 1 }],
      doneRound: null
    })
    expect(goalRoundPlacements(null)).toEqual({ continues: [], doneRound: null })
  })
})
