import { describe, expect, it } from 'vitest'
import type { ThinkingLevel } from '../src/shared/contract'
import {
  EFFORT_NO_MODEL_REASON,
  EFFORT_UNSUPPORTED_REASON,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  effortForLevel,
  hasReasoningSupport,
  normalizeThinkingLevels,
  resolveEffortTiers
} from '../src/shared/reasoningEffort'

const FULL: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const CAP_HIGH: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']
const OFF_ONLY: ThinkingLevel[] = ['off']

function tier(levels: readonly ThinkingLevel[] | null | undefined, effort: 'low' | 'high' | 'max') {
  const found = resolveEffortTiers(levels).find((option) => option.effort === effort)
  if (found === undefined) throw new Error(`no tier ${effort}`)
  return found
}

describe('resolveEffortTiers', () => {
  it('returns the three tiers in display order 低 → 高 → 最高', () => {
    expect(resolveEffortTiers(FULL).map((option) => option.effort)).toEqual(REASONING_EFFORTS)
  })

  it('maps the full ladder onto three distinct wire levels', () => {
    expect(tier(FULL, 'low').level).toBe('low')
    expect(tier(FULL, 'high').level).toBe('high')
    expect(tier(FULL, 'max').level).toBe('max')
    const sent = resolveEffortTiers(FULL).map((option) => option.level)
    expect(new Set(sent).size).toBe(3)
  })

  it('maps a model that tops out at high to low/medium/high — three distinct levels', () => {
    expect(tier(CAP_HIGH, 'low').level).toBe('low')
    expect(tier(CAP_HIGH, 'high').level).toBe('medium')
    expect(tier(CAP_HIGH, 'max').level).toBe('high')
    const sent = resolveEffortTiers(CAP_HIGH).map((option) => option.level)
    expect(new Set(sent).size).toBe(3)
  })

  it('never resolves a level the model did not declare', () => {
    const cases: readonly (readonly ThinkingLevel[])[] = [
      FULL,
      CAP_HIGH,
      ['off', 'minimal'],
      ['off', 'medium', 'high']
    ]
    for (const levels of cases) {
      for (const option of resolveEffortTiers(levels)) {
        if (option.available) expect(levels).toContain(option.level)
      }
    }
  })

  it('disables every tier with one reason when the model declares no reasoning', () => {
    for (const option of resolveEffortTiers(OFF_ONLY)) {
      expect(option.available).toBe(false)
      expect(option.level).toBeNull()
      expect(option.reason).toBe(EFFORT_UNSUPPORTED_REASON)
    }
    expect(hasReasoningSupport(OFF_ONLY)).toBe(false)
  })

  it('treats missing levels (no model selected yet) as no reasoning support', () => {
    expect(resolveEffortTiers(null)).toEqual(resolveEffortTiers(undefined))
    expect(resolveEffortTiers([])).toEqual(resolveEffortTiers(OFF_ONLY))
    expect(hasReasoningSupport(null)).toBe(false)
    expect(hasReasoningSupport(FULL)).toBe(true)
  })

  it('disables 高 with a reason when nothing sits between the weakest and strongest level', () => {
    const single = resolveEffortTiers(['off', 'minimal'])
    expect(single.find((option) => option.effort === 'low')?.level).toBe('minimal')
    expect(single.find((option) => option.effort === 'max')?.level).toBe('minimal')
    const high = single.find((option) => option.effort === 'high')
    expect(high?.available).toBe(false)
    expect(high?.level).toBeNull()
    expect(high?.reason).toContain('高 (High)')

    const two = resolveEffortTiers(['off', 'medium', 'high'])
    expect(two.find((option) => option.effort === 'low')?.level).toBe('medium')
    expect(two.find((option) => option.effort === 'max')?.level).toBe('high')
    expect(two.find((option) => option.effort === 'high')?.available).toBe(false)
  })

  it('keeps 低 and 最高 available even on a one-rung ladder', () => {
    const options = resolveEffortTiers(['off', 'minimal'])
    expect(options.filter((option) => option.available).map((option) => option.effort)).toEqual([
      'low',
      'max'
    ])
  })

  it('ignores level names PI does not define', () => {
    const bogus = ['off', 'ultra'] as unknown as ThinkingLevel[]
    expect(hasReasoningSupport(bogus)).toBe(false)
    expect(normalizeThinkingLevels(['off', 'minimal', 'off'] as ThinkingLevel[])).toEqual([
      'off',
      'minimal'
    ])
    expect(normalizeThinkingLevels(FULL)).toEqual(FULL)
  })
})

describe('effortForLevel', () => {
  it('reports the tier whose resolved level matches exactly', () => {
    expect(effortForLevel('low', CAP_HIGH)).toBe('low')
    expect(effortForLevel('medium', CAP_HIGH)).toBe('high')
    expect(effortForLevel('high', CAP_HIGH)).toBe('max')
    expect(effortForLevel('high', FULL)).toBe('high')
    expect(effortForLevel('max', FULL)).toBe('max')
  })

  it('reports no tier for off, missing or unsupported levels', () => {
    expect(effortForLevel('off', FULL)).toBeNull()
    expect(effortForLevel(undefined, FULL)).toBeNull()
    expect(effortForLevel(null, FULL)).toBeNull()
    expect(effortForLevel('high', OFF_ONLY)).toBeNull()
    expect(effortForLevel('xhigh', CAP_HIGH)).toBeNull()
  })
})

describe('tier labels', () => {
  it('uses the names the ticket specifies', () => {
    expect(REASONING_EFFORT_LABELS).toEqual({ low: '低', high: '高', max: '最高' })
  })

  it('exposes both user-facing disable reasons', () => {
    expect(EFFORT_NO_MODEL_REASON.length).toBeGreaterThan(0)
    expect(EFFORT_UNSUPPORTED_REASON).toContain('no reasoning parameter')
  })
})
