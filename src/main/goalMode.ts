/**
 * Goal mode core (issue 05) — pure state plus policy queries.
 *
 * No timers, no clock, no Electron, no worker imports: the runner wires this
 * into the turn loop, and what needs testing is the policy. The policy is
 * where the bugs would be:
 *
 *  - a goal the user paused stays paused across restarts (resume is explicit);
 *  - a verdict the model announced without evidence is not completion;
 *  - the round cap pauses the goal — it never silently clears it.
 */

/** One iteration of verify → continue (or stop). */
export interface GoalIteration {
  /** Monotonic from 1. Incremented when a verification round begins. */
  round: number
  /** When the verification for this round started (ms epoch). */
  startedAt: number
  /** Model verdict for the round: 'complete' | 'incomplete' | 'error'. */
  verdict?: 'complete' | 'incomplete' | 'error'
  /** The next step the model proposed (incomplete rounds only). */
  nextStep?: string
}

export type GoalStatus = 'active' | 'paused' | 'reached' | 'capped'

export interface GoalState {
  /** The goal, verbatim from the user. Empty string is not a goal. */
  text: string
  status: GoalStatus
  iterations: GoalIteration[]
  /** Max verification rounds before the goal pauses itself. */
  maxRounds: number
  /** ms epoch of the last state change. */
  updatedAt: number
}

export const DEFAULT_GOAL_MAX_ROUNDS = 20

/** Parse `/goal ...` commands. Returns null when the text is not a goal command. */
export type GoalCommand =
  | { action: 'show' }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'clear' }
  | { action: 'set'; text: string }
  | { action: 'replace'; text: string }

export function parseGoalCommand(raw: string): GoalCommand | null {
  const text = raw.trim()
  if (!/^\/goal\b/i.test(text)) return null
  const rest = text.replace(/^\/goal/i, '').trim()
  if (rest.length === 0) return { action: 'show' }
  const [head, ...tail] = rest.split(/\s+/)
  const arg = tail.join(' ').trim()
  switch (head.toLowerCase()) {
    case 'pause':
      return { action: 'pause' }
    case 'resume':
      return { action: 'resume' }
    case 'clear':
      return { action: 'clear' }
    case 'replace':
      return arg.length > 0 ? { action: 'replace', text: arg } : null
    default:
      // `/goal <description>` — the whole rest is the goal.
      return { action: 'set', text: rest }
  }
}

export function createGoal(text: string, now: number, maxRounds = DEFAULT_GOAL_MAX_ROUNDS): GoalState {
  return {
    text: text.trim(),
    status: 'active',
    iterations: [],
    maxRounds: maxRounds > 0 ? maxRounds : DEFAULT_GOAL_MAX_ROUNDS,
    updatedAt: now
  }
}

/** Whether the goal accepts a new verification round right now. */
export function canVerify(goal: GoalState, _now: number): boolean {
  if (goal.status !== 'active') return false
  if (goal.iterations.length >= goal.maxRounds) return false
  const last = goal.iterations[goal.iterations.length - 1]
  // One verification at a time: a round that started but has no verdict yet
  // is still in flight — starting another would double-verify the same turn.
  return last === undefined || last.verdict !== undefined
}

/** Begin a verification round. Caller must check canVerify first. */
export function beginIteration(goal: GoalState, now: number): GoalState {
  return {
    ...goal,
    iterations: [...goal.iterations, { round: goal.iterations.length + 1, startedAt: now }],
    updatedAt: now
  }
}

/**
 * Record a verdict. The model's word alone is not completion — the caller
 * passes `hasEvidence` (file changes, tool results, test output observed this
 * turn); a 'complete' verdict without evidence downgrades to incomplete.
 */
export function recordVerdict(
  goal: GoalState,
  round: number,
  verdict: 'complete' | 'incomplete' | 'error',
  hasEvidence: boolean,
  nextStep: string | undefined,
  now: number
): GoalState {
  const iterations = goal.iterations.map((it) =>
    it.round === round ? { ...it, verdict, nextStep } : it
  )
  let status = goal.status
  if (verdict === 'complete' && hasEvidence) status = 'reached'
  const capped = goal.iterations.length >= goal.maxRounds && status === 'active'
  if (capped) status = 'capped'
  return { ...goal, iterations, status, updatedAt: now }
}

/** Resume from pause/cap. Reached goals do not resume — clear and re-set instead. */
export function resumeGoal(goal: GoalState, now: number): GoalState {
  if (goal.status === 'reached') return goal
  return { ...goal, status: 'active', updatedAt: now }
}

export function pauseGoal(goal: GoalState, now: number): GoalState {
  return { ...goal, status: 'paused', updatedAt: now }
}

/**
 * The prompt the verification round sends. It demands evidence: a plan, a
 * todo list, or a confident-sounding summary is not completion — only changed
 * files, command output and test results count.
 */
export function buildVerifyPrompt(goal: GoalState): string {
  const round = goal.iterations.length
  // The proposed next step comes from the last round that has one — the round
  // just appended by beginIteration is empty by construction.
  const next = [...goal.iterations].reverse().find((it) => it.nextStep !== undefined)?.nextStep
  const step = next !== undefined && next.length > 0 ? `\n\nProposed next step from the previous round: ${next}` : ''
  return [
    `You are verifying a session goal. Round ${round} of at most ${goal.maxRounds}.`,
    ``,
    `Goal: ${goal.text}`,
    step,
    ``,
    `Rules:`,
    `- Judge only by evidence produced in this session: files actually changed, command output, test results.`,
    `- A plan, a todo list, or a statement that the work "should" or "is expected to" be done is NOT evidence of completion.`,
    `- If outstanding todo/plan items exist, finishing them takes priority over reporting.`,
    ``,
    `Reply with EXACTLY one line first, then a short justification:`,
    `VERDICT: COMPLETE   — the goal is met, with the evidence named`,
    `VERDICT: INCOMPLETE — not met; end with a line "NEXT: <one concrete next step>"`
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

/** Parse the model's verification reply. Case-insensitive, first line wins. */
export function parseVerdict(
  reply: string
): { verdict: 'complete' | 'incomplete' | 'error'; nextStep?: string } {
  const lines = reply.split('\n').map((line) => line.trim())
  let verdict: 'complete' | 'incomplete' | null = null
  for (const line of lines) {
    const match = /^VERDICT:\s*(COMPLETE|INCOMPLETE)/i.exec(line)
    if (match) {
      verdict = match[1].toLowerCase() as 'complete' | 'incomplete'
      break
    }
  }
  let nextStep: string | undefined
  for (const line of lines) {
    const match = /^NEXT:\s*(.+)$/i.exec(line)
    if (match) {
      nextStep = match[1].trim()
      break
    }
  }
  if (verdict === null) return { verdict: 'error', nextStep }
  return { verdict, nextStep }
}
