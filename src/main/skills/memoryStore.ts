import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ContractError } from '../../shared/contract'
import type { MemoryCard, MemoryCardFile, MemoryCardRef } from '../../shared/contract'
import { firstRejection, lintCard } from './memoryLint'

/**
 * Agent-curated memory cards (Hermes-aligned, M3; hardened in v1.10).
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
 */

export const MEMORY_HOME = join(homedir(), '.flexagent', 'memory')

const FILES: Record<MemoryCardFile, string> = {
  MEMORY: 'MEMORY.md',
  USER: 'USER.md'
}

const CARD_RE = /^-\s?(.*)$/

function filePath(file: MemoryCardFile): string {
  if (!(file in FILES)) {
    throw new ContractError('INVALID_INPUT', 'file must be MEMORY or USER')
  }
  return join(MEMORY_HOME, FILES[file])
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

function isCardLine(line: string): boolean {
  return CARD_RE.test(line) && line.trim().length > 1
}

function cardText(line: string): string {
  return (line.match(CARD_RE)?.[1] ?? '').trim()
}

export function listMemoryCards(): MemoryCard[] {
  const out: MemoryCard[] = []
  for (const file of ['MEMORY', 'USER'] as MemoryCardFile[]) {
    const path = filePath(file)
    if (!existsSync(path)) continue
    let cardIndex = 0
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!isCardLine(line)) continue
      const text = cardText(line)
      if (text.length > 0) {
        out.push({ file, index: cardIndex, id: cardId(text), text })
      }
      cardIndex += 1
    }
  }
  return out
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
export function addMemoryCard(file: MemoryCardFile, text: string): AddCardResult {
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

  const id = cardId(trimmed)
  const warnings = lint.warnings.map((w) => `${w.rule}: ${w.message}`)
  const path = filePath(file)
  ensureFile(path)
  const card = `- ${trimmed}`
  const existing = readFileSync(path, 'utf8')
  // Identical text ⇒ identical id ⇒ nothing to write.
  if (existing.split(/\r?\n/).some((line) => isCardLine(line) && cardId(cardText(line)) === id)) {
    return { id, text: trimmed, written: false, warnings }
  }
  const needsNewline = existing.length > 0 && !existing.endsWith('\n')
  writeFileSync(path, `${existing}${needsNewline ? '\n' : ''}${card}\n`, 'utf8')
  return { id, text: trimmed, written: true, warnings }
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
  if (typeof ref === 'string') {
    if (ref.length === 0) {
      throw new ContractError('INVALID_INPUT', 'card id must be a non-empty string')
    }
  } else if (!Number.isInteger(ref) || ref < 0) {
    throw new ContractError(
      'INVALID_INPUT',
      'card reference must be an id string or a non-negative integer index'
    )
  }

  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const cardLineIndexes = lines.map((line, i) => (isCardLine(line) ? i : -1)).filter((i) => i >= 0)

  let target = -1
  if (typeof ref === 'string') {
    const hit = cardLineIndexes.find((i) => cardId(cardText(lines[i]!)) === ref)
    if (hit === undefined) {
      throw new ContractError('INVALID_INPUT', `no card with id ${ref} in ${file}`)
    }
    target = hit
  } else {
    if (ref >= cardLineIndexes.length) {
      throw new ContractError(
        'INVALID_INPUT',
        `card index ${ref} out of range (0..${cardLineIndexes.length - 1})`
      )
    }
    target = cardLineIndexes[ref]!
  }

  lines.splice(target, 1)
  writeFileSync(path, lines.join('\n'), 'utf8')
}
