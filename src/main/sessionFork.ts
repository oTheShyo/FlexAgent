/**
 * Session fork (ticket 17): seed a new PI transcript from a stable completed
 * assistant message.
 *
 * The fork point is addressed the way the renderer sees it — the message's
 * timestamp plus the first 64 characters of its text (the same pair the
 * synthetic chat-message id embeds). The new file keeps every entry up to and
 * including that message and drops the rest: later turns, their tool results,
 * and any config changes after the fork point. The header is rewritten with a
 * fresh PI session id and `parentSession` pointing at the source, which is how
 * PI itself models lineage.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, join, parse } from 'path'

/** A completed assistant turn: never pending, aborted, or error. */
const STABLE_STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'deferred'])

export interface ForkTarget {
  /** Message timestamp (epoch ms) as the renderer saw it; advisory. */
  ts?: number
  /** First 64 characters of the message text; required. */
  prefix: string
}

export interface ForkedTranscript {
  file: string
  forkedPiId: string
  entriesKept: number
  entriesDropped: number
}

function entryMessage(line: string): { message: Record<string, unknown> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const entry = parsed as Record<string, unknown>
  if (entry.type !== 'message') return null
  const message = entry.message
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null
  return { message: message as Record<string, unknown> }
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block !== null && typeof block === 'object' && (block as Record<string, unknown>).type === 'text'
          ? String((block as Record<string, unknown>).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

/**
 * Cut the transcript after the fork point and adopt it as a new session file.
 * Matching: an assistant entry whose stopReason says the turn actually
 * finished; exact timestamp+prefix first, prefix-only (last match) as the
 * fallback for transcripts whose messages carry no timestamp.
 */
export function forkSessionFile(
  sourceFile: string,
  target: ForkTarget,
  newPiId: string
): ForkedTranscript {
  if (!existsSync(sourceFile)) {
    throw new Error(`cannot fork: transcript file is gone (${sourceFile})`)
  }
  if (!target.prefix || target.prefix.trim() === '') {
    throw new Error('cannot fork: fork point has no text to match')
  }
  const prefix = target.prefix.slice(0, 64)
  const lines = readFileSync(sourceFile, 'utf8').split('\n')

  let forkLineIndex = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = entryMessage(lines[i] ?? '')
    if (parsed === null) continue
    const { message } = parsed
    if (message.role !== 'assistant') continue
    if (!STABLE_STOP_REASONS.has(String(message.stopReason ?? 'stop'))) continue
    if (messageText(message).startsWith(prefix)) {
      const msgTs = typeof message.timestamp === 'number' ? message.timestamp : undefined
      if (target.ts === undefined || msgTs === undefined || msgTs === target.ts) {
        forkLineIndex = i
        break
      }
    }
  }
  if (forkLineIndex === -1) {
    throw new Error('cannot fork: no stable completed assistant message matches the fork point')
  }

  const kept = lines.slice(0, forkLineIndex + 1)
  const dropped = lines.length - kept.length
  const rewritten = kept.map((line, index) => {
    if (index !== 0) return line
    let header: Record<string, unknown>
    try {
      header = JSON.parse(line) as Record<string, unknown>
    } catch {
      return line
    }
    if (header.type !== 'session') return line
    const sourceId = typeof header.id === 'string' ? header.id : undefined
    return JSON.stringify({
      ...header,
      id: newPiId,
      ...(sourceId !== undefined ? { parentSession: sourceId } : {})
    })
  })

  const stem = parse(sourceFile).name
  const file = join(dirname(sourceFile), `${stem}.fork-${newPiId.slice(0, 8)}.jsonl`)
  writeFileSync(file, `${rewritten.join('\n')}`, 'utf8')
  return { file, forkedPiId: newPiId, entriesKept: kept.length, entriesDropped: dropped }
}
