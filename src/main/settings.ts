/**
 * User-level settings for FlexAgent, stored in `~/.flexagent/settings.json`.
 *
 * The path is shared with the self-evolution skill layer (`skills/skillManage.ts`
 * exports the same constant); both modules only ever read their own sub-keys, so
 * the two never overwrite each other.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  PERMISSION_MODES,
  type PermissionMode
} from '../shared/contract'

export const SETTINGS_FILE = join(homedir(), '.flexagent', 'settings.json')

/** The middle of the spectrum: safe operations run, anything else asks. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default'

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

export function readSettings(): Record<string, unknown> {
  try {
    if (!existsSync(SETTINGS_FILE)) return {}
    const parsed: unknown = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

export function writeSettings(patch: Record<string, unknown>): void {
  const merged = { ...readSettings(), ...patch }
  try {
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  } catch {
    // Non-fatal: the session-level mode still applies for this run.
  }
}

export function readDefaultPermissionMode(): PermissionMode {
  const configured = readSettings()?.permission
  const mode = (configured as { defaultPermissionMode?: unknown } | undefined)
    ?.defaultPermissionMode
  return isPermissionMode(mode) ? mode : DEFAULT_PERMISSION_MODE
}

export function writeDefaultPermissionMode(mode: PermissionMode): PermissionMode {
  writeSettings({ permission: { defaultPermissionMode: mode } })
  return mode
}

/**
 * Automatic memory pass (issue 15). Default off — ZCode's default too: the
 * extraction costs a model call per turn, and a user who did not ask for it
 * should not be paying for it.
 */
export function readMemoryAutoExtract(): boolean {
  const memory = readSettings()?.memory as { autoExtract?: unknown } | undefined
  return memory?.autoExtract === true
}

export function writeMemoryAutoExtract(enabled: boolean): boolean {
  const current = readSettings()?.memory
  const memory = (current !== null && typeof current === 'object' && !Array.isArray(current)
    ? current
    : {}) as Record<string, unknown>
  writeSettings({ memory: { ...memory, autoExtract: enabled } })
  return enabled
}

/** Question countdown (issue 10). Default on, 5 minutes, matching ZCode. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000

export function readQuestionSettings(): { autoContinue: boolean; timeoutMs: number } {
  const raw = readSettings()?.question as
    | { autoContinue?: unknown; timeoutMs?: unknown }
    | undefined
  const timeoutMs = raw?.timeoutMs
  return {
    autoContinue: raw?.autoContinue !== false,
    timeoutMs:
      typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_QUESTION_TIMEOUT_MS
  }
}

export function writeQuestionAutoContinue(enabled: boolean): boolean {
  const current = readSettings()?.question
  const question = (current !== null && typeof current === 'object' && !Array.isArray(current)
    ? current
    : {}) as Record<string, unknown>
  writeSettings({ question: { ...question, autoContinue: enabled } })
  return enabled
}
