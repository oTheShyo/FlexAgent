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

export function searchSessionRecords(
  records: SessionRecordLike[],
  rawQuery: string,
  limit = MAX_HITS
): SessionSearchHit[] {
  const query = rawQuery.trim()
  if (query.length === 0) return []
  const lowerQuery = query.toLowerCase()
  const hits: SessionSearchHit[] = []
  const sorted = [...records].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)

  for (const record of sorted) {
    if (hits.length >= limit) break
    // Titles first — cheap and catches "which chat was that project in".
    const titleMatch = record.title.toLowerCase().includes(lowerQuery)
    let transcriptMatch: string | null = null
    if (!titleMatch && record.piSessionFile && existsSync(record.piSessionFile)) {
      try {
        if (statSync(record.piSessionFile).size > MAX_FILE_BYTES) continue
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
