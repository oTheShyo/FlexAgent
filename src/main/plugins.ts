import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { ContractError } from '../shared/contract'
import type {
  InstallPluginInput,
  PluginDetail,
  PluginId,
  PluginSummary
} from '../shared/contract'
import type { KernelHost } from './kernel'
import {
  countComponents,
  enumerateComponents,
  findManifestPath,
  normalizeUserConfig,
  parseManifest,
  tryReadManifest
} from './pluginManifest'
import { pluginInstallDir, type PluginRecord, type PluginRegistry } from './pluginRegistry'

const COPY_SKIP = new Set(['node_modules', '.git'])

function summarize(rec: PluginRecord, description?: string, counts: PluginSummary['componentCounts'] = {}): PluginSummary {
  return {
    id: rec.id,
    name: rec.name,
    version: rec.version,
    ...(description !== undefined ? { description } : {}),
    enabled: rec.enabled,
    source: { kind: rec.sourceKind, label: rec.sourceLabel },
    componentCounts: counts
  }
}

export class PluginService {
  constructor(
    private registry: PluginRegistry,
    private kernel: KernelHost,
    private notify: () => void
  ) {}

  list(): PluginSummary[] {
    return this.registry.list().map((rec) => {
      const { manifest, diagnostics } = tryReadManifest(rec.rootPath)
      if (!manifest || diagnostics.some((d) => d.severity === 'error')) {
        return summarize(rec)
      }
      const enumeration = enumerateComponents(rec.rootPath, manifest)
      return summarize(rec, manifest.description, countComponents(enumeration.components))
    })
  }

  get(id: PluginId): PluginDetail {
    const rec = this.registry.require(id)
    const manifestPath = findManifestPath(rec.rootPath)
    if (!manifestPath) {
      return {
        ...summarize(rec),
        rootPath: rec.rootPath,
        components: [],
        diagnostics: [
          {
            code: 'PLUGIN_MANIFEST_INVALID',
            severity: 'error',
            message: `No plugin.json found under ${rec.rootPath}`,
            pluginId: rec.id
          }
        ]
      }
    }

    let manifest
    try {
      manifest = parseManifest(manifestPath)
    } catch (err) {
      return {
        ...summarize(rec),
        rootPath: rec.rootPath,
        components: [],
        diagnostics: [
          {
            code: 'PLUGIN_MANIFEST_INVALID',
            severity: 'error',
            message: (err as Error).message,
            pluginId: rec.id
          }
        ]
      }
    }

    const enumeration = enumerateComponents(rec.rootPath, manifest)
    const diagnostics = enumeration.diagnostics.map((d) => ({ ...d, pluginId: rec.id }))
    const userConfig = normalizeUserConfig(manifest, diagnostics, rec.id)

    const author =
      typeof manifest.author === 'string'
        ? manifest.author
        : manifest.author && manifest.author.name
          ? {
              name: manifest.author.name,
              ...(manifest.author.email !== undefined ? { email: manifest.author.email } : {}),
              ...(manifest.author.url !== undefined ? { url: manifest.author.url } : {})
            }
          : undefined

    return {
      ...summarize(rec, manifest.description, countComponents(enumeration.components)),
      ...(author !== undefined ? { author } : {}),
      ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
      ...(manifest.keywords !== undefined ? { keywords: manifest.keywords } : {}),
      rootPath: rec.rootPath,
      components: enumeration.components,
      ...(userConfig !== undefined ? { userConfig } : {}),
      ...(rec.configuredOptions !== undefined ? { configuredOptions: rec.configuredOptions } : {}),
      diagnostics
    }
  }

  async install(input: InstallPluginInput): Promise<PluginSummary> {
    const sourcePath = input.source.path
    if (!sourcePath || typeof sourcePath !== 'string' || !existsSync(sourcePath)) {
      throw new ContractError('PLUGIN_PATH_INVALID', `Plugin path does not exist: ${sourcePath}`)
    }
    if (!statSync(sourcePath).isDirectory()) {
      throw new ContractError('PLUGIN_PATH_INVALID', `Plugin path is not a directory: ${sourcePath}`)
    }

    const manifestPath = findManifestPath(sourcePath)
    if (!manifestPath) {
      throw new ContractError('PLUGIN_MANIFEST_INVALID', `No plugin.json found under ${sourcePath}`)
    }
    const manifest = parseManifest(manifestPath)

    const id = `${manifest.name}@local`
    if (this.registry.get(id)) {
      throw new ContractError('PLUGIN_ALREADY_INSTALLED', `Plugin already installed: ${id}`)
    }

    const targetDir = pluginInstallDir(manifest.name)
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
    mkdirSync(join(targetDir, '..'), { recursive: true })
    cpSync(sourcePath, targetDir, {
      recursive: true,
      filter: (src) => {
        const base = src.split(/[\\/]/).pop() ?? ''
        return !COPY_SKIP.has(base)
      }
    })

    const rec: PluginRecord = {
      id,
      name: manifest.name,
      version: manifest.version,
      rootPath: targetDir,
      enabled: true,
      sourceKind: 'local',
      sourceLabel: 'Local',
      installedAt: Date.now()
    }
    this.registry.add(rec)

    this.notify()
    await this.reloadKernel()
    return this.toSummary(rec, manifest.description)
  }

  async setEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary> {
    const before = this.registry.require(id)
    if (before.enabled === enabled) {
      return this.toSummary(before)
    }
    const rec = this.registry.setEnabled(id, enabled)
    this.notify()
    await this.reloadKernel()
    return this.toSummary(rec)
  }

  async uninstall(id: PluginId): Promise<void> {
    const rec = this.registry.require(id)
    this.registry.remove(id)
    if ((rec.sourceKind === 'local' || rec.sourceKind === 'marketplace') && existsSync(rec.rootPath)) {
      rmSync(rec.rootPath, { recursive: true, force: true })
    }
    this.notify()
    await this.reloadKernel()
  }

  async pushResourceSpec(): Promise<void> {
    await this.kernel.request({
      type: 'reloadPlugins',
      resourceSpec: this.registry.collectResourceSpec()
    })
  }

  async reloadKernel(): Promise<void> {
    await this.kernel.restartForPlugins()
    await this.pushResourceSpec()
  }

  private toSummary(rec: PluginRecord, description?: string): PluginSummary {
    const { manifest } = tryReadManifest(rec.rootPath)
    if (!manifest) return summarize(rec, description)
    const enumeration = enumerateComponents(rec.rootPath, manifest)
    return summarize(rec, description ?? manifest.description, countComponents(enumeration.components))
  }
}
