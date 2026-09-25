import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { MemoryCardFile } from '../../shared/contract'
import { writeFileAtomic } from './skillHistory'

/**
 * Sidecar for the card store (v1.12).
 *
 * Timestamps and scope live here rather than in the markdown files. Putting
 * them on the card line — "- [2026-09-25] …" — would make the file stop being
 * whatever a human types into it, and would fold the metadata into the card's
 * own text: the id is the sha1 of the text, so a date in the text is a date in
 * the identity, and renaming a card would change its id and orphan every
 * reference to it.
 *
 * The trade-off is that hand-editing a card line no longer updates its
 * timestamp. That is the right way round: a fact the user rewrote by hand is
 * still the fact they wrote, and a stale timestamp on a hand-edited card makes
 * it *more* visible, not less.
 */

/** Where the markdown card files live. */
export const MEMORY_HOME = join(homedir(), '.flexagent', 'memory')

const SIDECAR = join(MEMORY_HOME, '.cards.json')

/** Card file name per store. Kept here so nothing imports the store for it. */
const CARD_FILES: Record<MemoryCardFile, string> = {
  MEMORY: 'MEMORY.md',
  USER: 'USER.md'
}

export function cardFileName(file: MemoryCardFile): string {
  const name = CARD_FILES[file]
  if (name === undefined) throw new Error(`unknown memory file: ${file}`)
  return name
}

export interface CardIndexEntry {
  created: number
  updated: number
  /** Working directory the card belongs to. Absent means "applies everywhere". */
  scope?: string
}

/** Per markdown file, then per card id. */
export type CardIndex = Record<string, Record<string, CardIndexEntry>>

type UnknownIndex = Record<string, unknown>

function isEntry(value: unknown): value is CardIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.created === 'number' && typeof entry.updated === 'number'
}

/**
 * Read the index. Any file that is missing, truncated or hand-broken degrades to
 * "no history" rather than an error: timestamps are an aid, and a store that
 * stops working because its metadata went bad is worse than one that lacks dates.
 */
export function loadCardIndex(): CardIndex {
  if (!existsSync(SIDECAR)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(SIDECAR, 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: CardIndex = {}
  for (const [fileName, section] of Object.entries(parsed as UnknownIndex)) {
    if (typeof section !== 'object' || section === null) continue
    const entries: Record<string, CardIndexEntry> = {}
    for (const [id, value] of Object.entries(section as UnknownIndex)) {
      if (isEntry(value)) entries[id] = value
    }
    if (Object.keys(entries).length > 0) out[fileName] = entries
  }
  return out
}

/** Write a whole section for one file, keeping every other section untouched. */
export function writeCardSection(fileName: string, section: Record<string, CardIndexEntry>): void {
  const index = loadCardIndex()
  if (Object.keys(section).length === 0) delete index[fileName]
  else index[fileName] = { ...index[fileName], ...section }
  mkdirSync(MEMORY_HOME, { recursive: true })
  writeFileAtomic(SIDECAR, `${JSON.stringify(index, null, 2)}\n`)
}

/** Entries for one file, keyed by card id. */
export function readCardSection(fileName: string): Record<string, CardIndexEntry> {
  return loadCardIndex()[fileName] ?? {}
}
