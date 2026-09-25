/**
 * Multi-agent collaboration extension (chapter "三种协作模式").
 *
 * Two tools, registered on host sessions:
 * - `task`   — parent→child delegation. Single / Parallel / Chain modes.
 *              Parallel runs are permitted only when every task's role
 *              declares parallel compatibility with the others (read-only
 *              roles are safe by default); anything else is a hard error, so
 *              writes stay serial instead of racing.
 * - `swarm`  — the persistent task queue behind Swarm mode: submit / claim /
 *              complete / fail / status. Peer children receive this tool as a
 *              custom tool and loop claim→execute→complete until drained.
 *
 * Isolation guarantees (chapter "子 Agent 的隔离机制"), and how:
 * - Context isolation: children run on their own AgentSession over
 *   SessionManager.inMemory() — no transcript on disk, no shared context, and
 *   only the final assistant message returns to the parent.
 * - Tool isolation: a child's tools are an explicit whitelist subset of the
 *   built-ins, loaded through a resource loader built with
 *   noExtensions/noSkills — extension tools (skill_manage, memory_manage,
 *   MCP, and `task` itself) never exist for a child. Depth is therefore
 *   hard-capped at one level, which is also the nesting the design doc asks
 *   you to think twice about.
 * - Memory isolation: child transcripts never touch disk and never reach the
 *   memory pipeline, so a subagent's tool output cannot be refined into a
 *   user preference.
 * - Permission inheritance: children evaluate tool calls against the parent's
 *   permission mode at call time; an "ask" verdict is forwarded to the parent
 *   session's UI channel and the child blocks on the user's decision.
 *   Children can inherit or downgrade, never upgrade.
 *
 * Process isolation is the one thing children do not get: they run on the
 * same worker thread by design (the worker is the isolation boundary for the
 * whole kernel). A runaway child can be aborted via the parent's tool call.
 */

import type {
  AgentSession,
  AgentToolResult,
  DefaultResourceLoader as DefaultResourceLoaderType,
  ExtensionAPI,
  InlineExtension,
  ModelRuntime,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { auditSymmetry, canRunInParallel, getRole, listRoleNames, type AgentRole } from './roles'
import { getSwarmQueue, type SwarmTask } from './swarmQueue'

type PiModule = typeof import('@earendil-works/pi-coding-agent')

/** Same limits as the kernel's own subagent reference implementation. */
const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4
const PER_TASK_OUTPUT_CAP = 32 * 1024
const CHAIN_PLACEHOLDER_CAP = 16 * 1024

export type PermissionForwardResult =
  | { outcome: 'allow' }
  | { outcome: 'deny'; reason: string }

export interface MultiAgentDeps {
  /** Lazy PI loader — must stay dynamic or the worker's cold start regresses. */
  loadPi: () => Promise<PiModule>
  /** The worker-wide ModelRuntime; children share it like every other session. */
  getModelRuntime: () => Promise<ModelRuntime>
  /**
   * Evaluate a child tool call under the parent session's permission mode and
   * route "ask" verdicts to the parent's UI. Implemented in the worker so the
   * gate semantics live in exactly one place.
   */
  forwardPermission: (
    sessionId: string,
    toolName: string,
    args: unknown,
    childLabel: string
  ) => Promise<PermissionForwardResult>
  /**
   * Hand the finished child-run ledger to the observability sink
   * (docs/observability.md §4). A child's own `chat` calls never cross the
   * parent's event stream — the session is in-memory and disposed before the
   * parent sees a reply — so without this a delegation is invisible in the
   * cost breakdown: tokens spent inside children look exactly like tokens
   * spent by the parent. Optional by design; a missing sink must not break a
   * child run.
   */
  observeChildRun?: (ledger: ChildRunLedger) => void
}

/** What one child run cost. One ledger per execution, not one row per call. */
export interface ChildRunLedger {
  /** Parent session the delegation came from; a child has no durable session. */
  parentSessionId: string
  /** Role slug that ran, so cost can be attributed to a role. */
  role: string
  ok: boolean
  durationMs: number
  /** From the child session's stats: how much of that time was model time. */
  turns?: number
  toolCalls?: number
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  cost?: number
}

interface ToolText {
  content: Array<{ type: 'text'; text: string }>
  details: undefined
}

function textResult(text: string): ToolText {
  return { content: [{ type: 'text', text }], details: undefined }
}

function progressLine(onUpdate: ((partial: AgentToolResult) => void) | undefined, text: string): void {
  onUpdate?.({ content: [{ type: 'text', text }], details: undefined })
}

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… (truncated, ${text.length - limit} chars omitted)`
}

/** Run factories with a concurrency cap, preserving input order in the results. */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Child sessions
// ---------------------------------------------------------------------------

/**
 * Children share one extension-free loader per cwd: no extensions, no skills,
 * no project prompt templates. Building it is the same order of cost as the
 * parent's first attach (~1s of directory scans), paid once per cwd, then
 * amortized across every child that folder ever spawns.
 */
const childLoaders = new Map<string, Promise<DefaultResourceLoaderType>>()

function childLoaderKey(cwd: string): string {
  return cwd.toLowerCase()
}

async function acquireChildLoader(pi: PiModule, cwd: string): Promise<DefaultResourceLoaderType> {
  const key = childLoaderKey(cwd)
  const cached = childLoaders.get(key)
  if (cached) return cached
  const pending = (async () => {
    const { DefaultResourceLoader, getAgentDir } = pi
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true
    })
    await loader.reload()
    return loader
  })()
  childLoaders.set(key, pending)
  pending.catch(() => childLoaders.delete(key))
  return pending
}

interface ChildRunOutcome {
  ok: boolean
  output: string
  ms: number
}

type ChildStats = ReturnType<AgentSession['getSessionStats']>

/**
 * The child's own token and cost ledger.
 *
 * `getSessionStats` is the only place the kernel exposes a child's spending —
 * the child's `chat` calls never cross the parent's event stream — and it can
 * throw after an aborted run. An unusable ledger comes back empty rather than
 * zeroed: a row reading `cost: 0` would attribute the whole delegation to
 * nothing, which is worse than saying we did not measure it.
 */
function readChildLedger(session: AgentSession | undefined): {
  turns?: number
  toolCalls?: number
  tokens?: ChildRunLedger['tokens']
  cost?: number
} {
  if (session === undefined) return {}
  let stats: ChildStats
  try {
    stats = session.getSessionStats()
  } catch {
    return {}
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const callCount = num(stats.toolCalls)
  return {
    // The kernel counts assistant messages; that is the closest thing to a
    // turn a child ran without reaching into the transcript.
    turns: num(stats.assistantMessages),
    ...(callCount === undefined ? {} : { toolCalls: callCount }),
    tokens: {
      input: num(stats.tokens.input),
      output: num(stats.tokens.output),
      cacheRead: num(stats.tokens.cacheRead),
      cacheWrite: num(stats.tokens.cacheWrite),
      total: num(stats.tokens.total)
    },
    ...(Number.isFinite(stats.cost) ? { cost: stats.cost } : {})
  }
}

/**
 * Spawn one child session, run one task, return its final message.
 *
 * The persona rides the first user message: it shapes the child without
 * touching the shared system-prompt prefix of the parent, which is what keeps
 * the parent's KV-cache hit rate intact — the very reason delegation exists.
 */
async function runChild(
  pi: PiModule,
  deps: MultiAgentDeps,
  parentSessionId: string,
  parentCwd: string,
  role: AgentRole,
  taskText: string,
  extraTools: ToolDefinition[],
  signal: AbortSignal | undefined,
  onProgress: ((partial: AgentToolResult) => void) | undefined,
  label: string
): Promise<ChildRunOutcome> {
  const started = Date.now()
  const { createAgentSession, SessionManager } = pi
  const modelRuntime = await deps.getModelRuntime()
  const resourceLoader = await acquireChildLoader(pi, parentCwd)
  let session: AgentSession | undefined
  let succeeded = false
  try {
    const { session: child } = await createAgentSession({
      cwd: parentCwd,
      // Context isolation: nothing is persisted, nothing is shared, and the
      // child's transcript can never be replayed into a parent or the memory
      // pipeline.
      sessionManager: SessionManager.inMemory(parentCwd),
      resourceLoader,
      modelRuntime,
      // Whitelist must cover the extra custom tools too — the kernel filters
      // customTools through the same allowed-names set as built-ins.
      tools: [...role.tools, ...extraTools.map((tool) => tool.name)],
      customTools: extraTools
    })
    session = child
    await child.bindExtensions({ mode: 'print' })

    // Permission inheritance, enforced in code: the child evaluates against
    // the parent's mode at call time; "ask" goes to the parent's UI and the
    // child waits on the user.
    child.agent.beforeToolCall = async (ctx) => {
      const verdict = await deps.forwardPermission(
        parentSessionId,
        ctx.toolCall.name,
        ctx.args,
        label
      )
      if (verdict.outcome === 'deny') return { block: true, reason: verdict.reason }
      return undefined
    }

    const onAbort = (): void => {
      void child.abort().catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await child.prompt(`${role.persona}\n\n---\n\n# Task\n\n${taskText}`)
      succeeded = true
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }

    const output = child.getLastAssistantText() ?? '(child produced no output)'
    return { ok: true, output: cap(output, PER_TASK_OUTPUT_CAP), ms: Date.now() - started }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, output: cap(message, PER_TASK_OUTPUT_CAP), ms: Date.now() - started }
  } finally {
    // Reported before dispose: the stats object dies with the session, and an
    // aborted run is exactly when the ledger is worth having.
    deps.observeChildRun?.({
      parentSessionId,
      role: role.name,
      ok: succeeded,
      durationMs: Date.now() - started,
      ...readChildLedger(session)
    })
    if (session !== undefined) {
      try {
        session.dispose()
      } catch {
        // Dispose is cleanup; a failure here must not mask the run outcome.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// task tool
// ---------------------------------------------------------------------------

interface TaskSpec {
  role: string
  task: string
}

const TASK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: listRoleNames(), description: 'Agent role for single mode.' },
    task: { type: 'string', description: 'Single mode: the task text.' },
    tasks: {
      type: 'array',
      description:
        'Parallel mode: 2–8 independent tasks run concurrently. Allowed only when every task uses a read-only role or roles that declare parallel compatibility; otherwise the call is rejected — run them one by one instead.',
      items: {
        type: 'object',
        properties: { role: { type: 'string', enum: listRoleNames() }, task: { type: 'string' } },
        required: ['role', 'task']
      }
    },
    chain: {
      type: 'array',
      description:
        'Chain mode: sequential tasks where "{previous}" in a task text is replaced by the previous task\'s output. Use when each step builds on the last.',
      items: {
        type: 'object',
        properties: { role: { type: 'string', enum: listRoleNames() }, task: { type: 'string' } },
        required: ['role', 'task']
      }
    }
  }
} as const

function parseSpecs(params: Record<string, unknown>): { mode: string; specs: TaskSpec[] } {
  const specsFrom = (value: unknown): TaskSpec[] => {
    if (!Array.isArray(value)) return []
    return value
      .map((entry) => {
        const record = entry as Record<string, unknown>
        return {
          role: typeof record.role === 'string' ? record.role : '',
          task: typeof record.task === 'string' ? record.task : ''
        }
      })
      .filter((spec) => spec.role !== '' && spec.task !== '')
  }

  if (typeof params.task === 'string' && params.task.trim() !== '') {
    const role = typeof params.role === 'string' ? params.role : ''
    return { mode: 'single', specs: [{ role, task: params.task }] }
  }
  if (Array.isArray(params.tasks) && params.tasks.length > 0) {
    return { mode: 'parallel', specs: specsFrom(params.tasks) }
  }
  if (Array.isArray(params.chain) && params.chain.length > 0) {
    return { mode: 'chain', specs: specsFrom(params.chain) }
  }
  throw new Error('task requires "task" (single), "tasks" (parallel), or "chain"')
}

function buildTaskReport(mode: string, results: ChildRunOutcome[], specs: TaskSpec[]): string {
  const sections = results.map((result, i) => {
    const status = result.ok ? 'ok' : 'failed'
    const header = `## [${i + 1}/${specs.length}] ${specs[i]!.role} — ${status} (${(result.ms / 1000).toFixed(1)}s)`
    return `${header}\n\n${result.output}`
  })
  const failed = results.filter((result) => !result.ok).length
  const summary =
    mode === 'chain'
      ? `chain finished: ${specs.length} step(s), ${failed} failed`
      : `batch finished: ${specs.length} task(s), ${failed} failed`
  return `# task results (${summary})\n\n${sections.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// swarm tool
// ---------------------------------------------------------------------------

const SWARM_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['submit', 'claim', 'complete', 'fail', 'status'],
      description:
        'submit: publish a task to the shared queue. claim: atomically take the first runnable task (all dependencies done) — an empty result means the queue is drained for you. complete/fail: record the outcome of a task you claimed. status: inspect the queue.'
    },
    title: { type: 'string', description: 'submit: one-line task title.' },
    detail: { type: 'string', description: 'submit: everything a peer needs to execute the task without asking questions.' },
    deps: { type: 'array', items: { type: 'string' }, description: 'submit: task ids that must be done first (forms a DAG).' },
    taskId: { type: 'string', description: 'complete/fail: the claimed task id.' },
    result: { type: 'string', description: 'complete: the outcome other tasks and the coordinator will rely on.' },
    reason: { type: 'string', description: 'fail: why the task could not be completed.' }
  },
  required: ['action']
} as const

type SwarmAction = 'submit' | 'claim' | 'complete' | 'fail' | 'status'

function renderTask(task: SwarmTask): string {
  const deps = task.deps.length > 0 ? `\n  deps: ${task.deps.join(', ')}` : ''
  const holder = task.claimedBy !== undefined ? ` (held by ${task.claimedBy})` : ''
  return `- ${task.id} [${task.status}]${holder} ${task.title}${deps}\n  ${task.detail.replace(/\s+/g, ' ').slice(0, 300)}`
}

function runSwarmAction(action: SwarmAction, params: Record<string, unknown>, peer: string): string {
  const queue = getSwarmQueue()
  switch (action) {
    case 'submit': {
      const title = typeof params.title === 'string' ? params.title.trim() : ''
      const detail = typeof params.detail === 'string' ? params.detail.trim() : ''
      if (title === '' || detail === '') throw new Error('submit requires title and detail')
      const deps = Array.isArray(params.deps)
        ? params.deps.filter((dep): dep is string => typeof dep === 'string')
        : []
      const task = queue.submit({ title, detail, deps, createdBy: peer })
      const downstream = queue.dependents(task.id)
      return (
        `submitted ${task.id}: ${task.title}` +
        (deps.length > 0 ? ` (after ${deps.join(', ')})` : '') +
        (downstream.length > 0
          ? `\nunblocked candidates once done: ${downstream.map((t) => t.id).join(', ')}`
          : '')
      )
    }
    case 'claim': {
      const task = queue.claim(peer)
      if (task === undefined) return 'QUEUE_EMPTY — no runnable task (pending tasks may be waiting on dependencies)'
      return `claimed ${task.id}: ${task.title}\ndeps: ${task.deps.join(', ') || 'none'}\n\n${task.detail}`
    }
    case 'complete': {
      const taskId = typeof params.taskId === 'string' ? params.taskId : ''
      const result = typeof params.result === 'string' ? params.result : ''
      if (taskId === '' || result.trim() === '') throw new Error('complete requires taskId and result')
      const task = queue.complete(taskId, peer, cap(result.trim(), PER_TASK_OUTPUT_CAP))
      const downstream = queue.dependents(taskId).filter((t) => t.status === 'pending')
      return (
        `completed ${task.id}` +
        (downstream.length > 0 ? `\nnewly runnable for other peers: ${downstream.map((t) => t.id).join(', ')}` : '')
      )
    }
    case 'fail': {
      const taskId = typeof params.taskId === 'string' ? params.taskId : ''
      const reason = typeof params.reason === 'string' ? params.reason : ''
      if (taskId === '' || reason.trim() === '') throw new Error('fail requires taskId and reason')
      queue.fail(taskId, peer, reason.trim())
      return `failed ${taskId} — recorded; dependent tasks will never run and should be cleaned up by the coordinator`
    }
    case 'status': {
      const snapshot = queue.status()
      const lines = snapshot.tasks.map(renderTask)
      return [
        `queue: ${snapshot.pending} pending / ${snapshot.claimed} claimed / ${snapshot.done} done / ${snapshot.failed} failed`,
        ...lines
      ].join('\n')
    }
  }
}

function buildSwarmToolDefinition(): ToolDefinition {
  return {
    name: 'swarm',
    label: 'Swarm queue',
    description:
      'Shared persistent task queue for peer collaboration. claim pulls the first task whose dependencies are all done — the claim is atomic, two peers can never hold the same task. Loop claim → execute → complete (or fail) until the queue is drained.',
    promptSnippet: 'swarm: shared persistent task queue — submit tasks, claim runnable ones, record outcomes',
    parameters: SWARM_TOOL_SCHEMA,
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, ctx) => {
      const params =
        rawParams !== null && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {}
      try {
        const action = typeof params.action === 'string' ? params.action : ''
        if (action !== 'submit' && action !== 'claim' && action !== 'complete' && action !== 'fail' && action !== 'status') {
          return textResult(`unknown swarm action: ${action}`)
        }
        const peer = `peer-${ctx.sessionManager.getSessionId().slice(0, 8)}`
        return textResult(runSwarmAction(action, params, peer))
      } catch (err) {
        return textResult(`swarm failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

const TASK_PROMPT_SNIPPET = [
  'task: delegate subtasks to isolated child agents (researcher/translator = read-only & parallel-safe; writer/developer/analyst/designer = write roles; peer = swarm queue worker)',
  'swarm: persistent shared task queue — submit/claim/complete/fail/status'
].join('\n')

const TASK_PROMPT_GUIDELINES = [
  'Choose the lightest mode that fits: clear subtask boundaries → task single/parallel; how to decompose needs reasoning or subtasks have ordering → task chain plus your own synthesis; tasks emerge dynamically or must span sessions → swarm submit + peer workers.',
  'Reads before writes: run independent read-only research in parallel first, then serial writes — never batch write-capable roles into one parallel call.',
  'Delegate execution, never understanding: every child returns a report; you read all of them and synthesize the final answer yourself.',
  'Verify with a fresh child: for high-stakes conclusions, spawn an independent verification task instead of trusting your own or another child\'s analysis.',
  'Children are isolated: they cannot see this conversation and only their final message comes back — write the task brief as if for a smart stranger.'
]

export function createMultiAgentExtension(deps: MultiAgentDeps): InlineExtension {
  if (auditSymmetry().length > 0) {
    // A broken declaration would silently serialize everything or race
    // writes; refusing to register beats both.
    throw new Error(`multi-agent role table is not symmetric: ${auditSymmetry().join('; ')}`)
  }
  return {
    name: 'flex-multi-agent',
    factory: (pi: ExtensionAPI): void => {
      const swarmDef: ToolDefinition = buildSwarmToolDefinition()

      pi.registerTool({
        name: 'task',
        label: 'Task',
        description:
          'Delegate subtasks to isolated child agents. Three modes: single ({role, task}), parallel ({tasks: [...]} — only read-only/compatible roles, truly concurrent), chain ({chain: [...]} — sequential, "{previous}" carries the prior output). Each child gets its own context and returns one report; you synthesize.',
        promptSnippet: TASK_PROMPT_SNIPPET,
        promptGuidelines: TASK_PROMPT_GUIDELINES,
        parameters: TASK_TOOL_SCHEMA,
        execute: async (_toolCallId, rawParams, signal, onUpdate, ctx) => {
          const params =
            rawParams !== null && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {}
          try {
            const parentSessionId = ctx.sessionManager.getSessionId()
            const { mode, specs } = parseSpecs(params)
            if (specs.length === 0) throw new Error('no usable task specification found')
            if (specs.length > MAX_PARALLEL_TASKS) {
              throw new Error(`too many tasks (${specs.length}); the cap is ${MAX_PARALLEL_TASKS}`)
            }
            const roles = specs.map((spec) => {
              const role = getRole(spec.role)
              if (role === undefined) {
                throw new Error(`unknown role "${spec.role}" — available: ${listRoleNames().join(', ')}`)
              }
              return role
            })

            if (mode === 'parallel') {
              for (let i = 0; i < roles.length; i += 1) {
                for (let j = i + 1; j < roles.length; j += 1) {
                  if (!canRunInParallel(roles[i]!, roles[j]!)) {
                    throw new Error(
                      `parallel rejected: ${roles[i]!.name} and ${roles[j]!.name} are not declared parallel-safe` +
                        ` (writes must stay serial). Run them in separate calls, or use read-only roles for the concurrent part.`
                    )
                  }
                }
              }
            }

            const parentCwd = ctx.cwd
            // The PI module (lazy-loaded once per worker). Distinct from the
            // `pi` extension API in the factory closure.
            const kernel = await deps.loadPi()
            const labelFor = (spec: TaskSpec, index: number): string =>
              `${spec.role}[${index + 1}/${specs.length}]`
            // Peer children carry the swarm tool into isolation; every other
            // role gets pure built-ins.
            const extraFor = (role: AgentRole): ToolDefinition[] =>
              role.name === 'peer' ? buildPeerCustomTools() : []

            progressLine(onUpdate, `⏺ dispatching ${specs.length} ${mode} task(s): ${roles.map((r) => r.label).join(', ')}`)

            let results: ChildRunOutcome[]
            if (mode === 'parallel') {
              results = await mapWithConcurrencyLimit(specs, MAX_CONCURRENCY, (spec, index) => {
                const role = roles[index]!
                progressLine(onUpdate, `⏺ [${index + 1}/${specs.length}] ${labelFor(spec, index)} — started`)
                return runChild(
                  kernel, deps, parentSessionId, parentCwd, role, spec.task, extraFor(role), signal, onUpdate,
                  labelFor(spec, index)
                ).then((outcome) => {
                  progressLine(
                    onUpdate,
                    `⏺ [${index + 1}/${specs.length}] ${labelFor(spec, index)} — ${outcome.ok ? 'done' : 'FAILED'} in ${(outcome.ms / 1000).toFixed(1)}s`
                  )
                  return outcome
                })
              })
            } else {
              results = []
              let previous = ''
              for (let index = 0; index < specs.length; index += 1) {
                const spec = specs[index]!
                const role = roles[index]!
                let taskText = spec.task
                if (mode === 'chain') {
                  if (taskText.includes('{previous}') && previous === '') {
                    throw new Error(
                      'chain step references {previous} but no previous output exists (it is step 1 or a prior step failed)'
                    )
                  }
                  taskText = taskText.replaceAll('{previous}', cap(previous, CHAIN_PLACEHOLDER_CAP))
                }
                progressLine(onUpdate, `⏺ [${index + 1}/${specs.length}] ${labelFor(spec, index)} — started`)
                const outcome = await runChild(
                  kernel, deps, parentSessionId, parentCwd, role, taskText, extraFor(role), signal, onUpdate,
                  labelFor(spec, index)
                )
                progressLine(
                  onUpdate,
                  `⏺ [${index + 1}/${specs.length}] ${labelFor(spec, index)} — ${outcome.ok ? 'done' : 'FAILED'} in ${(outcome.ms / 1000).toFixed(1)}s`
                )
                results.push(outcome)
                if (!outcome.ok) break
                previous = outcome.output
              }
            }

            return textResult(buildTaskReport(mode, results, specs))
          } catch (err) {
            return textResult(`task failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      })

      // Swarm is available on the host for submitting/inspecting; peer
      // children receive the same definition as a custom tool.
      pi.registerTool(swarmDef)
    }
  }
}

/** Peer children receive the swarm tool through `customTools`; nothing else. */
export function buildPeerCustomTools(): ToolDefinition[] {
  return [buildSwarmToolDefinition()]
}
