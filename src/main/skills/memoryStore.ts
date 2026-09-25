import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ContractError } from '../../shared/contract'
import type { MemoryCard, MemoryCardFile, MemoryCardRef } from '../../shared/contract'
import { firstRejection, lintCard } from './memoryLint'
import { cardFileName, MEMORY_HOME, readCardSection, writeCardSection, type CardIndexEntry } from './memoryIndex'

/**
 * Agent-curated memory cards (Hermes-aligned, M3; hardened in v1.10, made
 * batch-atomic as part of the same pass).
 *
 * Two markdown files hold small persistent facts:
 * - MEMORY.md — facts that should survive across sessions ("the runtime config
 *   lives in …", "the user prefers table output").
 * - USER.md   — who the user is and how they work.
 *
 * Cards are `- text` list lines; everything else in the file is preserved
 * untouched (headers, blank lines, free-form notes) so the files stay pleasant
 * to open by hand.
 *
 * Identity is derived from content rather than written into the file: a store
 * that required an ID column would stop being hand-editable, and hand-editing
 * is the property worth protecting here.
 *
 * Writes go through `applyMemoryWrites`, never straight to disk. A run that
 * "removes" a card and "adds" its replacement must not be able to land in the
 * state where one half succeeded and the other did not: the discarded half is
 * now an unrecoverable lost fact, and that is the failure mode a memory store
 * cannot come back from. So every write against one file is planned against the
 * in-memory lines and committed with a single `writeFileSync`.
 */

const CARD_RE = /^-\s?(.*)$/

// Re-exported for the extension, which builds the "cards live in …" header.
export { MEMORY_HOME }

function filePath(file: MemoryCardFile): string {
  return join(MEMORY_HOME, cardFileName(file))
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * Stable id for a card's text. Whitespace- and case-insensitive, so restating a
 * fact with different spacing still collapses onto the same card rather than
 * accumulating near-identical duplicates.
 */
export function cardId(text: string): string {
  return createHash('sha1').update(normalizeText(text).toLowerCase()).digest('hex').slice(0, 10)
}

function ensureFile(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(MEMORY_HOME, { recursive: true })
    writeFileSync(
      path,
      `# ${path.endsWith('MEMORY.md') ? 'Long-term memory' : 'User profile'}\n\nCurated by the FlexAgent agent via memory_manage. Cards are "- " list lines.\n`,
      'utf8'
    )
  }
}

export function isCardLine(line: string): boolean {
  return CARD_RE.test(line) && line.trim().length > 1
}

export function cardText(line: string): string {
  return (line.match(CARD_RE)?.[1] ?? '').trim()
}

function cardIdAt(lines: string[], index: number): string {
  return cardId(cardText(lines[index]!))
}

export function listMemoryCards(): MemoryCard[] {
  const out: MemoryCard[] = []
  for (const file of ['MEMORY', 'USER'] as MemoryCardFile[]) {
    const path = filePath(file)
    if (!existsSync(path)) continue
    const meta = readCardSection(cardFileName(file))
    let cardIndex = 0
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!isCardLine(line)) continue
      const text = cardText(line)
      if (text.length > 0) {
        const entry = meta[cardId(text)]
        out.push({
          file,
          index: cardIndex,
          id: cardId(text),
          text,
          ...(entry?.created !== undefined ? { createdAt: entry.created } : {}),
          ...(entry?.updated !== undefined ? { updatedAt: entry.updated } : {}),
          ...(entry?.scope !== undefined ? { scope: entry.scope } : {})
        })
      }
      cardIndex += 1
    }
  }
  return out
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export type MemoryWriteKind = 'add' | 'update' | 'remove'

export interface MemoryWrite {
  kind: MemoryWriteKind
  file: MemoryCardFile
  /** add/update: the card text. Ignored by remove. */
  text?: string
  /** update/remove: locates the existing card — id (preferred) or current index. */
  ref?: MemoryCardRef
  /** add/update: working directory this card belongs to. Absent = applies to any. */
  scope?: string
}

export interface MemoryWriteResult {
  kind: MemoryWriteKind
  file: MemoryCardFile
  /** Id of the card as it is on disk afterwards (the removed one, for remove). */
  id: string
  /** False when nothing changed: no target matched, or the text was identical. */
  changed: boolean
  warnings: string[]
}

/**
 * Metadata for a write that will land, keyed by the id it will have on disk.
 *
 * An edit carries its predecessor's creation date forward — the card is the same
 * note being corrected, not a new one — and inherits scope unless the writer
 * said otherwise, because "keep this only for that project" is a decision about
 * the new text, not about the old card.
 */
function metaForWrite(
  file: MemoryCardFile,
  write: MemoryWrite,
  id: string,
  previous?: CardIndexEntry
): CardIndexEntry {
  const now = Date.now()
  const inherited: CardIndexEntry = previous ?? { created: now, updated: now }
  return {
    created: inherited.created ?? now,
    updated: now,
    ...(write.scope !== undefined ? { scope: write.scope } : {}),
    ...(write.scope === undefined && inherited.scope !== undefined ? { scope: inherited.scope } : {})
  }
}

function cardLineIndexes(lines: string[]): number[] {
  const out: number[] = []
  lines.forEach((line, i) => {
    if (isCardLine(line)) out.push(i)
  })
  return out
}

/**
 * Apply every write to one file in order, then commit with a single write.
 *
 * Two passes on purpose. `update` and `remove` rewrite existing lines in place;
 * `add` can only append. Interleaving adds would put a line on disk that a later
 * `remove` in the same batch is trying to delete, leaving the batch resurrecting
 * the very card it was told to drop. Doing the destructive pass over the lines
 * first, then appending, makes "add X, remove X" a no-op no matter which order
 * the model called them in.
 */
function applyToFile(file: MemoryCardFile, writes: MemoryWrite[]): MemoryWriteResult[] {
  const path = filePath(file)
  ensureFile(path)
  const original = readFileSync(path, 'utf8')
  const lines = original.split(/\r?\n/)
  const results: MemoryWriteResult[] = []

  /** Cards already cut out of `lines` by this batch. */
  const dropped = new Set<string>()
  /** Old id → new id, so a second edit in the same batch can still find it. */
  const rewritten = new Map<string, string>()
  /**
   * References this batch was told to delete. Some of them point at cards that
   * are only added later in the pass — that still counts as "remove it", and the
   * add has to be dropped or the pair writes the card back after deleting it.
   */
  const removeRefs = new Set<string>()
  const removeIndexes = new Set<number>()
  const pendingAdds: { id: string; line: string; scope?: string }[] = []
  /** Id → metadata after this batch. */
  const metaUpdates = new Map<string, CardIndexEntry>()
  /** Ids whose metadata is now wrong (replaced or deleted cards). */
  const metaDrops = new Set<string>()

  const locate = (ref: MemoryCardRef): number | undefined => {
    const indexes = cardLineIndexes(lines)
    if (typeof ref === 'number') {
      return ref >= 0 && ref < indexes.length ? indexes[ref] : undefined
    }
    const direct = indexes.find((i) => cardIdAt(lines, i) === ref)
    if (direct !== undefined) return direct
    const replacement = rewritten.get(ref)
    return replacement === undefined ? undefined : indexes.find((i) => cardIdAt(lines, i) === replacement)
  }

  const unchanged = (kind: MemoryWriteKind, id: string, warning: string): void => {
    results.push({ kind, file, id, changed: false, warnings: warning.length > 0 ? [warning] : [] })
  }

  for (const write of writes) {
    if (write.kind === 'add') continue

    const ref = write.ref
    if (ref === undefined) {
      unchanged(write.kind, '', `${write.kind} requires a card reference (id or index)`)
      continue
    }

    if (write.kind === 'remove') {
      const index = locate(ref)
      if (index === undefined) {
        // The card is not on disk yet — it may be added later in this batch, and
        // then this removal must cancel that add.
        const label = typeof ref === 'string' ? ref : String(ref)
        if (typeof ref === 'string') removeRefs.add(ref)
        else removeIndexes.add(ref)
        unchanged('remove', label, 'nothing to remove — the target is not on disk yet')
        continue
      }
      const id = cardIdAt(lines, index)
      lines.splice(index, 1)
      dropped.add(id)
      rewritten.delete(id)
      metaDrops.add(id)
      results.push({ kind: 'remove', file, id, changed: true, warnings: [] })
      continue
    }

    // update
    const text = normalizeText(write.text ?? '')
    if (text.length === 0) {
      unchanged('update', typeof ref === 'string' ? ref : String(ref), 'card text must not be empty')
      continue
    }
    const index = locate(ref)
    if (index === undefined) {
      // The card being replaced is gone (hand-edited away, or removed earlier in
      // this batch). Store the text rather than drop it: a lost fact is the one
      // outcome worth avoiding, and the warning says what happened.
      const id = cardId(text)
      pendingAdds.push({ id, line: `- ${text}`, scope: write.scope })
      results.push({
        kind: 'update',
        file,
        id,
        changed: true,
        warnings: [
          `reference ${String(ref)} matched nothing, so this was stored as a new card — check memory_manage list`
        ]
      })
      continue
    }
    const oldId = cardIdAt(lines, index)
    if (cardId(text) === oldId) {
      unchanged('update', oldId, '')
      continue
    }
    lines[index] = `- ${text}`
    const newId = cardId(text)
    dropped.delete(oldId)
    rewritten.set(oldId, newId)
    metaUpdates.set(newId, metaForWrite(file, write, newId, readCardSection(cardFileName(file))[oldId]))
    metaDrops.add(oldId)
    results.push({ kind: 'update', file, id: newId, changed: true, warnings: [] })
  }

  for (const write of writes) {
    if (write.kind !== 'add') continue
    const text = normalizeText(write.text ?? '')
    if (text.length === 0) {
      unchanged('add', '', 'card text must not be empty')
      continue
    }
    const id = cardId(text)
    // Removed earlier in this same batch: the net effect is nothing written.
    // Without this the pair would delete the card and then append it straight
    // back, which is worse than doing neither.
    if (removeRefs.has(id) || removeIndexes.has(pendingAdds.length)) {
      unchanged('add', id, 'this card was removed earlier in the same batch — nothing stored')
      continue
    }
    if (dropped.has(id)) {
      // Removed then re-added with identical text: net effect is nothing.
      unchanged('add', id, '')
      continue
    }
    if (cardLineIndexes(lines).some((i) => cardIdAt(lines, i) === id)) {
      unchanged('add', id, '')
      continue
    }
    pendingAdds.push({ id, line: `- ${text}`, scope: write.scope })
    results.push({ kind: 'add', file, id, changed: true, warnings: [] })
  }

  const next = [...lines, ...pendingAdds.map((item) => item.line)].join('\n')
  if (next !== original) writeFileSync(path, next, 'utf8')

  // Metadata is committed with the lines, not before them: a card that never
  // reached disk must not end up with a creation date.
  if (pendingAdds.length > 0 || metaUpdates.size > 0 || metaDrops.size > 0) {
    const section = readCardSection(cardFileName(file))
    for (const id of metaDrops) delete section[id]
    for (const [id, entry] of metaUpdates) section[id] = entry
    if (pendingAdds.length > 0) {
      for (const add of pendingAdds) {
        section[add.id] = metaForWrite(file, { kind: 'add', file, scope: add.scope }, add.id, section[add.id])
      }
    }
    writeCardSection(cardFileName(file), section)
  }
  return results
}

/** Apply every write against its own file; each file is committed once. */
export function applyMemoryWrites(writes: MemoryWrite[]): MemoryWriteResult[] {
  if (writes.length === 0) return []
  const groups = new Map<MemoryCardFile, MemoryWrite[]>()
  for (const write of writes) {
    const bucket = groups.get(write.file)
    if (bucket !== undefined) bucket.push(write)
    else groups.set(write.file, [write])
  }
  const results: MemoryWriteResult[] = []
  for (const [file, group] of groups) results.push(...applyToFile(file, group))
  return results
}

export interface AddCardResult {
  id: string
  text: string
  /** False when an identical card was already present — nothing was written. */
  written: boolean
  warnings: string[]
}

/**
 * Append a card. Rejects what a card must never contain (see memoryLint) and
 * returns advisory warnings rather than silently accepting everything.
 */
export function addMemoryCard(file: MemoryCardFile, text: string, scope?: string): AddCardResult {
  const trimmed = normalizeText(text)
  if (trimmed.length === 0) {
    throw new ContractError('INVALID_INPUT', 'card text must be a non-empty string')
  }
  if (trimmed.length > 2000) {
    throw new ContractError('INVALID_INPUT', 'card text is too long (max 2000 chars)')
  }
  const lint = lintCard(trimmed)
  const rejection = firstRejection(lint)
  if (rejection !== undefined) {
    throw new ContractError(
      'INVALID_INPUT',
      `memory card rejected (${rejection.rule}): ${rejection.message}`
    )
  }
  const warnings = lint.warnings.map((w) => `${w.rule}: ${w.message}`)
  const [result] = applyMemoryWrites([{ kind: 'add', file, text: trimmed, scope }])
  return { id: result.id, text: trimmed, written: result.changed, warnings }
}

/**
 * Remove a card by id (`string`) or by position (`number`).
 *
 * Prefer the id: it survives intervening removals, whereas an index captured a
 * few turns ago silently points at a different line once something above it is
 * deleted. The numeric form is kept because that is what shipped in v1.7.
 */
export function removeMemoryCard(file: MemoryCardFile, ref: MemoryCardRef): void {
  const path = filePath(file)
  if (!existsSync(path)) {
    throw new ContractError('INVALID_INPUT', `no memory cards in ${file}`)
  }
  const [result] = applyMemoryWrites([{ kind: 'remove', file, ref }])
  if (!result.changed) {
    const total = cardLineIndexes(readFileSync(path, 'utf8').split(/\r?\n/)).length
    const message =
      typeof ref === 'string'
        ? `no card with id ${ref} in ${file}`
        : `card index ${ref} out of range (0..${total - 1})`
    throw new ContractError('INVALID_INPUT', message)
  }
}
