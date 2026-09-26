/**
 * Automatic memory extraction (issue 15).
 *
 * ZCode's project memory works like this: when a turn ends well, look back at
 * what just happened and keep only what will still be true next week. This
 * module is that pass.
 *
 * What it deliberately does NOT remember:
 *  - code structure and git history (re-readable at any time);
 *  - anything already in the project instruction file;
 *  - facts that only hold for the current turn ("the failing test is X").
 *
 * A turn with nothing worth keeping must cost nothing beyond one small model
 * call, so the prompt asks for an empty list by default and the caller treats
 * "no candidates" as the normal case, not a failure.
 */
import { findLocalDuplicate } from './memoryDedupe'
import { listMemoryCards } from './memoryStore'

/** Four kinds of fact, in the order the prompt lists them. */
export const MEMORY_FACT_CATEGORIES = [
  'user preference (how the user wants work done)',
  'a correction to how the agent works',
  'project goal or constraint',
  'external material the user supplied'
] as const

/** Below this, a turn is too thin to contain a durable fact. */
const MIN_TRANSCRIPT_CHARS = 40
/** The prompt is a summariser, not a summariser of the whole repo. */
const MAX_TRANSCRIPT_CHARS = 4000
const MAX_CARDS_PER_TURN = 3

export interface ExtractTranscript {
  userText: string
  assistantText: string
}

/**
 * Whether the pass is worth the model call at all. A one-word turn, or a turn
 * the assistant spent entirely in tool calls, has nothing to distil — asking
 * anyway would be paying for a model to say "no".
 */
export function shouldExtract(transcript: ExtractTranscript): boolean {
  const total = transcript.userText.trim().length + transcript.assistantText.trim().length
  return total >= MIN_TRANSCRIPT_CHARS
}

function clip(text: string, budget: number): string {
  const trimmed = text.trim()
  return trimmed.length <= budget ? trimmed : `${trimmed.slice(0, budget)}…`
}

export function buildExtractPrompt(transcript: ExtractTranscript): string {
  const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2)
  return [
    'A coding assistant just finished a turn with a user. Decide whether anything',
    'from it is worth remembering for future sessions in the same project.',
    '',
    'Keep only facts in one of these four kinds:',
    ...MEMORY_FACT_CATEGORIES.map((category) => `  - ${category}`),
    '',
    'Do not keep: code structure, file layout, git history, anything already in an',
    'instruction file, or anything that only held for this turn.',
    '',
    'Reply with JSON only, no prose, in exactly this shape:',
    '{"facts": ["one sentence, self-contained", "..."]}',
    'Use an empty list when there is nothing worth keeping. At most',
    `${MAX_CARDS_PER_TURN} facts. Never include secrets, keys or tokens.`,
    '',
    '--- user ---',
    clip(transcript.userText, half),
    '',
    '--- assistant ---',
    clip(transcript.assistantText, half)
  ].join('\n')
}

/**
 * Parse the model's reply. Anything that is not a clean JSON object with a
 * string array is treated as "no facts": a half-parsed card is worse than no
 * card, because it lands in a file the user cannot easily audit.
 */
export function parseExtractReply(raw: string): string[] {
  const text = raw.trim()
  if (!text) return []
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const facts = (parsed as { facts?: unknown }).facts
  if (!Array.isArray(facts)) return []
  const out: string[] = []
  for (const item of facts) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    // One sentence per card: a card that reads like a paragraph stops being
    // scannable, which is the whole point of the format.
    if (trimmed.length === 0 || trimmed.length > 400) continue
    out.push(trimmed)
    if (out.length >= MAX_CARDS_PER_TURN) break
  }
  return out
}

export interface MemoryExtractDeps {
  /** One small-model call. Returns the raw reply text, or null if unavailable. */
  complete: (systemPrompt: string, userContent: string, maxTokens: number) => Promise<string | null>
  /** Semantic duplicate check; null means "no duplicate". Optional on purpose. */
  judgeDuplicate?: (text: string, candidates: string[]) => Promise<number | null>
  /** Write the card through the same store the agent-facing tool uses. */
  addCard: (text: string, scope?: string) => { written: boolean; id: string }
  /** Where the card belongs, so a project fact does not follow the user home. */
  scope?: string
  observe?: (info: { ok: boolean; durationMs: number; note?: string }) => void
  /** Overridable for tests; defaults to the real card list. */
  existingCards?: () => string[]
  log?: (message: string) => void
}

export interface MemoryExtractOutcome {
  /** Cards actually written to disk (0 is the common case). */
  written: number
  /** Candidates the model proposed, before dedupe. */
  candidates: number
  skipped: 'no-content' | 'unavailable' | 'none'
}

const SYSTEM_PROMPT = [
  'You distil a conversation turn into durable memory cards for a coding agent.',
  'Reply with JSON only. Prefer an empty list over a speculative card:',
  'a wrong fact is remembered forever, a missing one is just asked again.'
].join(' ')

/**
 * Run the pass. Never throws: a background pass that can take the session down
 * is worse than a pass that silently wrote nothing.
 */
export async function runMemoryExtraction(
  transcript: ExtractTranscript,
  deps: MemoryExtractDeps
): Promise<MemoryExtractOutcome> {
  const started = Date.now()
  const finish = (outcome: MemoryExtractOutcome): MemoryExtractOutcome => {
    deps.observe?.({
      ok: outcome.skipped === 'none',
      durationMs: Date.now() - started,
      note: `${outcome.candidates} candidate(s), ${outcome.written} written, skipped=${outcome.skipped}`
    })
    return outcome
  }

  if (!shouldExtract(transcript)) return finish({ written: 0, candidates: 0, skipped: 'no-content' })

  let raw: string | null = null
  try {
    raw = await deps.complete(SYSTEM_PROMPT, buildExtractPrompt(transcript), 400)
  } catch (err) {
    deps.log?.(`memory extraction failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (raw === null) return finish({ written: 0, candidates: 0, skipped: 'unavailable' })

  const facts = parseExtractReply(raw)
  if (facts.length === 0) return finish({ written: 0, candidates: 0, skipped: 'none' })

  const existing = deps.existingCards?.() ?? listMemoryCards().map((card) => card.text)
  let written = 0
  for (const fact of facts) {
    // Cheap check first: the semantic judge is a model call, and a card that is
    // already on disk verbatim does not need one.
    if (findLocalDuplicate(fact, existing) !== undefined) continue
    if (deps.judgeDuplicate !== undefined) {
      let duplicate: number | null = null
      try {
        duplicate = await deps.judgeDuplicate(fact, existing)
      } catch {
        duplicate = null
      }
      if (duplicate !== null) continue
    }
    try {
      const result = deps.addCard(fact, deps.scope)
      if (result.written) {
        written += 1
        existing.push(fact)
      }
    } catch (err) {
      // A card the lint rejects (a credential, a path, a secret-shaped string)
      // is a near-miss worth a line in the log, not a failure of the pass.
      deps.log?.(`memory card rejected: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return finish({ written, candidates: facts.length, skipped: 'none' })
}
