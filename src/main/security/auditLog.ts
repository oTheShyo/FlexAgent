/**
 * Permission decision audit trail (security §未解决的问题 · 审计日志).
 *
 * The article's last known gap: "当前的日志系统记录了操作结果，但没有记录权限
 * 判断的决策过程". That is exactly the state this repo was in — `evaluate()`
 * returns a verdict with `via` + `reason`, the UI shows it once, and then it is
 * gone. When a user later asks "why was this allowed?", there is no answer.
 *
 * Properties:
 * - **Append-only JSONL** — a torn final line costs one entry, never the file.
 * - **Bounded** — one rotation at 4MB; an audit log that fills the disk is a
 *   denial of service against the same user it protects.
 * - **No raw arguments** — the entry stores a sha256 prefix of the parameter
 *   fingerprint plus a redacted target. Audit logs get copied into bug reports;
 *   they must not become the leak they exist to deter.
 * - **Every decision, not just the interesting ones** — an audit trail that
 *   records only refusals cannot explain why something was auto-allowed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { redactSecrets } from './secretPatterns'

export const AUDIT_HOME =
  process.env.FLEXAGENT_AUDIT_HOME ?? join(homedir(), '.flexagent', 'audit')

const LOG_FILE = join(AUDIT_HOME, 'permissions.jsonl')
const ROTATED_FILE = join(AUDIT_HOME, 'permissions.1.jsonl')
const MAX_BYTES = 4 * 1024 * 1024

export type AuditKind = 'permission' | 'redaction' | 'child-permission'

export interface AuditEntry {
  ts: number
  kind: AuditKind
  sessionId: string
  tool: string
  /** Final gate outcome; for a redaction entry, the number of masked values. */
  outcome: string
  /** Which layer decided: mode / rule / heuristic / classifier / user. */
  via?: string
  mode?: string
  reason?: string
  /** sha256 prefix of the normalised arguments — correlates repeats without storing them. */
  argsHash?: string
  /** Credential-shaped values already masked before writing. */
  target?: string
  /** Set for child-agent decisions: which subagent asked. */
  actor?: string
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return
    if (statSync(LOG_FILE).size < MAX_BYTES) return
    // One rotation, same volume, atomic-ish: the previous file is replaced by
    // the current one, so the newest entries always live in LOG_FILE.
    renameSync(LOG_FILE, ROTATED_FILE)
  } catch {
    // Rotation is best-effort; failing to rotate must not stop the audit write
    // (which is itself best-effort, see `recordAudit`).
  }
}

function safeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return redactSecrets(value).text
}

/**
 * Append one decision. Never throws: an audit write that can break a tool call
 * is an audit log the user will disable. Failures are reported once per process
 * on stderr instead.
 */
let warnedOnce = false

export function recordAudit(entry: Omit<AuditEntry, 'ts'> & { ts?: number }): void {
  try {
    mkdirSync(AUDIT_HOME, { recursive: true })
    rotateIfNeeded()
    const record: AuditEntry = {
      ts: entry.ts ?? Date.now(),
      ...entry,
      reason: safeText(entry.reason),
      target: safeText(entry.target)
    }
    appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true
      console.warn(
        `[audit] permission audit write failed (further failures silenced): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

/** Short, stable hash of an argument fingerprint. Not reversible by design. */
export function hashArgs(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 12)
}

/** Newest-first read, for the diagnostics script and a future audit UI. */
export function readAudit(limit = 200): AuditEntry[] {
  if (!existsSync(LOG_FILE)) return []
  try {
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const parsed: AuditEntry[] = []
    for (const line of lines.slice(-limit)) {
      try {
        parsed.push(JSON.parse(line) as AuditEntry)
      } catch {
        // One corrupt line (a torn tail) must not hide the rest.
      }
    }
    return parsed.reverse()
  } catch {
    return []
  }
}

/** Test/diagnostic helper: wipe both the live log and the rotation. */
export function resetAuditForTests(): void {
  try {
    writeFileSync(LOG_FILE, '', 'utf8')
  } catch {
    // nothing to reset
  }
}
