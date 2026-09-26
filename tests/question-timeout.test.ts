import { describe, expect, it } from 'vitest'
import {
  formatRemaining,
  isExpired,
  remainingMs,
  startQuestionTimer,
  stopQuestionTimer
} from '../src/main/questionTimeout'

const T0 = 1_700_000_000_000
const FIVE_MIN = 5 * 60 * 1000

describe('question countdown', () => {
  it('counts down from the full timeout', () => {
    const timer = startQuestionTimer(FIVE_MIN, T0)
    expect(remainingMs(timer, T0)).toBe(FIVE_MIN)
    expect(remainingMs(timer, T0 + 1_000)).toBe(FIVE_MIN - 1_000)
  })

  it('expires at the deadline and stays expired', () => {
    const timer = startQuestionTimer(FIVE_MIN, T0)
    expect(isExpired(timer, T0 + FIVE_MIN - 1)).toBe(false)
    expect(isExpired(timer, T0 + FIVE_MIN)).toBe(true)
    expect(isExpired(timer, T0 + FIVE_MIN * 10)).toBe(true)
    expect(remainingMs(timer, T0 + FIVE_MIN)).toBe(0)
  })

  it('stopping is permanent — the clock never restarts', () => {
    const stopped = stopQuestionTimer(startQuestionTimer(FIVE_MIN, T0))
    expect(remainingMs(stopped, T0 + 1_000)).toBe(0)
    // Long past the deadline: still not expired, and still no countdown.
    expect(isExpired(stopped, T0 + FIVE_MIN * 10)).toBe(false)
    expect(remainingMs(stopped, T0 + FIVE_MIN * 10)).toBe(0)
    // Stopping twice changes nothing.
    expect(stopQuestionTimer(stopped)).toBe(stopped)
  })

  it('a disabled countdown waits indefinitely', () => {
    const timer = startQuestionTimer(0, T0)
    expect(remainingMs(timer, T0 + FIVE_MIN * 100)).toBe(0)
    expect(isExpired(timer, T0 + FIVE_MIN * 100)).toBe(false)
  })

  it('formats as m:ss', () => {
    expect(formatRemaining(FIVE_MIN)).toBe('5:00')
    expect(formatRemaining(61_000)).toBe('1:01')
    expect(formatRemaining(0)).toBe('0:00')
    expect(formatRemaining(-500)).toBe('0:00')
  })
})
