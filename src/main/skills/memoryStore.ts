import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ContractError } from '../../shared/contract'
import type { MemoryCard, MemoryCardFile } from '../../shared/contract'

/**
 * Agent-curated memory cards (Hermes-aligned, M3).
 *
 * Two markdown files hold small persistent facts:
 * - MEMORY.md — facts that should survive across sessions ("the runtime config
 *   lives in …", "the user prefers table output").
 * - USER.md   — who the user is and how they work.
 *
 * Cards are `- text` list lines; everything else in the file is preserved
 * untouched (headers, blank lines, free-form notes).
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

export function listMemoryCards(): MemoryCard[] {
  const out: MemoryCard[] = []
  for (const file of ['MEMORY', 'USER'] as MemoryCardFile[]) {
    const path = filePath(file)
    if (!existsSync(path)) continue
    const indexByCard = new Map<string, number>()
    let cardIndex = 0
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!isCardLine(line)) continue
      indexByCard.set(line, cardIndex)
      const text = (line.match(CARD_RE)?.[1] ?? '').trim()
      if (text.length > 0) {
        out.push({ file, index: cardIndex, text })
      }
      cardIndex += 1
    }
  }
  return out
}

export function addMemoryCard(file: MemoryCardFile, text: string): MemoryCard {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new ContractError('INVALID_INPUT', 'card text must be a non-empty string')
  }
  if (trimmed.length > 2000) {
    throw new ContractError('INVALID_INPUT', 'card text is too long (max 2000 chars)')
  }
  const path = filePath(file)
  ensureFile(path)
  const card = `- ${trimmed.replace(/\s*\r?\n\s*/g, ' ')}`
  const existing = readFileSync(path, 'utf8')
  // Duplicate suppression: identical card text is a no-op (MemoryStore folds
  // byte-identical entries — Hermes semantics).
  if (existing.split(/\r?\n/).some((line) => line.trim() === card.trim())) {
    return { file, index: -1, text: trimmed }
  }
  const needsNewline = existing.length > 0 && !existing.endsWith('\n')
  writeFileSync(path, `${existing}${needsNewline ? '\n' : ''}${card}\n`, 'utf8')
  return { file, index: listMemoryCards().filter((card2) => card2.file === file).length - 1, text: trimmed }
}

export function removeMemoryCard(file: MemoryCardFile, index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new ContractError('INVALID_INPUT', 'index must be a non-negative integer')
  }
  const path = filePath(file)
  if (!existsSync(path)) {
    throw new ContractError('INVALID_INPUT', `no memory cards in ${file}`)
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const cardLineIndexes = lines
    .map((line, i) => (isCardLine(line) ? i : -1))
    .filter((i) => i >= 0)
  if (index >= cardLineIndexes.length) {
    throw new ContractError('INVALID_INPUT', `card index ${index} out of range (0..${cardLineIndexes.length - 1})`)
  }
  lines.splice(cardLineIndexes[index]!, 1)
  writeFileSync(path, lines.join('\n'), 'utf8')
}
