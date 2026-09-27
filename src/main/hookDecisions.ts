/**
 * Hook decisions the permission chain has to respect (issue 14) — pure logic.
 *
 * Two events gained teeth here, and each needed the judgement separated from
 * the plumbing so it can be tested without spawning processes:
 *
 *  - **Stop** — the agent is about to end its turn. A hook can send it back
 *    with a reason ("no test command and no result yet"), but a hook that
 *    blocks forever is a hang with extra steps, so the loop is capped.
 *  - **PermissionRequest** — fires only where the chain would have asked the
 *    human, and can answer on their behalf. Its answer is *advisory*: it can
 *    refuse, it can allow, but it can never widen a boundary the chain treats
 *    as a capability limit.
 *
 * The asymmetry is deliberate and is the whole point: a hook is third-party
 * code running with the user's privileges, so it may tighten decisions but not
 * loosen the ones that exist to protect them.
 */
import { commandForArgs, hardDenyFor, pathsForArgs } from './permissionGate'
import { commandTouchesSensitivePath, firstSensitivePath } from './security/sensitivePaths'

/**
 * Consecutive Stop blocks tolerated before the turn ends anyway.
 *
 * Three, not thirty: the block reasons are fed back to the model, so a hook
 * that keeps asking for the same impossible thing would otherwise loop until
 * the context window does it for us.
 */
export const MAX_STOP_BLOCKS = 3

export type HookPermissionVote = 'allow' | 'deny' | 'ask'

/**
 * Read a vote out of a hook's JSON output.
 *
 * Accepts the documented `hookSpecificOutput.permissionDecision` shape and the
 * flattened `permissionDecision` / `decision` aliases, because a hook author
 * who writes `{"decision":"block"}` meant a refusal and should not be silently
 * ignored. Anything unrecognised is *no vote*, not an allow: an unreadable
 * opinion must never widen permission.
 */
export function parseHookDecision(output: unknown): {
  decision?: HookPermissionVote
  reason?: string
} {
  if (output === null || typeof output !== 'object') return {}
  const root = output as Record<string, unknown>
  const specific = root.hookSpecificOutput
  const nested =
    specific !== null && typeof specific === 'object'
      ? (specific as Record<string, unknown>)
      : undefined

  const raw = firstString(
    nested?.permissionDecision,
    root.permissionDecision,
    root.decision,
    nested?.decision
  )
  const reason = firstString(
    nested?.permissionDecisionReason,
    root.permissionDecisionReason,
    root.reason,
    root.stopReason
  )
  if (raw === undefined) return reason === undefined ? {} : { reason }

  switch (raw.toLowerCase()) {
    case 'allow':
    case 'approve':
      return reason === undefined ? { decision: 'allow' } : { decision: 'allow', reason }
    case 'deny':
    case 'block':
      return reason === undefined ? { decision: 'deny' } : { decision: 'deny', reason }
    case 'ask':
      return reason === undefined ? { decision: 'ask' } : { decision: 'ask', reason }
    default:
      // Unknown vocabulary: no vote.
      return reason === undefined ? {} : { reason }
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/**
 * Fold the hooks' votes into one answer: deny > ask > allow.
 *
 * A single refusal outranks any number of allowances — one cautious hook is
 * worth more than three permissive ones. `ask` outranks `allow` because a hook
 * asking for the human is saying "I am not willing to own this". No votes at
 * all means the chain proceeds exactly as it would have: ask the user.
 */
export function aggregatePermissionDecisions(
  votes: readonly (HookPermissionVote | undefined)[]
): HookPermissionVote | undefined {
  let sawAsk = false
  let sawAllow = false
  for (const vote of votes) {
    if (vote === 'deny') return 'deny'
    if (vote === 'ask') sawAsk = true
    else if (vote === 'allow') sawAllow = true
  }
  if (sawAsk) return 'ask'
  if (sawAllow) return 'allow'
  return undefined
}

/**
 * Whether a hook's `allow` may actually stand.
 *
 * Returns the refusal reason when the call touches something the chain treats
 * as a capability limit rather than a policy default: a hard-denied command
 * shape, or a credential location. Both sit above the rule layer for a reason,
 * and a hook is not more trusted than the user's own rules file.
 */
export function hookAllowIsOverridable(
  args: Record<string, unknown> | undefined
): { ok: true } | { ok: false; reason: string } {
  const command = commandForArgs(args)
  const hardDeny = hardDenyFor(command)
  if (hardDeny !== undefined) {
    return { ok: false, reason: `hook allow ignored — blocked pattern: ${hardDeny}` }
  }
  const target = firstSensitivePath(pathsForArgs(args)) ?? commandTouchesSensitivePath(command)
  if (target !== undefined) {
    return {
      ok: false,
      reason: `hook allow ignored — credential location (${target.kind}): ${target.target}`
    }
  }
  return { ok: true }
}

/**
 * Advance the Stop-block counter.
 *
 * `forced` is the third consecutive block: the turn ends regardless of what the
 * hook says, and the caller is expected to record that it happened so the
 * ceiling is visible rather than looking like the hook simply gave up.
 */
export function nextStopBlocks(count: number): {
  count: number
  /** Send the model round again. */
  continuable: boolean
  /** Hit the ceiling: end the turn anyway. */
  forced: boolean
} {
  const next = count + 1
  if (next >= MAX_STOP_BLOCKS) return { count: next, continuable: false, forced: true }
  return { count: next, continuable: true, forced: false }
}
