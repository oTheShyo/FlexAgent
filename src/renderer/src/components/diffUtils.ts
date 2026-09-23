export type DiffRowKind = 'add' | 'del' | 'ctx' | 'hunk'

export interface DiffRow {
  kind: DiffRowKind
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface ParsedPatch {
  rows: DiffRow[]
  additions: number
  deletions: number
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Parse a unified-diff patch string into renderable rows with line numbers.
 * Lines outside hunk bodies (diff headers, ---/+++ file markers) are skipped.
 */
export function parsePatch(patch: string): ParsedPatch {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false

  for (const line of patch.split(/\r?\n/)) {
    if (!inHunk) {
      const match = HUNK_HEADER_RE.exec(line)
      if (match) {
        inHunk = true
        oldNo = Number.parseInt(match[1], 10)
        newNo = Number.parseInt(match[2], 10)
        rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line })
      }
      continue
    }

    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — display-only, no line-number movement.
      continue
    }
    if (line.startsWith('@@')) {
      const match = HUNK_HEADER_RE.exec(line)
      if (match) {
        oldNo = Number.parseInt(match[1], 10)
        newNo = Number.parseInt(match[2], 10)
        rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line })
        continue
      }
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', oldNo: null, newNo, text: line.slice(1) })
      newNo += 1
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldNo, newNo: null, text: line.slice(1) })
      oldNo += 1
    } else if (line.startsWith(' ') || line.length === 0) {
      rows.push({ kind: 'ctx', oldNo, newNo, text: line.slice(1) })
      oldNo += 1
      newNo += 1
    } else {
      // Any other header (e.g. "diff --git", "index …") ends the hunk body.
      inHunk = false
    }
  }

  let additions = 0
  let deletions = 0
  for (const row of rows) {
    if (row.kind === 'add') additions += 1
    else if (row.kind === 'del') deletions += 1
  }

  return { rows, additions, deletions }
}
