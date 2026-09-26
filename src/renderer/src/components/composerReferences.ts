/**
 * The reference list behind the Composer's `@`, selection and `#` picks.
 *
 * Three entry points drop "context" into a draft, and they disagree about what
 * they hold: an `@` path is a pointer the kernel may or may not resolve, a
 * selection is real text the user grabbed, and a `#` history chat is an excerpt
 * we can prove about that chat. Treating them as one shape with one limit is
 * how a limit becomes a lie, so every reference records what it actually is
 * (`kind`, `partial`) and the prompt block says so in words.
 *
 * The limits are enforced by REJECTING the new reference and explaining why.
 * Truncating instead would hand the model a sentence that never existed and
 * would hide the fact that the user picked something too big — a reference that
 * is silently shortened is worse than one that is refused, because the refusal
 * is visible and the truncation is not.
 */

/** Distinct pieces of context per message. Eight is already a lot of context. */
export const MAX_REFERENCES = 8
/** One selection or one chat excerpt. Past this a single pick stops being "a quote". */
export const MAX_REFERENCE_CHARS = 8_000
/**
 * Whole-draft ceiling. Counted in characters (UTF-16 units, i.e. what the
 * counter in the tray shows) so the number the user is warned about is the
 * number the limit acted on.
 */
export const MAX_TOTAL_REFERENCE_CHARS = 24_000

export type ContextReferenceKind = 'selection' | 'session'

export interface ContextReference {
  id: string
  kind: ContextReferenceKind
  /** Short label for the chip: "Assistant reply", "Tool output", the chat title. */
  label: string
  /** Exactly what the model will read. Never shortened — see the header. */
  text: string
  /** For a `#` pick: which chat this excerpt came from. */
  sessionId?: string
  /** For a `#` pick: when that chat was last touched, so the block can say. */
  sourceUpdatedAt?: number
  /**
   * Set when only part of what was picked could be collected (a history chat
   * whose transcript is not reachable from here). The chip and the prompt block
   * both say so, rather than the chip looking like a full quote.
   */
  partial?: boolean
  createdAt: number
}

export type AddReferenceResult =
  | { ok: true; references: ContextReference[] }
  | { ok: false; reason: string }

let referenceCounter = 0

function nextId(kind: ContextReferenceKind): string {
  referenceCounter += 1
  return `ref_${kind}_${referenceCounter}`
}

/**
 * Identity used for duplicate detection. Re-picking the same paragraph or the
 * same chat is a no-op the user can see, not a stack of copies.
 */
function referenceKey(reference: ContextReference): string {
  return reference.sessionId !== undefined
    ? `session:${reference.sessionId}`
    : `selection:${reference.text.trim()}`
}

export function countReferenceChars(references: readonly ContextReference[]): number {
  let total = 0
  for (const reference of references) total += reference.text.length
  return total
}

/** Long strings in a chip: the full value stays in the tooltip. */
export function truncateLabel(label: string, max = 42): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`
}

function shortDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'unknown date'
  return new Date(ts).toISOString().slice(0, 10)
}

export function createSelectionReference(text: string, label: string): ContextReference {
  const trimmed = text.replace(/\s+$/, '')
  return {
    id: nextId('selection'),
    kind: 'selection',
    label,
    text: trimmed,
    createdAt: Date.now()
  }
}

/**
 * One history chat, as far as the renderer can prove it.
 *
 * `snippet` is the only part of another transcript the current contract ever
 * returns; without it there is a title and a date and nothing else. `partial`
 * records which case this is so the UI cannot dress a title up as a quote.
 */
export function createSessionReference(input: {
  sessionId: string
  title: string
  snippet?: string
  updatedAt?: number
}): ContextReference {
  const label = input.title.length > 0 ? input.title : 'Untitled chat'
  const snippet = input.snippet ?? ''
  const text =
    snippet.length > 0
      ? snippet
      : `Title only: “${label}”. The transcript of this chat is not reachable from here, so this references the chat, not its content.`
  return {
    id: nextId('session'),
    kind: 'session',
    label,
    text,
    sessionId: input.sessionId,
    sourceUpdatedAt: input.updatedAt,
    // A title-only pick is partial by definition: there is no content behind it.
    ...(snippet.length === 0 ? { partial: true } : {}),
    createdAt: Date.now()
  }
}

/**
 * Append `candidate` to `existing`, or refuse it with a reason the UI can show.
 * `existing` is never mutated and never trimmed: a rejection that quietly
 * shortened the previous references would break the draft the user wrote.
 */
export function addReference(
  existing: readonly ContextReference[],
  candidate: ContextReference
): AddReferenceResult {
  const key = referenceKey(candidate)
  for (const reference of existing) {
    if (referenceKey(reference) === key) {
      return {
        ok: false,
        reason: `“${truncateLabel(reference.label)}” is already in this draft — pick something else.`
      }
    }
  }
  if (candidate.text.length > MAX_REFERENCE_CHARS) {
    return {
      ok: false,
      reason: `That piece is ${candidate.text.length} characters; one reference holds at most ${MAX_REFERENCE_CHARS}. Select a smaller piece — nothing was added.`
    }
  }
  const total = countReferenceChars(existing)
  if (total + candidate.text.length > MAX_TOTAL_REFERENCE_CHARS) {
    return {
      ok: false,
      reason: `References already hold ${total} of ${MAX_TOTAL_REFERENCE_CHARS} characters. Remove one first — nothing was added.`
    }
  }
  if (existing.length >= MAX_REFERENCES) {
    return {
      ok: false,
      reason: `This draft already carries ${MAX_REFERENCES} references. Remove one first — nothing was added.`
    }
  }
  return { ok: true, references: [...existing, candidate] }
}

/**
 * The prompt block for one message.
 *
 * Delimiters are plain ASCII on their own lines so a quote containing markdown
 * or `---` cannot be mistaken for a boundary, and so the block survives any
 * rendering the agent does with the text afterwards.
 */
export function formatReferencesBlock(references: readonly ContextReference[]): string {
  const parts: string[] = []
  for (const reference of references) {
    const text = reference.text.replace(/^\s+|\s+$/g, '')
    if (text.length === 0) continue
    if (reference.kind === 'session') {
      const header = `referenced chat: “${reference.label}” · ${shortDate(
        reference.sourceUpdatedAt ?? reference.createdAt
      )}`
      parts.push(`--- ${header} ---\n${text}\n--- end ${header} ---`)
    } else {
      const header = `referenced: ${reference.label}`
      parts.push(`--- ${header} ---\n${text}\n--- end ${header} ---`)
    }
  }
  return parts.join('\n')
}
