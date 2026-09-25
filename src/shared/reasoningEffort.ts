/**
 * Reasoning-effort tiers (推理强度) — issue 08.
 *
 * The composer offers three tiers, 低/高/最高; PI sessions speak in per-model
 * thinking levels (`off … max`). This module is the single mapping between the
 * two, shared by the worker (`ModelConfig.effort`, the `effort` field in
 * llm-calls.jsonl) and the renderer (the tier menu), so both sides always
 * agree on what a tier means.
 *
 * The mapping is capability-driven: it only ever reads the levels the current
 * model declares (`ModelConfig.availableThinkingLevels` ← PI's
 * `getAvailableThinkingLevels()` ← the `reasoning` / `thinkingLevelMap`
 * metadata in models.json) and never invents a level the model did not ask
 * for. Resolution, per tier:
 *
 *   低   the model's low end — `low`, else `minimal`, else its weakest level
 *   最高  the model's strongest level
 *   高   between those two, preferring `high` then `medium`; when the ladder
 *        has no rung left in between, the tier is unavailable and says why,
 *        so the menu disables it instead of quietly sending something else
 *
 * On a model whose ladder tops out at `high` this yields 低→`low`,
 * 高→`medium`, 最高→`high` — three distinct wire values, all levels that model
 * actually accepts. On a model that declares no reasoning, every tier is
 * unavailable with a reason and requests carry no reasoning parameter.
 *
 * `off` (推理 · 关) is deliberately not a tier: it is the level that means "send
 * no reasoning parameter", offered alongside the tiers in the menu.
 */
import type { ThinkingLevel } from './contract'

export type ReasoningEffort = 'low' | 'high' | 'max'

/** Display order of the tiers: 低 → 高 → 最高. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'high', 'max']

/** Tier names as the ticket spells them: 低 / 高 / 最高. */
export const REASONING_EFFORT_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  low: '低',
  high: '高',
  max: '最高'
}

/** English gloss shown next to the Chinese name in the menu. */
export const REASONING_EFFORT_GLOSS: Readonly<Record<ReasoningEffort, string>> = {
  low: 'Low',
  high: 'High',
  max: 'Max'
}

/** The `off` level: offered in the menu, but deliberately not a tier. */
export const REASONING_EFFORT_OFF_LABEL = '关'

/** No model on the session yet — nothing to resolve a tier against. */
export const EFFORT_NO_MODEL_REASON =
  'No model selected — reasoning tiers depend on what the model accepts.'

/** Model present but not declared as reasoning-capable (`reasoning: false`). */
export const EFFORT_UNSUPPORTED_REASON =
  'This model does not declare reasoning support, so requests carry no reasoning parameter — the tier stays disabled rather than faking a value.'

/** One tier, resolved against a specific model's thinking levels. */
export interface EffortOption {
  effort: ReasoningEffort
  /**
   * The level this tier sends for the current model, or `null` when the tier
   * has no slot on this model (see `reason`).
   */
  level: ThinkingLevel | null
  available: boolean
  /** Why the tier is unavailable — user-facing, shown in the menu. */
  reason?: string
}

/** PI's thinking levels, weakest → strongest. */
const LADDER: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

function rank(level: string): number {
  const index = LADDER.indexOf(level as ThinkingLevel)
  return index === -1 ? -1 : index
}

/**
 * Keep only levels PI actually defines, drop duplicates, sort weakest →
 * strongest. `null`/`undefined`/`[]` all mean "this model declares nothing".
 */
export function normalizeThinkingLevels(
  available?: readonly ThinkingLevel[] | null
): ThinkingLevel[] {
  if (available === null || available === undefined) return []
  const out: ThinkingLevel[] = []
  for (const level of available) {
    if (LADDER.includes(level) && !out.includes(level)) out.push(level)
  }
  out.sort((a, b) => rank(a) - rank(b))
  return out
}

export function hasReasoningSupport(available?: readonly ThinkingLevel[] | null): boolean {
  return normalizeThinkingLevels(available).some((level) => level !== 'off')
}

function noSupportOptions(): EffortOption[] {
  return REASONING_EFFORTS.map((effort) => ({
    effort,
    level: null,
    available: false,
    reason: EFFORT_UNSUPPORTED_REASON
  }))
}

function highUnavailableReason(levels: readonly ThinkingLevel[]): string {
  const list = levels.join(' / ')
  const nonOff = levels.filter((level) => level !== 'off')
  const weakest = nonOff[0]
  const strongest = nonOff[nonOff.length - 1]
  if (weakest === strongest) {
    return `Model levels (${list}) — ${strongest} is the only rung, so 高 (High) has no distinct slot.`
  }
  return `Model levels (${list}) leave no level between ${weakest} and ${strongest} for 高 (High).`
}

/**
 * Resolve all three tiers against one model's thinking levels. Unavailable
 * tiers come back with a user-facing `reason`; a model with no reasoning
 * capability yields three unavailable tiers and no level at all.
 */
export function resolveEffortTiers(
  available?: readonly ThinkingLevel[] | null
): EffortOption[] {
  const levels = normalizeThinkingLevels(available)
  if (!levels.some((level) => level !== 'off')) return noSupportOptions()

  const nonOff = levels.filter((level) => level !== 'off')
  const lowLevel =
    (['low', 'minimal'] as ThinkingLevel[]).find((level) => levels.includes(level)) ??
    nonOff[0]
  const maxLevel = nonOff[nonOff.length - 1]
  const between: ThinkingLevel[] = nonOff.filter(
    (level) => rank(level) > rank(lowLevel) && rank(level) < rank(maxLevel)
  )
  const highLevel =
    (['high', 'medium'] as ThinkingLevel[]).find((level) => between.includes(level)) ??
    (between.length > 0 ? between[between.length - 1] : undefined)

  const byEffort: Record<ReasoningEffort, EffortOption> = {
    low: { effort: 'low', level: lowLevel, available: true },
    high:
      highLevel === undefined
        ? {
            effort: 'high',
            level: null,
            available: false,
            reason: highUnavailableReason(levels)
          }
        : { effort: 'high', level: highLevel, available: true },
    max: { effort: 'max', level: maxLevel, available: true }
  }
  return REASONING_EFFORTS.map((effort) => byEffort[effort])
}

/**
 * The tier that matches the level currently in effect — exact match first, so
 * the chip never claims a tier the model resolved differently. `off` and any
 * level outside the tier set (a raw level picked in the advanced menu) yield
 * `null`: the caller shows the level itself instead of a tier name.
 */
export function effortForLevel(
  level: ThinkingLevel | null | undefined,
  available?: readonly ThinkingLevel[] | null
): ReasoningEffort | null {
  if (level === null || level === undefined || level === 'off') return null
  const hit = resolveEffortTiers(available).find(
    (option) => option.available && option.level === level
  )
  return hit === undefined ? null : hit.effort
}

export function describeEffort(effort: ReasoningEffort): string {
  return `${REASONING_EFFORT_LABELS[effort]} · ${REASONING_EFFORT_GLOSS[effort]}`
}
