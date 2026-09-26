/**
 * User-level enable/disable overrides for plugin-declared MCP servers
 * (issue 23). Plugin authors can ship `enabled: false` in their MCP config;
 * these overrides let the user flip individual servers from the MCP panel
 * without editing plugin files (which updates would clobber anyway).
 *
 * Stored at `<pluginsStorageRoot>/mcp-server-overrides.json`: one JSON object
 * keyed by the bridge server key (`plugin:<pluginName>:<serverName>`). Only
 * servers the user has explicitly toggled appear in the file — absence means
 * "use the plugin's default".
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { pluginsStorageRoot } from './pluginRegistry'

const OVERRIDES_FILE = join(pluginsStorageRoot(), 'mcp-server-overrides.json')

export type PluginMcpServerOverrides = Record<string, { enabled: boolean }>

function overridesPath(): string {
  // Lazy: pluginsStorageRoot() reads Electron's userData path, which is only
  // valid inside the running app (unit tests stub `app`).
  return join(pluginsStorageRoot(), 'mcp-server-overrides.json')
}

export function listPluginMcpServerOverrides(): PluginMcpServerOverrides {
  const file = overridesPath()
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: PluginMcpServerOverrides = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { enabled?: unknown }).enabled === 'boolean'
      ) {
        out[key] = { enabled: (value as { enabled: boolean }).enabled }
      }
    }
    return out
  } catch {
    // A malformed overrides file must never take the plugin bridge down.
    return {}
  }
}

export function setPluginMcpServerOverride(key: string, enabled: boolean): void {
  const overrides = listPluginMcpServerOverrides()
  overrides[key] = { enabled }
  const file = overridesPath()
  mkdirSync(dirname(file), { recursive: true })
  // Same-volume tmp+rename: a crash mid-write leaves the previous state intact.
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}
