import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ContractError } from '../shared/contract'
import type { PluginId, PluginSourceKind } from '../shared/contract'
import type { PluginResourceSpec } from '../shared/kernel-protocol'
import { enumerateComponents, findManifestPath, parseManifest } from './pluginManifest'
import { resolveUserConfigValues } from './userConfig'

export interface PluginRecord {
  id: PluginId
  name: string
  version: string
  rootPath: string
  enabled: boolean
  sourceKind: PluginSourceKind
  sourceLabel: string
  configuredOptions?: Record<string, string | number | boolean>
  suppressed?: boolean
  installedAt: number
}

interface PersistShape {
  version: 1
  plugins: PluginRecord[]
}

function pluginsDir(): string {
  return join(app.getPath('userData'), 'plugins')
}

function registryPath(): string {
  return join(pluginsDir(), 'installed.json')
}

export function pluginInstallDir(name: string): string {
  return join(pluginsDir(), `${name}@local`)
}

export function pluginsStorageRoot(): string {
  return pluginsDir()
}

function backupPath(file: string): string {
  let candidate = `${file}.corrupt`
  let n = 1
  while (existsSync(candidate)) {
    candidate = `${file}.corrupt.${n++}`
  }
  return candidate
}

function preserveCorrupt(file: string, reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason)
  try {
    const backup = backupPath(file)
    renameSync(file, backup)
    console.error(
      `[pluginRegistry] installed.json unreadable (${message}); preserved original bytes at ${backup}`
    )
  } catch (err) {
    const backupError = err instanceof Error ? err.message : String(err)
    console.warn(
      `[pluginRegistry] installed.json unreadable (${message}); original file could NOT be backed up (${backupError}) — it may be overwritten by the next persist()`
    )
  }
}

export class PluginRegistry {
  private records = new Map<PluginId, PluginRecord>()

  load(): void {
    const file = registryPath()
    if (!existsSync(file)) return
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      this.records.clear()
      preserveCorrupt(file, err)
      return
    }
    let parsed: PersistShape
    try {
      parsed = JSON.parse(raw) as PersistShape
    } catch (err) {
      this.records.clear()
      preserveCorrupt(file, err)
      return
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.plugins)) {
      this.records.clear()
      preserveCorrupt(file, new Error('unexpected plugins registry shape'))
      return
    }
    let skipped = 0
    for (const rec of parsed.plugins) {
      if (rec && typeof rec.id === 'string' && typeof rec.rootPath === 'string' && typeof rec.name === 'string') {
        this.records.set(rec.id, {
          ...rec,
          version: typeof rec.version === 'string' ? rec.version : '0.0.0',
          enabled: rec.enabled === true,
          sourceKind: rec.sourceKind ?? 'local',
          sourceLabel: rec.sourceLabel ?? 'Local',
          installedAt: Number(rec.installedAt) || Date.now()
        })
      } else {
        skipped++
      }
    }
    if (skipped > 0) {
      preserveCorrupt(file, new Error(`${skipped} malformed record(s) skipped, good records kept`))
    }
  }

  private persist(): void {
    const file = registryPath()
    mkdirSync(join(file, '..'), { recursive: true })
    const payload: PersistShape = {
      version: 1,
      plugins: [...this.records.values()].sort((a, b) => a.installedAt - b.installedAt)
    }
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  }

  list(): PluginRecord[] {
    return [...this.records.values()]
      .filter((rec) => !rec.suppressed)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: PluginId): PluginRecord | undefined {
    const rec = this.records.get(id)
    if (!rec || rec.suppressed) return undefined
    return rec
  }

  require(id: PluginId): PluginRecord {
    const rec = this.get(id)
    if (!rec) throw new ContractError('PLUGIN_NOT_FOUND', `Unknown plugin: ${id}`)
    return rec
  }

  add(rec: PluginRecord): void {
    if (this.records.has(rec.id)) {
      throw new ContractError('PLUGIN_ALREADY_INSTALLED', `Plugin already installed: ${rec.id}`)
    }
    this.records.set(rec.id, rec)
    this.persist()
  }

  remove(id: PluginId): void {
    if (this.records.delete(id)) this.persist()
  }

  setEnabled(id: PluginId, enabled: boolean): PluginRecord {
    const rec = this.require(id)
    rec.enabled = enabled
    this.persist()
    return rec
  }

  collectResourceSpec(): PluginResourceSpec {
    const spec: PluginResourceSpec = {
      extensionPaths: [],
      skillRoots: [],
      commands: [],
      hooks: [],
      hookContexts: {},
      mcp: [],
      pluginStorageRoot: pluginsStorageRoot()
    }
    for (const rec of this.list()) {
      if (!rec.enabled || !existsSync(rec.rootPath)) continue
      try {
        const manifestPath = findManifestPath(rec.rootPath)
        if (!manifestPath) continue
        const manifest = parseManifest(manifestPath)
        const enumeration = enumerateComponents(rec.rootPath, manifest)
        spec.extensionPaths.push(...enumeration.extensionPaths)
        spec.skillRoots.push(...enumeration.skillRoots)
        spec.commands.push(...enumeration.commandDirs)
        spec.hooks.push(...enumeration.hookPaths)
        for (const hookPath of enumeration.hookPaths) {
          spec.hookContexts[hookPath] = {
            pluginRoot: rec.rootPath,
            pluginId: rec.id,
            pluginName: rec.name,
            userConfig: resolveUserConfigValues(manifest.userConfig, rec.configuredOptions),
            sensitiveKeys: Object.entries(manifest.userConfig ?? {})
              .filter(([, entry]) => entry.sensitive === true)
              .map(([key]) => key)
          }
        }
      } catch {
        continue
      }
    }
    spec.extensionPaths = [...new Set(spec.extensionPaths)].sort()
    spec.skillRoots = [...new Set(spec.skillRoots)].sort()
    spec.commands = [...new Set(spec.commands)].sort()
    spec.hooks = [...new Set(spec.hooks)].sort()
    return spec
  }
}
