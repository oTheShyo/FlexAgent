/**
 * Card lint rules — checks that must not depend on the model agreeing.
 *
 * `memory_manage` is a tool the model calls on itself. Anything left to prompt
 * discipline ("don't store secrets") eventually fails, so the checks that can
 * be expressed mechanically live here instead, mirroring the advisory linter
 * skill_manage already runs on skill writes.
 *
 * Two levels, deliberately:
 * - `reject` — writing this is wrong and there is no reading of it that makes
 *   sense (a credential in a plain-text file that is injected every turn).
 * - `warn`   — probably wrong, but the model may have a reason; it is told and
 *   can rephrase rather than being silently overridden.
 */

export type CardLintLevel = 'reject' | 'warn'

export interface CardLint {
  level: CardLintLevel
  rule: string
  message: string
}

export interface CardLintResult {
  rejections: CardLint[]
  warnings: CardLint[]
}

/**
 * `name=value` shaped credentials. The separator may be absent in prose ("api
 * key is …"), so the keyword itself allows a space — real keys get written as
 * `apikey`, `api_key`, and `api key`. A value is still required, so "the user
 * hates retyping their api key" passes.
 */
const SECRET_ASSIGNMENT =
  /\b(api[\s_-]?key|access[\s_-]?key|secret[\s_-]?key|secret|password|passwd|credential|bearer|private[\s_-]?key|token)\b\s*[:=]?\s+[A-Za-z0-9_\-]{8,}/i

/**
 * Well-known credential prefixes — unambiguous even without a separator. Their
 * bodies carry separators too (`sk-proj-`, `sk-live-`), so `-` and `_` count.
 */
const SECRET_PREFIX =
  /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/

/**
 * Subject confusion (the extraction bug): the card describes what *the agent*
 * does rather than a fact about the user or the project. Scoped to the start
 * of the card, because that is where a role description announces itself.
 */
const AGENT_VOICE =
  /^\s*(i am|i'm|i've|i |we are|we're|we |my |our |the agent|the assistant|the model|assistant|flexagent|claude|我|我们|助手|模型)/i

/** Restating something already in the system prompt every turn. */
const RESTATES_PROMPT = /^\s*(you are|system prompt|your role|我的角色|系统提示)/i

/** State that stops being true as soon as the run ends. */
const TRANSIENT =
  /(正在|刚才|当前这次|这一步|本次|临时|暂时|待办|todo\b|right now|currently|just now|in progress|for now)/i

export function lintCard(text: string): CardLintResult {
  const rejections: CardLint[] = []
  const warnings: CardLint[] = []

  if (SECRET_PREFIX.test(text)) {
    rejections.push({
      level: 'reject',
      rule: 'secret',
      message: 'looks like a credential. Memory cards are plain text and are injected into every turn — keep secrets in the environment, not here.'
    })
  } else if (SECRET_ASSIGNMENT.test(text)) {
    rejections.push({
      level: 'reject',
      rule: 'secret',
      message: 'looks like a key/value credential. Rephrase as a fact about how auth is configured, or drop it.'
    })
  }

  if (RESTATES_PROMPT.test(text)) {
    warnings.push({
      level: 'warn',
      rule: 'restates-prompt',
      message: 'this already ships in the system prompt every turn — a card here buys nothing but context cost.'
    })
  }

  if (AGENT_VOICE.test(text)) {
    warnings.push({
      level: 'warn',
      rule: 'subject-confusion',
      message: 'this describes what you (the agent) do, not a fact about the user or project. Memory cards are for the other side of the relationship.'
    })
  }

  if (TRANSIENT.test(text)) {
    warnings.push({
      level: 'warn',
      rule: 'transient',
      message: 'this reads like run state, not a durable fact. It will be false by the next session.'
    })
  }

  if (text.trim().length < 8) {
    warnings.push({
      level: 'warn',
      rule: 'too-short',
      message: 'too short to be retrievable later — say what is true about what.'
    })
  }

  return { rejections, warnings }
}

/** First rejection reason, for turning a lint failure into a tool/API error. */
export function firstRejection(lint: CardLintResult): CardLint | undefined {
  return lint.rejections[0]
}
