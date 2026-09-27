/**
 * Plan mode, the state machine (issue 07) — pure logic.
 *
 * Plan mode exists because "the model promised to be careful" is not a
 * guarantee. The guarantee already lives one layer down: `permissionGate`
 * refuses every non-read tool call while the mode is `plan`, and every refusal
 * lands in the append-only audit log. What was missing was the *lifecycle*
 * around that guarantee — the agent produces a plan, a human approves it, and
 * only then do writes unlock.
 *
 * This module holds the parts that need no I/O: parsing a plan out of free-form
 * assistant prose, the four-state lifecycle (draft → approved | rejected |
 * cancelled), and the prompts that carry a decision back to the agent. State
 * persistence and worker wiring live in `planRunner.ts`.
 *
 * Deliberately not attempted: making the agent emit machine-structured plans.
 * `session.prompt()` only takes a string, so a "plan" arrives as prose whether
 * we like it or not; parsing it is the honest fallback.
 */
import type { PermissionMode } from '../shared/contract'
import type { PlanState, PlanStep } from '../shared/contract'

/** Cap on parsed steps. A 400-line "plan" is a dump, not a plan. */
const MAX_STEPS = 50

/**
 * What plan mode hands control back to once a plan is approved.
 *
 * Not `bypass` — approval is consent for *this* plan, not a blanket pardon for
 * whatever the agent thinks of next. `acceptEdits` trusts file writes (which is
 * what a plan is made of) while still judging shell commands.
 */
export const PLAN_EXECUTION_MODE: PermissionMode = 'acceptEdits'

/**
 * Pull an ordered step list out of the agent's plan prose.
 *
 * Recognises `1.` / `1)` / `-` / `*` / `- [ ]` bullets and markdown headings.
 * Fenced code blocks are skipped: a plan that lists `npm test` as a step should
 * not also count every line of the diff it pastes as a step.
 *
 * Returns an empty list when the prose has no list structure at all — the UI
 * then shows the raw text rather than pretending prose is a checklist.
 */
export function parsePlanSteps(text: string): PlanStep[] {
  const steps: PlanStep[] = []
  let inFence = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const match = /^(?:#{1,6}\s+|\d+[.)]\s+|[-*+]\s+(?:\[[ xX]\]\s+)?)(.+)$/.exec(line)
    if (match === null) continue

    const body = (match[1] ?? '').trim()
    if (body.length === 0) continue
    steps.push({ index: steps.length + 1, text: body })
    if (steps.length >= MAX_STEPS) break
  }

  return steps
}

/** A new draft derived from the agent's latest plan message. */
export function createPlan(sessionId: string, text: string, now: number): PlanState {
  return {
    sessionId,
    text,
    steps: parsePlanSteps(text),
    status: 'draft',
    createdAt: now,
    updatedAt: now
  }
}

/** True while the plan is waiting on a human decision. */
export function isPending(plan: PlanState | undefined): boolean {
  return plan !== undefined && plan.status === 'draft'
}

export function approvePlan(plan: PlanState, now: number): PlanState {
  return { ...plan, status: 'approved', updatedAt: now, note: undefined }
}

export function rejectPlan(plan: PlanState, note: string, now: number): PlanState {
  return { ...plan, status: 'rejected', updatedAt: now, note }
}

export function cancelPlan(plan: PlanState, now: number): PlanState {
  return { ...plan, status: 'cancelled', updatedAt: now, note: undefined }
}

/**
 * The approved plan, handed to the agent as the next turn.
 *
 * It restates the plan verbatim rather than saying "go ahead": the agent's own
 * plan text is the most faithful spec available, and approval means "do this",
 * not "do whatever you were thinking".
 */
export function buildPlanPrompt(plan: PlanState): string {
  const body =
    plan.steps.length > 0
      ? plan.steps.map((step) => `${step.index}. ${step.text}`).join('\n')
      : plan.text.trim()

  return [
    'The plan was approved. Execute it now.',
    '',
    'Approved plan:',
    body,
    '',
    'Work through it in order. Report each step as you finish it, and stop at the end of the plan.'
  ].join('\n')
}

/** The user's change request, handed back to the agent for a revision. */
export function buildRejectionPrompt(note: string): string {
  return [
    'The plan was not approved. Revise it with this feedback and present the revised plan.',
    '',
    'Feedback:',
    note.trim(),
    '',
    'Stay in planning: do not write files or run commands yet.'
  ].join('\n')
}

/**
 * Mutual exclusion with goal mode (issue 07): planning and self-driving are
 * opposite postures — one waits for a human, the other stops waiting for one.
 * Returns null when there is no conflict.
 */
export function goalBlocksPlan(goalText: string | undefined): string | null {
  if (goalText === undefined || goalText.trim().length === 0) return null
  return (
    'This session is driving toward a goal: ' +
    `"${goalText.trim()}". ` +
    'Pause it first (/goal pause) — plan mode waits for your approval, which a running goal does not.'
  )
}
