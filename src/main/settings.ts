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
