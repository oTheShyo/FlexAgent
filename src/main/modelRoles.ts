/**
 * Turning routing policy into kernel models, and a session's spend into an
 * answer to "what did this conversation actually pay for?".
 *
 * Two rules carry over from the rest of this codebase:
 *
 *  - **Resolve against the kernel, report what it says.** A binding names a
 *    `provider/id`; whether that model exists, and whether its provider still
 *    has credentials, is the kernel's call. A binding that no longer resolves is
 *    returned with an `error` instead of being silently swapped or dropped.
 *  - **Attribute, never re-count.** The ledger is derived from the session's own
 *    entries — the assistant messages, the compaction checkpoints, PI's own
 *    `usage` entries — rather than from a second counter that could drift from
 *    them.
 */
import type { ModelRuntime, SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  MODEL_ROLES,
  type ModelFacts,
  type ModelOption,
  type ModelRole,
  type ModelRoleState,
  type RoutingState,
  type UsageBucket,
  type UsageReport,
  type UsageTotals
} from '../shared/contract'
import { asString, readJsonDocument } from './jsonFile'
import { ROUTING_FILE, readRoleBindings } from './modelRouting'

type KernelModel = NonNullable<ReturnType<ModelRuntime['getModel']>>

function toModelOption(model: KernelModel): ModelOption {
  const label = typeof model.name === 'string' && model.name.length > 0 ? model.name : undefined
  return { provider: model.provider, id: model.id, ...(label !== undefined ? { label } : {}) }
}

function toModelFacts(model: KernelModel): ModelFacts {
  const label = typeof model.name === 'string' && model.name.length > 0 ? model.name : undefined
  const cost = model.cost
  const input = Array.isArray(model.input) ? [...model.input] : undefined
  return {
    provider: model.provider,
    id: model.id,
    ...(label !== undefined ? { label } : {}),
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    ...(input !== undefined && input.length > 0 ? { input } : {}),
    ...(typeof cost?.input === 'number' ? { costIn: cost.input } : {}),
    ...(typeof cost?.output === 'number' ? { costOut: cost.output } : {})
  }
}

/** Why a bound model cannot be used, or `undefined` when it can. */
function unusableReason(runtime: ModelRuntime, provider: string, id: string): string | undefined {
  if (runtime.getModel(provider, id) === undefined) {
    return `The kernel does not know ${provider}/${id} any more.`
  }
  if (!runtime.hasConfiguredAuth(provider)) {
    return `${provider} has no credentials configured, so it cannot be used.`
  }
  return undefined
}

/**
 * The model the kernel itself would pick for a new session
 * (`defaultProvider`/`defaultModel` in its settings). Reported so an unbound
 * `chat` role can still say what new chats actually start on.
 */
function kernelDefaultModel(runtime: ModelRuntime, settingsFile: string | undefined): KernelModel | null {
  if (settingsFile === undefined) return null
  let root: Record<string, unknown>
  try {
    root = readJsonDocument(settingsFile, 'settings.json').root
  } catch {
    return null
  }
  const provider = asString(root.defaultProvider)
  const id = asString(root.defaultModel)
  if (provider === undefined || id === undefined) return null
  return runtime.getModel(provider, id) ?? null
}

/**
 * Resolve every role. Reads the routing file fresh each time — it is small, and
 * a stale cache here would show a binding the user already cleared.
 */
export async function resolveRoles(
  runtime: ModelRuntime,
  settingsFile: string | undefined
): Promise<RoutingState> {
  const { bindings, errors } = readRoleBindings()
  const available = await runtime.getAvailable()
  const roles: ModelRoleState[] = MODEL_ROLES.map((role) => {
    const declared = errors[role]
    if (declared !== undefined) {
      return { role, source: 'binding', model: null, error: `Ignored a malformed binding: ${declared}` }
    }
    const bound = bindings[role]
    if (bound === undefined) {
      const fallback = role === 'chat' ? kernelDefaultModel(runtime, settingsFile) : null
      return {
        role,
        source: 'kernel',
        model: fallback === null ? null : toModelOption(fallback)
      }
    }
    const reason = unusableReason(runtime, bound.provider, bound.id)
    if (reason !== undefined) return { role, source: 'binding', model: null, error: reason }
    return { role, source: 'binding', model: bound }
  })
  return {
    path: ROUTING_FILE,
    roles,
    facts: available.map((model) => toModelFacts(model))
  }
}

/**
 * The model a role should run on, or `null` to leave the kernel's own choice
 * alone. Synchronous and cheap: it is read on the compaction path.
 */
export function resolveRoleModel(runtime: ModelRuntime, role: ModelRole): KernelModel | null {
  const bound = readRoleBindings().bindings[role]
  if (bound === undefined) return null
  if (unusableReason(runtime, bound.provider, bound.id) !== undefined) return null
  return runtime.getModel(bound.provider, bound.id) ?? null
}

// ─── Usage attribution ───────────────────────────────────────────────────────

function emptyTotals(): UsageTotals {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

interface UsageSample {
  key: string
  model: string
  usage: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    cost?: { total?: number }
  }
}

/**
 * Mirrors PI's own `getUsageCostBreakdown` (not exported publicly) but groups by
 * *purpose* as well as by model, which is the dimension that answers why a
 * conversation was expensive:
 *
 *  - an assistant message → `chat`
 *  - a compaction or branch-summary checkpoint → `compaction`
 *  - PI's own `usage` entries → their own `kind` (e.g. `cache_warm`)
 */
function collectUsage(entries: readonly SessionEntry[]): UsageSample[] {
  const samples: UsageSample[] = []
  for (const entry of entries as readonly unknown[] as readonly Record<string, unknown>[]) {
    const type = entry.type
    if (type === 'message') {
      const message = entry.message as Record<string, unknown> | undefined
      if (message === undefined) continue
      const usage = message.usage as UsageSample['usage'] | undefined
      if (usage === undefined) continue
      if (message.role === 'assistant') {
        const provider = asString(message.provider) ?? 'unknown'
        const model = asString(message.responseModel) ?? asString(message.model) ?? 'unknown'
        samples.push({ key: 'chat', model: `${provider}/${model}`, usage })
      } else if (message.role === 'toolResult') {
        samples.push({ key: 'tool-results', model: 'tools/summaries', usage })
      }
      continue
    }
    if (type === 'compaction' || type === 'branch_summary') {
      const usage = entry.usage as UsageSample['usage'] | undefined
      if (usage === undefined) continue
      samples.push({ key: 'compaction', model: 'tools/summaries', usage })
      continue
    }
    if (type === 'usage') {
      const usage = entry.usage as UsageSample['usage'] | undefined
      if (usage === undefined) continue
      const provider = asString(entry.provider) ?? 'unknown'
      const model = asString(entry.model) ?? 'unknown'
      samples.push({ key: asString(entry.kind) ?? 'other', model: `${provider}/${model}`, usage })
    }
  }
  return samples
}

function addSample(bucket: UsageBucket, sample: UsageSample): void {
  bucket.calls += 1
  bucket.input += sample.usage.input ?? 0
  bucket.output += sample.usage.output ?? 0
  bucket.cacheRead += sample.usage.cacheRead ?? 0
  bucket.cacheWrite += sample.usage.cacheWrite ?? 0
  bucket.cost += sample.usage.cost?.total ?? 0
}

function bucketUp(totals: Map<string, UsageBucket>, key: string): UsageBucket {
  let bucket = totals.get(key)
  if (bucket === undefined) {
    bucket = { key, ...emptyTotals() }
    totals.set(key, bucket)
  }
  return bucket
}

export function buildUsageReport(
  sessionId: string,
  entries: readonly SessionEntry[]
): UsageReport {
  const samples = collectUsage(entries)
  const byPurpose = new Map<string, UsageBucket>()
  const byModel = new Map<string, UsageBucket>()
  const total = emptyTotals()
  for (const sample of samples) {
    addSample(bucketUp(byPurpose, sample.key), sample)
    addSample(bucketUp(byModel, sample.model), sample)
    total.calls += 1
    total.input += sample.usage.input ?? 0
    total.output += sample.usage.output ?? 0
    total.cacheRead += sample.usage.cacheRead ?? 0
    total.cacheWrite += sample.usage.cacheWrite ?? 0
    total.cost += sample.usage.cost?.total ?? 0
  }
  const byCost = (a: UsageBucket, b: UsageBucket): number =>
    b.cost - a.cost || b.input + b.output - (a.input + a.output) || a.key.localeCompare(b.key)
  return {
    sessionId,
    total,
    byPurpose: [...byPurpose.values()].sort(byCost),
    byModel: [...byModel.values()].sort(byCost)
  }
}
