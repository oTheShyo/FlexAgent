/**
 * Countdown for an agent-asked question (issue 10).
 *
 * Pure state plus two queries — no timers, no clock, no Electron. The real
 * timer lives in the worker; what needs testing is the policy, and the policy
 * is where the bugs would be:
 *
 *  - stopping is permanent (hovering the panel must not start the clock again);
 *  - a disabled countdown never expires, however long the wait;
 *  - expiry is a moment, not a duration — one `now` past the deadline, forever.
 */

export interface QuestionTimer {
  /** 0 or less means "no countdown": the question waits indefinitely. */
  timeoutMs: number
  startedAt: number
  /**
   * Any interaction with the question stops the clock for good. Not
   * resumable: a countdown the user can accidentally restart is a countdown
   * that can answer for them.
   */
  stopped: boolean
}

export function startQuestionTimer(timeoutMs: number, now: number): QuestionTimer {
  return { timeoutMs: timeoutMs > 0 ? timeoutMs : 0, startedAt: now, stopped: false }
}

/** Stopping is idempotent and irreversible. */
export function stopQuestionTimer(timer: QuestionTimer): QuestionTimer {
  if (timer.stopped) return timer
  return { ...timer, stopped: true }
}

/** Milliseconds left; 0 once stopped, expired, or disabled. */
export function remainingMs(timer: QuestionTimer, now: number): number {
  if (timer.stopped || timer.timeoutMs <= 0) return 0
  return Math.max(0, timer.startedAt + timer.timeoutMs - now)
}

/**
 * Whether the question should now continue without an answer. Disabled counts
 * as "never": with auto-continue off, an unanswered question waits forever.
 */
export function isExpired(timer: QuestionTimer, now: number): boolean {
  if (timer.stopped || timer.timeoutMs <= 0) return false
  return now >= timer.startedAt + timer.timeoutMs
}

/** `m:ss`, the form the panel shows. */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
