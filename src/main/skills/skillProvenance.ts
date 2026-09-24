import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { SkillProvenance } from '../../shared/contract'

/**
 * Install provenance (v1.9): every user skill installed through FlexAgent
 * carries a `.flexagent-source.json` inside its own directory.
 *
 * The record answers three questions the UI needs and the filesystem cannot:
 * - origin: which hub / source string / folder produced this directory
 * - revision: which ref was pinned, and which ref the downloader resolved to
 * - integrity: a content hash, so local edits and upstream drift are visible
 *
 * No network round trip is involved. GitHub's anonymous quota is 60 req/h, so
 * provenance cannot be re-derived later on demand — it has to be captured at
 * install time.
 */
export const PROVENANCE_FILE = '.flexagent-source.json'

export function readProvenance(dir: string): SkillProvenance | undefined {
  const file = join(dir, PROVENANCE_FILE)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Partial<SkillProvenance>
    if (typeof record.kind !== 'string' || typeof record.installedAt !== 'number') {
      return undefined
    }
    return record as SkillProvenance
  } catch {
    // A corrupt sidecar must never break skill listing.
    return undefined
  }
}

export async function writeProvenance(dir: string, record: SkillProvenance): Promise<void> {
  await writeFile(join(dir, PROVENANCE_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

/**
 * sha256 over the skill tree: sorted relative paths plus file contents.
 * The provenance sidecar is excluded so writing it never changes the hash it
 * records.
 */
export async function computeTreeHash(dir: string): Promise<string> {
  const digest = createHash('sha256')
  for (const file of await collectFiles(dir)) {
    digest.update(`${file}\0`)
    digest.update(await readFile(join(dir, file)))
  }
  return digest.digest('hex')
}

async function collectFiles(root: string, dir = ''): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = dir.length > 0 ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      out.push(...(await collectFiles(root, rel)))
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name === PROVENANCE_FILE) continue
    out.push(rel)
  }
  return out.sort()
}

/** True when the record carries enough to re-resolve and re-install. */
export function isReinstallable(record: SkillProvenance | undefined): boolean {
  if (record === undefined) return false
  if (record.kind === 'agent') return false
  if (record.kind === 'folder') return record.folderPath !== undefined && record.folderPath.length > 0
  return record.source !== undefined && record.source.length > 0
}
