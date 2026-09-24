import { existsSync, readFileSync, statSync } from 'fs'
import type { SessionSearchHit, SessionId } from '../../shared/contract'

/**
 * Cross-session history search (Hermes-aligned, M3 — degraded transport).
 *
 * Hermes runs SQLite FTS5 with a custom CJK bigram tokenizer; until FlexAgent
 * needs that scale, a bounded LIKE-style substring scan over the stored PI
 * session files (JSONL) is enough: registries hold dozens, not millions, of
 * sessions. The scan caps file size and session count so a huge library
 * degrades latency, not correctness.
 */

const MAX_SESSIONS = 300
const MAX_FILE_BYTES = 4 * 1024 * 1024
const SNIPPET_CONTEXT = 90
const MAX_HITS = 20

export interface SessionRecordLike {
  id: SessionId
  title: string
  updatedAt: number
  piSessionFile?: string
}

interface ExtractedMessage {
  role: string
  text: string
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          !!block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
      )
      .map((block) => block.text)
      .join('')
  }
  return ''
}

/** PI session files are JSONL; message entries carry {message:{role,content}} (shape varies by PI version). */
function extractMessages(line: string): ExtractedMessage[] {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return []
  }
  if (obj === null || typeof obj !== 'object') return []
  const record = obj as Record<string, unknown>
  const candidates: unknown[] = [record, record.message]
  const out: ExtractedMessage[] = []
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    const message = candidate as { role?: unknown; content?: unknown }
    const role = message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = extractText(message.content)
    if (text.length > 0) out.push({ role, text })
  }
  return out
}

function snippetAround(text: string, lowerQuery: string): string | null {
  const index = text.toLowerCase().indexOf(lowerQuery)
  if (index < 0) return null
  const start = Math.max(0, index - SNIPPET_CONTEXT)
  const end = Math.min(text.length, index + lowerQuery.length + SNIPPET_CONTEXT)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

export interface SearchBudget {
  maxSessions?: number
  maxFileBytes?: number
}

/**
 * Per-turn recall budget. Every prompt pays this, unlike the user-driven search
 * box which pays once per keystroke-settled query: fewer sessions, smaller
 * transcripts. Kept small enough to sit inside the gap before the first token.
 */
export const RECALL_BUDGET: SearchBudget = { maxSessions: 8, maxFileBytes: 512 * 1024 }

/** Longest–first is a crude but decent proxy for "this is what the ask is about". */
const STOP_ISH = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'when',
  'please', '帮我', '帮帮我', '可以', '能不能', '需要'
])

/**
 * Terms worth searching past sessions for.
 *
 * The search is substring-based, so a whole sentence is a useless query — it
 * will not appear verbatim anywhere. Terms are extracted instead: an
 * identifier-shaped word, or a 4-character sliding window over CJK text (no
 * word boundaries exist there to split on).
 */
export function extractRecallQueries(prompt: string, maxQueries = 2): string[] {
  const queries: string[] = []
  const seen = new Set<string>()
  const push = (value: string): void => {
    const key = value.toLowerCase()
    if (key.length < 3 || STOP_ISH.has(key) || seen.has(key)) return
    seen.add(key)
    queries.push(value)
  }

  const words = [...prompt.matchAll(/[A-Za-z_][A-Za-z0-9_.-]{3,}/g)]
    .map((match) => match[0])
    .sort((a, b) => b.length - a.length)
  for (const word of words) {
    if (queries.length >= maxQueries) break
    push(word)
  }

  // Lump every non-CJK run out, then walk the remainder in 4-character steps.
  const cjk = prompt.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const run of cjk.split(' ')) {
    if (run.length < 2) continue
    for (let i = 0; i + 4 <= run.length && queries.length < maxQueries; i += 4) {
      push(run.slice(i, i + 4))
    }
    if (queries.length >= maxQueries) break
  }

  return queries
}

export function searchSessionRecords(
  records: SessionRecordLike[],
  rawQuery: string,
  limit = MAX_HITS,
  budget: SearchBudget = {}
): SessionSearchHit[] {
  const query = rawQuery.trim()
  if (query.length === 0) return []
  const maxSessions = budget.maxSessions ?? MAX_SESSIONS
  const maxFileBytes = budget.maxFileBytes ?? MAX_FILE_BYTES
  const lowerQuery = query.toLowerCase()
  const hits: SessionSearchHit[] = []
  const sorted = [...records].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxSessions)

  for (const record of sorted) {
    if (hits.length >= limit) break
    // Titles first — cheap and catches "which chat was that project in".
    const titleMatch = record.title.toLowerCase().includes(lowerQuery)
    let transcriptMatch: string | null = null
    if (!titleMatch && record.piSessionFile && existsSync(record.piSessionFile)) {
      try {
        if (statSync(record.piSessionFile).size > maxFileBytes) continue
        const raw = readFileSync(record.piSessionFile, 'utf8')
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          for (const message of extractMessages(line)) {
            const snippet = snippetAround(message.text, lowerQuery)
            if (snippet !== null) {
              transcriptMatch = `${message.role === 'user' ? '你' : 'AI'}: ${snippet}`
              break
            }
          }
          if (transcriptMatch !== null) break
        }
      } catch {
        continue
      }
    }
    if (!titleMatch && transcriptMatch === null) continue
    hits.push({
      sessionId: record.id,
      title: record.title,
      snippet: transcriptMatch ?? '(标题匹配)',
      updatedAt: record.updatedAt
    })
  }
  return hits
}
