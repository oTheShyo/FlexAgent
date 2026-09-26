/**
 * Goal card state (issue 06) — pure presentation policy.
 *
 * What needs testing is the mapping, not the DOM:
 *  - natural-language adjustments map to replace/pause/clear;
 *  - todo items stay in the round they first appeared in, even when a later
 *    round completes them;
 *  - elapsed time renders the same way everywhere.
 */

import type { GoalIteration } from '../../../main/goalMode'

export type GoalAdjustment = 'replace' | 'pause' | 'clear' | 'resume' | 'none'

/**
 * Map a natural-language adjustment to a goal action. Deliberately narrow:
 * only unambiguous phrases map at all — "换个方向" replaces, "先停一下" pauses,
 * "不要了" clears, "继续" resumes. Anything else is `none` (the composer sends
 * it as a normal message).
 */
export function mapGoalAdjustment(text: string): { action: GoalAdjustment; newText?: string } {
  const t = text.trim()
  if (/(不要了|取消目标|清除目标|放弃这个目标|drop the goal|cancel the goal|clear the goal)/i.test(t)) {
    return { action: 'clear' }
  }
  if (/(先停|暂停|暂停一下|pause the goal|hold on|stop for now)/i.test(t)) {
    return { action: 'pause' }
  }
  if (/(继续|接着来|resume the goal|keep going|continue the goal)/i.test(t)) {
    return { action: 'resume' }
  }
  const replace = /^(换个方向|改成|换成|换目标|change the goal to|instead)[:：,，]?\s*(.+)$/i.exec(t)
  if (replace && replace[2].trim().length > 0) {
    return { action: 'replace', newText: replace[2].trim() }
  }
  return { action: 'none' }
}

/**
 * Group todo items by the round they first appeared in. A completed item
 * stays in the round that introduced it, however many rounds later the
 * completion landed — moving it would rewrite history.
 */
export interface TodoGroup {
  round: number
  items: { text: string; done: boolean }[]
}

export function groupTodosByRound(iterations: GoalIteration[]): TodoGroup[] {
  const groups = new Map<number, { text: string; done: boolean }[]>()
  const seen = new Map<string, number>()
  for (const it of iterations) {
    if (it.nextStep === undefined || it.nextStep.length === 0) continue
    const first = seen.get(it.nextStep)
    if (first !== undefined) {
      // Completed in a later round: mark done in the round it first appeared.
      const list = groups.get(first)
      if (list !== undefined) {
        const item = list.find((entry) => entry.text === it.nextStep)
        if (item !== undefined) item.done = true
      }
      continue
    }
    seen.set(it.nextStep, it.round)
    groups.set(it.round, [
      ...(groups.get(it.round) ?? []),
      { text: it.nextStep, done: false }
    ])
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, items]) => ({ round, items }))
}

/** `m:ss` elapsed, the form the card shows. */
export function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
