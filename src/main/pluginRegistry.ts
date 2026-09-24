import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ContractError } from '../shared/contract'
import type { PluginId, PluginSourceKind } from '../shared/contract'
import type { PluginResourceSpec } from '../shared/kernel-protocol'
import { enumerateComponents, findManifestPath, parseManifest } from './pluginManifest'

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

export class PluginRegistry {
  private records = new Map<PluginId, PluginRecord>()

  load(): void {
    const file = registryPath()
    if (!existsSync(file)) return
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw) as PersistShape
      if (parsed?.version !== 1 || !Array.isArray(parsed.plugins)) return
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
        }
      }
    } catch {
      this.records.clear()
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
      pluginStorageRoot: pluginsStorageRoot()
    }
    for (const rec of this.list()) {
      if (!rec.enabled || !existsSync(rec.rootPath)) continue
      try {
        const manifestPath = findManifestPath(rec.rootPath)
        if (!manifestPath) continue
        const enumeration = enumerateComponents(rec.rootPath, parseManifest(manifestPath))
        spec.extensionPaths.push(...enumeration.extensionPaths)
        spec.skillRoots.push(...enumeration.skillRoots)
      } catch {
        continue
      }
    }
    spec.extensionPaths = [...new Set(spec.extensionPaths)].sort()
    spec.skillRoots = [...new Set(spec.skillRoots)].sort()
    return spec
  }
}
