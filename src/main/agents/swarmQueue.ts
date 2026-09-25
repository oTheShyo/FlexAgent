/**
 * Swarm persistent task queue (chapter "模式三：Swarm").
 *
 * Peers share one durable queue; each task may declare dependencies, forming a
 * DAG — a task becomes claimable only when every dependency is `done`.
 *
 * Concurrency safety: "is this task claimable" and "mark it claimed" are one
 * operation. This worker is single-threaded and every mutation below is
 * synchronous, so the check-then-mark is atomic by construction; the file is
 * the durability copy, not the coordination point.
 *
 * Persistence is required, not an optimization: a Swarm spans sessions, and a
 * peer that dies must leave its task reclaimable. Recovery rule on load: a
 * task still marked `claimed` belonged to a peer that no longer exists (all
 * peers die with the worker), so it goes back to `pending`. Task results
 * survive — completed work is never re-executed.
 *
 * Single-writer assumption: one FlexAgent worker owns this file. That holds
 * because the queue is only reachable through the worker's kernel.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type SwarmTaskStatus = 'pending' | 'claimed' | 'done' | 'failed'

export interface SwarmTask {
  id: string
  title: string
  detail: string
  deps: string[]
  status: SwarmTaskStatus
  claimedBy?: string
  claimedAt?: number
  result?: string
  failedReason?: string
  createdAt: number
  createdBy: string
}

interface QueueFile {
  version: 1
  nextId: number
  tasks: SwarmTask[]
}

/**
 * Root of the queue file. The env override exists so diagnostics can exercise
 * the real load/persist/recovery path against a throwaway directory instead
 * of the user's live queue.
 */
export const SWARM_HOME =
  process.env.FLEXAGENT_SWARM_HOME ?? join(homedir(), '.flexagent', 'swarm')
const QUEUE_FILE = join(SWARM_HOME, 'tasks.json')

function load(): QueueFile {
  if (!existsSync(QUEUE_FILE)) return { version: 1, nextId: 1, tasks: [] }
  try {
    const raw = JSON.parse(readFileSync(QUEUE_FILE, 'utf8')) as QueueFile
    if (raw?.version !== 1 || !Array.isArray(raw.tasks)) throw new Error('bad shape')
    // Crash recovery: a claim whose owner is gone (worker restart) is not a
    // claim. Results are durable, so completed tasks stay done.
    for (const task of raw.tasks) {
      if (task.status === 'claimed') task.status = 'pending'
    }
    return { version: 1, nextId: raw.nextId ?? raw.tasks.length + 1, tasks: raw.tasks }
  } catch {
    // A torn file must not brick the queue: start clean, the old copy stays on
    // disk as tasks.json is only ever replaced by an atomic rename.
    return { version: 1, nextId: 1, tasks: [] }
  }
}

function persist(file: QueueFile): void {
  mkdirSync(SWARM_HOME, { recursive: true })
  // Same-volume temp file + rename: a crash mid-write leaves the previous
  // queue intact instead of a truncated JSON nobody can parse.
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(tmp, QUEUE_FILE)
}

/** Reclaimable: pending, and every dependency done. */
function isClaimable(task: SwarmTask, byId: Map<string, SwarmTask>): boolean {
  if (task.status !== 'pending') return false
  return task.deps.every((dep) => byId.get(dep)?.status === 'done')
}

export class SwarmTaskQueue {
  private file: QueueFile | undefined

  private state(): QueueFile {
    this.file ??= load()
    return this.file
  }

  private flush(): void {
    if (this.file !== undefined) persist(this.file)
  }

  private byId(): Map<string, SwarmTask> {
    return new Map(this.state().tasks.map((task) => [task.id, task]))
  }

  /**
   * Submit a task. Dependencies must reference existing, non-failed tasks and
   * must not form a cycle — self-dependency is the only cycle a new node can
   * join, because nothing depends on it yet.
   */
  submit(input: { title: string; detail: string; deps?: string[]; createdBy: string }): SwarmTask {
    const state = this.state()
    const deps = [...new Set(input.deps ?? [])]
    if (deps.includes('')) throw new Error('deps must be task ids')
    const map = this.byId()
    for (const dep of deps) {
      const target = map.get(dep)
      if (target === undefined) throw new Error(`unknown dependency task: ${dep}`)
      if (target.status === 'failed') {
        throw new Error(`dependency ${dep} has failed — the task could never run`)
      }
    }
    const task: SwarmTask = {
      id: `t-${String(state.nextId).padStart(4, '0')}`,
      title: input.title,
      detail: input.detail,
      deps,
      status: 'pending',
      createdAt: Date.now(),
      createdBy: input.createdBy
    }
    state.nextId += 1
    state.tasks.push(task)
    this.flush()
    return task
  }

  /**
   * Atomic claim: pick the first claimable task and mark it claimed in the
   * same synchronous step. Two peers racing can never hold the same task.
   */
  claim(peer: string): SwarmTask | undefined {
    const state = this.state()
    const map = this.byId()
    const task = state.tasks.find((candidate) => isClaimable(candidate, map))
    if (task === undefined) return undefined
    task.status = 'claimed'
    task.claimedBy = peer
    task.claimedAt = Date.now()
    this.flush()
    return task
  }

  complete(taskId: string, peer: string, result: string): SwarmTask {
    const task = this.byId().get(taskId)
    if (task === undefined) throw new Error(`unknown task: ${taskId}`)
    if (task.status !== 'claimed') throw new Error(`task ${taskId} is ${task.status}, not claimed`)
    if (task.claimedBy !== peer) throw new Error(`task ${taskId} is held by ${task.claimedBy}, not ${peer}`)
    task.status = 'done'
    task.result = result
    this.flush()
    return task
  }

  /** Fail records the reason and leaves the task failed — a broken task must not loop forever. */
  fail(taskId: string, peer: string, reason: string): SwarmTask {
    const task = this.byId().get(taskId)
    if (task === undefined) throw new Error(`unknown task: ${taskId}`)
    if (task.status !== 'claimed') throw new Error(`task ${taskId} is ${task.status}, not claimed`)
    if (task.claimedBy !== peer) throw new Error(`task ${taskId} is held by ${task.claimedBy}, not ${peer}`)
    task.status = 'failed'
    task.failedReason = reason
    this.flush()
    return task
  }

  status(): { tasks: SwarmTask[]; pending: number; claimed: number; done: number; failed: number } {
    const tasks = this.state().tasks
    return {
      tasks: tasks.map((task) => ({ ...task })),
      pending: tasks.filter((t) => t.status === 'pending').length,
      claimed: tasks.filter((t) => t.status === 'claimed').length,
      done: tasks.filter((t) => t.status === 'done').length,
      failed: tasks.filter((t) => t.status === 'failed').length
    }
  }

  /** Downstream view: what a completed task unblocked. */
  dependents(taskId: string): SwarmTask[] {
    return this.state().tasks.filter((task) => task.deps.includes(taskId))
  }
}

/** Module-level singleton — the queue is process-wide state, like the session registry. */
let singleton: SwarmTaskQueue | undefined

export function getSwarmQueue(): SwarmTaskQueue {
  singleton ??= new SwarmTaskQueue()
  return singleton
}

export function resetSwarmQueueForTests(): void {
  singleton = undefined
}
