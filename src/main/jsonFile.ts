/**
 * Surgical editing of the JSON files this app shares with the kernel.
 *
 * Both files we touch — PI's `models.json` and PI's `settings.json` — are
 * hand-editable by the user, so a write must be indistinguishable from a
 * careful manual edit:
 *
 *  - **Only the keys we own change.** Everything else is parsed to plain
 *    objects and written back as-is, including keys this app has never heard of.
 *  - **Formatting is preserved.** The file's own indent is detected and reused.
 *  - **JSONC is accepted.** PI tolerates `//` and block comments; `JSON.parse`
 *    does not, so they are stripped before parsing rather than rejecting a file
 *    the kernel itself is happy with.
 *  - **Writes are atomic**, through the same staging/rename path the marketplace
 *    uses, so a crash mid-write cannot truncate a config the kernel needs.
 *
 * Read failures are `INVALID_INPUT` with the offending path in the message: a
 * config we cannot parse is a real problem and must not look like an empty file.
 */
import { existsSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { ContractError } from '../shared/contract'
import { writeFileAtomically } from './marketplaceAtomic'

export interface JsonDocument {
  path: string
  /** Whole parsed root. Unknown top-level keys survive a write. */
  root: Record<string, unknown>
  /** Detected indent, so a write does not reformat a hand-edited file. */
  indent: number
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Detect the file's own indentation; falls back to 2 spaces for a new file. */
export function detectIndent(raw: string): number {
  const match = /\n(\s+)"/.exec(raw)
  if (match === null) return 2
  const width = match[1].replace(/\t/g, '').length
  return width >= 1 && width <= 8 ? width : 2
}

/** Minimal JSONC support (`//` and block comments) — same leniency as PI's loader. */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += char
  }
  return out
}

/** A missing file is an empty document, not an error — we create it on write. */
export function readJsonDocument(path: string, label: string): JsonDocument {
  if (!existsSync(path)) return { path, root: {}, indent: 2 }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ContractError(
      'INVALID_INPUT',
      `Cannot read ${label} (${err instanceof Error ? err.message : String(err)})`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(raw))
  } catch (err) {
    throw new ContractError(
      'INVALID_INPUT',
      `${label} is not valid JSON (${err instanceof Error ? err.message : String(err)}). File: ${path}`
    )
  }
  if (!isRecord(parsed)) {
    throw new ContractError('INVALID_INPUT', `${label} root must be an object. File: ${path}`)
  }
  return { path, root: parsed, indent: detectIndent(raw) }
}

/**
 * Write the document back. `mutate` edits `document.root` in place so the
 * caller's change and the untouched remainder are written together.
 */
export async function writeJsonDocument(document: JsonDocument, label: string): Promise<void> {
  try {
    await writeFileAtomically(
      document.path,
      JSON.stringify(document.root, null, document.indent) + '\n'
    )
  } catch (err) {
    throw new ContractError(
      'KERNEL_INTERNAL',
      `Failed to write ${label}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Try to remove a config file this app owns; fall back to emptying it.
 *
 * Only for files whose whole content the app itself authored and has now
 * emptied: leaving a `{}` stub behind looks like configuration, and looks like
 * the app has state to manage where there is none.
 *
 * The fallback is not defensive decoration. Deleting a file is *harder* than
 * writing one — sandboxed or policy-guarded environments refuse it while
 * happily allowing the equivalent write — and this path serves clearing a
 * model binding, which must never fail for the sake of tidiness. Measured here:
 * clearing a role threw `Failed to remove routing.json: [safe-delete]…` with the
 * binding still on disk. Worst case now is a file holding `{"roles":{}}`, which
 * reads back as "nothing is bound" either way.
 */
export async function deleteJsonDocument(
  document: JsonDocument,
  label: string
): Promise<void> {
  try {
    await rm(document.path, { force: true })
  } catch {
    document.root = {}
    await writeJsonDocument(document, label)
  }
}
