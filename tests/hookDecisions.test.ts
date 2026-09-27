import { describe, expect, it } from 'vitest'
import {
  MAX_STOP_BLOCKS,
  aggregatePermissionDecisions,
  hookAllowIsOverridable,
  nextStopBlocks,
  parseHookDecision
} from '../src/main/hookDecisions'

describe('parseHookDecision', () => {
  it('reads the documented nested shape', () => {
    expect(
      parseHookDecision({
        hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'in scratch' }
      })
    ).toEqual({ decision: 'allow', reason: 'in scratch' })
  })

  it('reads flattened aliases a hook author is likely to reach for', () => {
    expect(parseHookDecision({ permissionDecision: 'deny' })).toEqual({ decision: 'deny' })
    expect(parseHookDecision({ decision: 'block' }).decision).toBe('deny')
  })

  it('treats unknown vocabulary as no vote, not as permission', () => {
    expect(parseHookDecision({ decision: 'maybe' }).decision).toBeUndefined()
    expect(parseHookDecision('not json').decision).toBeUndefined()
    expect(parseHookDecision(undefined).decision).toBeUndefined()
  })

  it('keeps the reason even when the vote is unreadable', () => {
    expect(parseHookDecision({ decision: 'huh', reason: 'because' })).toEqual({ reason: 'because' })
  })
})

describe('aggregatePermissionDecisions', () => {
  it('deny beats everything', () => {
    expect(aggregatePermissionDecisions(['allow', 'ask', 'deny'])).toBe('deny')
    expect(aggregatePermissionDecisions(['deny', 'allow'])).toBe('deny')
  })

  it('ask beats allow', () => {
    expect(aggregatePermissionDecisions(['allow', 'ask'])).toBe('ask')
  })

  it('allow stands when nothing objected', () => {
    expect(aggregatePermissionDecisions(['allow', 'allow'])).toBe('allow')
  })

  it('no votes means the chain decides as it always did', () => {
    expect(aggregatePermissionDecisions([undefined, undefined])).toBeUndefined()
    expect(aggregatePermissionDecisions([])).toBeUndefined()
  })
})

describe('hookAllowIsOverridable', () => {
  it('lets an ordinary command through', () => {
    expect(hookAllowIsOverridable({ command: 'npm test' }).ok).toBe(true)
  })

  it('refuses to let a hook allow a hard-denied command shape', () => {
    const guard = hookAllowIsOverridable({ command: 'rm -rf dist' })
    expect(guard.ok).toBe(false)
    if (!guard.ok) expect(guard.reason).toContain('recursive force delete')
  })

  it('refuses to let a hook allow a credential path', () => {
    const guard = hookAllowIsOverridable({ file_path: '/home/dev/.ssh/id_rsa' })
    expect(guard.ok).toBe(false)
    if (!guard.ok) expect(guard.reason).toContain('credential location')
  })

  it('refuses a credential path reached through a command', () => {
    const guard = hookAllowIsOverridable({ command: 'cat ~/.ssh/id_ed25519' })
    expect(guard.ok).toBe(false)
    if (!guard.ok) expect(guard.reason).toContain('credential location')
  })
})

describe('nextStopBlocks', () => {
  it('continues below the ceiling', () => {
    expect(nextStopBlocks(0)).toEqual({ count: 1, continuable: true, forced: false })
    expect(nextStopBlocks(1)).toEqual({ count: 2, continuable: true, forced: false })
  })

  it('forces the turn to end at the ceiling', () => {
    expect(nextStopBlocks(MAX_STOP_BLOCKS - 1)).toEqual({
      count: MAX_STOP_BLOCKS,
      continuable: false,
      forced: true
    })
  })

  it('the ceiling is three — a hook cannot loop the model forever', () => {
    expect(MAX_STOP_BLOCKS).toBe(3)
  })
})
