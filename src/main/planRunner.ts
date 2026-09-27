/**
 * Plan mode wiring (issue 07) — the worker side.
 *
 * The state machine lives in planMode.ts (pure, tested); this module owns what
 * only the worker can do: persist the plan per session, and turn the agent's
 * latest plan prose into a draft when a run settles.
 *
 * The *enforcement* is not here and must not be duplicated here: writes are
 * refused by `permissionGate` while the mode is `plan`, and every refusal goes
 * to the audit log. This file only tracks the paper trail around that.
 */
import { join } from 'path'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import type { PlanState } from '../shared/contract'
import { createPlan } from './planMode'
import { writeFileAtomically } from './marketplaceAtomic'

const PLANS_FILE = join(process.env.FLEXAGENT_HOME ?? defaultHome(), 'plans.json')

function defaultHome(): string {
  return join(homedir(), '.flexagent')
}

interface PlansShape {
  plans: Record<string, PlanState>
}

function readPlans(): Record<string, PlanState> {
  try {
    const raw = JSON.parse(readFileSync(PLANS_FILE, 'utf-8')) as PlansShape
    return raw.plans ?? {}
  } catch {
    return {}
  }
}

function writePlans(plans: Record<string, PlanState>): void {
  void writeFileAtomically(PLANS_FILE, JSON.stringify({ plans }, null, 2)).catch(() => {
    // Best-effort: an unwritable file must not take the turn down.
  })
}

export function readPlan(sessionId: string): PlanState | undefined {
  return readPlans()[sessionId]
}

export function setPlan(sessionId: string, plan: PlanState): PlanState {
  const plans = readPlans()
  plans[sessionId] = plan
  writePlans(plans)
  return plan
}

export function clearPlan(sessionId: string): void {
  const plans = readPlans()
  if (!(sessionId in plans)) return
  delete plans[sessionId]
  writePlans(plans)
}

/**
 * Turn the agent's latest message into the pending draft.
 *
 * Returns null when the message has no plan in it (empty, or nothing but
 * chatter): a plan card with no plan is worse than none. A previous draft is
 * replaced — the newest proposal is the one on the table.
 */
export function draftPlan(sessionId: string, text: string, now: number): PlanState | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  return setPlan(sessionId, createPlan(sessionId, text, now))
}

/**
 * Count a write the permission layer refused while a plan waited.
 *
 * This is the visible half of the audit trail: the JSONL proves it happened,
 * this makes the user see that plan mode blocked real attempts rather than
 * simply never being asked.
 */
export function recordBlockedWrite(sessionId: string): PlanState | undefined {
  const plan = readPlan(sessionId)
  if (plan === undefined || plan.status !== 'draft') return undefined
  return setPlan(sessionId, { ...plan, blockedWrites: (plan.blockedWrites ?? 0) + 1 })
}
