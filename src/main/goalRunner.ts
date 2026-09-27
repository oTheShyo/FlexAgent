/**
 * Goal mode wiring (issue 05) — the worker side.
 *
 * The state machine lives in goalMode.ts (pure, tested); this module owns the
 * three things only the worker can do:
 *
 *  - persist the goal per session (goals.json, atomic tmp+rename);
 *  - trigger a verification round when a turn ends;
 *  - continue automatically (prompt the verification, then the next step).
 *
 * One worker thread: a verification round IS a turn, so the goal runner must
 * never prompt while a run is in flight — it only ever acts on agent_settled,
 * when the run state is idle again.
 */
import { join } from 'path'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import type {
  GoalCommand,
  GoalState,
  GoalStatus
} from './goalMode'
import {
  beginIteration,
  buildVerifyPrompt,
  canVerify,
  createGoal,
  parseGoalCommand,
  parseVerdict,
  pauseGoal,
  recordVerdict,
  resumeGoal
} from './goalMode'

export { canVerify } from './goalMode'

const GOALS_FILE = join(process.env.FLEXAGENT_HOME ?? defaultHome(), 'goals.json')

function defaultHome(): string {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.flexagent')
}

interface GoalsShape {
  goals: Record<string, GoalState>
}

function readGoals(): Record<string, GoalState> {
  try {
    const raw = JSON.parse(readFileSync(GOALS_FILE, 'utf-8')) as GoalsShape
    return raw.goals ?? {}
  } catch {
    return {}
  }
}

function writeGoals(goals: Record<string, GoalState>): void {
  try {
    // Synchronous by contract: readGoal() reads synchronously, so the goal
    // runner's read-after-write (record the verdict, then drive the next
    // round from that same state) must not race an async flush — an async
    // write here reads back the previous goal and silently stalls the loop.
    const tmp = `${GOALS_FILE}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ goals }, null, 2))
    renameSync(tmp, GOALS_FILE)
  } catch {
    // Best-effort: an unwritable file must not take the turn down.
  }
}

export function readGoal(sessionId: string): GoalState | undefined {
  return readGoals()[sessionId]
}

export function setGoal(sessionId: string, goal: GoalState | undefined): GoalState | undefined {
  const goals = readGoals()
  if (goal === undefined) delete goals[sessionId]
  else goals[sessionId] = goal
  writeGoals(goals)
  return goal
}

/** Apply a parsed `/goal` command to the session's goal (or absence of one). */
export function applyGoalCommand(
  sessionId: string,
  raw: string,
  permissionMode: string
): { ok: true; state?: GoalState; message: string } | { ok: false; message: string } {
  const cmd: GoalCommand | null = parseGoalCommand(raw)
  if (cmd === null) return { ok: false, message: 'not a goal command' }
  const now = Date.now()
  const current = readGoal(sessionId)

  // Plan mode is for planning: a goal there would turn the plan into a
  // self-driving loop the mode exists to prevent.
  if (cmd.action === 'set' || cmd.action === 'replace') {
    if (permissionMode === 'plan') {
      return {
        ok: false,
        message: 'Goal mode is unavailable in plan mode — switch out of plan mode first.'
      }
    }
    const goal = createGoal(cmd.text, now, current?.maxRounds)
    setGoal(sessionId, goal)
    return { ok: true, state: goal, message: 'Goal set. Verification starts on the next turn end.' }
  }

  switch (cmd.action) {
    case 'show': {
      if (current === undefined) return { ok: true, message: 'No goal set for this session.' }
      const last = current.iterations[current.iterations.length - 1]
      const round = last?.round ?? 0
      const verdict = last?.verdict ?? '—'
      return {
        ok: true,
        state: current,
        message: `Goal: ${current.text}\nStatus: ${current.status} · round ${round}/${current.maxRounds} · last verdict: ${verdict}`
      }
    }
    case 'pause': {
      if (current === undefined) return { ok: false, message: 'No goal to pause.' }
      const goal = pauseGoal(current, now)
      setGoal(sessionId, goal)
      return { ok: true, state: goal, message: 'Goal paused.' }
    }
    case 'resume': {
      if (current === undefined) return { ok: false, message: 'No goal to resume.' }
      const goal = resumeGoal(current, now)
      if (goal === current) return { ok: true, state: goal, message: 'Goal already reached — clear it and set a new one.' }
      setGoal(sessionId, goal)
      return { ok: true, state: goal, message: 'Goal resumed — verification continues on the next turn end.' }
    }
    case 'clear': {
      if (current === undefined) return { ok: false, message: 'No goal to clear.' }
      setGoal(sessionId, undefined)
      return { ok: true, message: 'Goal cleared.' }
    }
  }
}

/** Called on agent_settled: should a verification round start, and with what prompt? */
export function shouldVerifyOnSettle(sessionId: string, hasEvidence: boolean): { verify: boolean; prompt?: string } {
  const goal = readGoal(sessionId)
  if (goal === undefined) return { verify: false }
  if (!canVerify(goal, Date.now())) return { verify: false }
  // Evidence is what the turn actually produced — file changes, tool results.
  // A turn that produced none has nothing to verify against; the goal waits
  // for a turn that does.
  if (!hasEvidence) return { verify: false }
  const goal2 = setGoal(sessionId, beginIteration(goal, Date.now()))
  if (goal2 === undefined) return { verify: false }
  return { verify: true, prompt: buildVerifyPrompt(goal2) }
}

/** Called after the verification prompt's run settles: record the verdict. */
export function recordVerification(
  sessionId: string,
  reply: string,
  hasEvidence: boolean
): { state?: GoalState; status: GoalStatus | 'none'; message: string } {
  const goal = readGoal(sessionId)
  if (goal === undefined) return { status: 'none', message: 'no goal' }
  const last = goal.iterations[goal.iterations.length - 1]
  if (last === undefined || last.verdict !== undefined) {
    return { status: goal.status, message: 'no pending verification round' }
  }
  const parsed = parseVerdict(reply)
  const next = recordVerdict(goal, last.round, parsed.verdict, hasEvidence, parsed.nextStep, Date.now())
  const state = setGoal(sessionId, next)
  if (state === undefined) return { status: 'none', message: 'goal vanished mid-verification' }
  switch (state.status) {
    case 'reached':
      return { state, status: 'reached', message: `Goal reached after ${state.iterations.length} round(s).` }
    case 'capped':
      return {
        state,
        status: 'capped',
        message: `Round cap (${state.maxRounds}) reached — goal paused. Resume or adjust with /goal.`
      }
    default:
      return {
        state,
        status: state.status,
        message:
          parsed.nextStep !== undefined
            ? `Not met yet — next: ${parsed.nextStep}`
            : 'Not met yet — continuing.'
      }
  }
}

/** Whether the goal should continue automatically right now. */
export function shouldContinue(goal: GoalState | undefined): goal is GoalState & { status: 'active' } {
  return goal !== undefined && goal.status === 'active'
}

/** Convenience for the worker: does this session have an active goal at all? */
export function hasActiveGoal(sessionId: string): boolean {
  const goal = readGoal(sessionId)
  return goal !== undefined && goal.status === 'active'
}
