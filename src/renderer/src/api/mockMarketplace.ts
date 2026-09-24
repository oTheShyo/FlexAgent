import {
  ContractError,
  type AddMarketplaceInput,
  type InstallFromMarketplaceInput,
  type MarketplaceApi,
  type MarketplaceInfo,
  type MarketplaceInstallSource,
  type MarketplaceProgressEvent,
  type MarketplaceProgressPhase,
  type MarketplaceSearchInput,
  type MarketplaceSearchResult,
  type PluginDetail,
  type PluginSummary
} from '../types'
import { dirBasename } from './mock'

export interface MarketplacePluginBridge {
  adopt(detail: PluginDetail): void
  installedVersion(name: string): string | null
}

interface CatalogEntry {
  name: string
  version: string
  description: string
  tags: string[]
}

const MOCK_CATALOG: CatalogEntry[] = [
  {
    name: 'markdown-tools',
    version: '1.2.0',
    description: 'Lint and format Markdown documents.',
    tags: ['markdown', 'docs']
  },
  {
    name: 'document-skills',
    version: '1.0.0',
    description: 'Built-in skills for generating DOCX and PDF documents.',
    tags: ['docs']
  },
  {
    name: 'local-demo',
    version: '0.3.0',
    description: 'Local demo plugin with an extension and one skill.',
    tags: ['demo']
  }
]

const PROGRESS_DELAYS_MS: Record<MarketplaceProgressPhase, number> = {
  resolve: 150,
  download: 350,
  extract: 200,
  install: 250,
  done: 60,
  error: 60
}

function marketplaceIdFromSource(source: string): string {
  const cleaned = source
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return cleaned.slice(0, 40) || 'marketplace'
}

function urlBasename(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url
  const lastSegment = withoutQuery.split('/').filter((part) => part.length > 0).pop() ?? ''
  return dirBasename(lastSegment.replace(/\.zip$/i, '').replace(/\.git$/i, '')) || 'remote-plugin'
}

export class MockMarketplaceApi implements MarketplaceApi {
  private readonly marketplaces: MarketplaceInfo[] = []
  private readonly listeners = new Set<(event: MarketplaceProgressEvent) => void>()

  constructor(private readonly bridge: MarketplacePluginBridge) {}

  async listMarketplaces(): Promise<MarketplaceInfo[]> {
    return this.marketplaces.map((marketplace) => ({ ...marketplace }))
  }

  async addMarketplace(input: AddMarketplaceInput): Promise<MarketplaceInfo> {
    const source = typeof input?.source === 'string' ? input.source.trim() : ''
    if (source.length === 0) {
      throw new ContractError('INVALID_INPUT', 'addMarketplace requires a non-empty source')
    }
    if (/^npm:/i.test(source)) {
      throw new ContractError('PLUGIN_SOURCE_INVALID', `Unsupported source kind: ${source}`)
    }
    const id = marketplaceIdFromSource(source)
    const existing = this.marketplaces.find((marketplace) => marketplace.id === id)
    const now = new Date().toISOString()
    if (existing !== undefined) {
      existing.lastUpdated = now
      return { ...existing }
    }
    const info: MarketplaceInfo = {
      id,
      name: id,
      description: `Added from ${source}`,
      source,
      pluginCount: MOCK_CATALOG.length,
      addedAt: now,
      lastUpdated: now
    }
    this.marketplaces.push(info)
    return { ...info }
  }

  async searchMarketplaces(input: MarketplaceSearchInput): Promise<MarketplaceSearchResult[]> {
    const query = (input?.query ?? '').trim().toLowerCase()
    const restrict = typeof input?.marketplace === 'string' && input.marketplace.length > 0
      ? input.marketplace
      : null
    const targets =
      restrict === null
        ? this.marketplaces
        : this.marketplaces.filter((marketplace) => marketplace.id === restrict)

    const results: MarketplaceSearchResult[] = []
    for (const marketplace of targets) {
      for (const entry of MOCK_CATALOG) {
        const haystack =
          `${entry.name} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase()
        if (query.length > 0 && !haystack.includes(query)) continue
        const installedVersion = this.bridge.installedVersion(entry.name)
        results.push({
          marketplace: marketplace.id,
          name: entry.name,
          version: entry.version,
          description: entry.description,
          tags: [...entry.tags],
          installed: installedVersion !== null,
          installedVersion: installedVersion ?? undefined,
          updateAvailable: installedVersion !== null && installedVersion !== entry.version
        })
      }
    }
    return results
  }

  async installFromMarketplace(input: InstallFromMarketplaceInput): Promise<PluginSummary> {
    const source = input?.source
    if (source === undefined || source === null || typeof source !== 'object' || !('kind' in source)) {
      throw new ContractError('INVALID_INPUT', 'installFromMarketplace requires a source')
    }

    const resolved = this.resolveSource(source)
    const installedVersion = this.bridge.installedVersion(resolved.name)
    if (installedVersion !== null && input.overwrite !== true) {
      throw new ContractError('PLUGIN_ALREADY_INSTALLED', `Plugin already installed: ${resolved.name}`)
    }

    for (const phase of resolved.phases) {
      if (phase === 'download' && resolved.failDownload) {
        await this.emit({ phase: 'error', source: resolved.eventSource, message: 'Simulated download failure' })
        throw new ContractError('PLUGIN_DOWNLOAD_FAILED', `Download failed: ${resolved.eventSource}`)
      }
      await this.emit({ phase, source: resolved.eventSource })
    }

    const detail: PluginDetail = {
      id: `${resolved.name}@${resolved.idSuffix}`,
      name: resolved.name,
      version: resolved.version,
      description: resolved.description,
      enabled: true,
      source: { kind: 'marketplace', label: resolved.sourceLabel },
      componentCounts: { skill: 1 },
      rootPath: resolved.rootPath,
      components: [
        {
          kind: 'skill',
          name: resolved.name,
          description: resolved.description,
          path: 'skills/main/SKILL.md'
        }
      ],
      userConfig: [],
      diagnostics: []
    }
    this.bridge.adopt(detail)
    await this.emit({ phase: 'done', source: resolved.eventSource, pluginId: detail.id })

    return {
      id: detail.id,
      name: detail.name,
      version: detail.version,
      description: detail.description,
      enabled: detail.enabled,
      source: { ...detail.source },
      componentCounts: { ...detail.componentCounts }
    }
  }

  subscribeMarketplaceProgress(listener: (event: MarketplaceProgressEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private resolveSource(source: MarketplaceInstallSource): {
    name: string
    version: string
    description: string
    sourceLabel: string
    idSuffix: string
    rootPath: string
    eventSource: string
    phases: MarketplaceProgressPhase[]
    failDownload: boolean
  } {
    if (source.kind === 'entry') {
      if (
        typeof source.marketplace !== 'string' ||
        source.marketplace.length === 0 ||
        typeof source.name !== 'string' ||
        source.name.length === 0
      ) {
        throw new ContractError('INVALID_INPUT', 'entry source requires marketplace and name')
      }
      if (!this.marketplaces.some((marketplace) => marketplace.id === source.marketplace)) {
        throw new ContractError('PLUGIN_NOT_FOUND', `Unknown marketplace: ${source.marketplace}`)
      }
      const entry = MOCK_CATALOG.find((candidate) => candidate.name === source.name)
      if (entry === undefined) {
        throw new ContractError('PLUGIN_NOT_FOUND', `Unknown plugin: ${source.name}`)
      }
      return {
        name: entry.name,
        version: entry.version,
        description: entry.description,
        sourceLabel: source.marketplace,
        idSuffix: source.marketplace,
        rootPath: `cache/${source.marketplace}/${entry.name}/${entry.version}`,
        eventSource: `${source.marketplace}/${entry.name}`,
        phases: ['resolve', 'download', 'extract', 'install'],
        failDownload: false
      }
    }

    if (source.kind === 'path') {
      const path = typeof source.path === 'string' ? source.path.trim() : ''
      if (path.length === 0) {
        throw new ContractError('PLUGIN_PATH_INVALID', 'path source requires a non-empty path')
      }
      const name = dirBasename(path)
      return {
        name,
        version: '0.1.0',
        description: `Plugin installed from ${path}.`,
        sourceLabel: 'Marketplace',
        idSuffix: 'marketplace',
        rootPath: path,
        eventSource: path,
        phases: ['resolve', 'install'],
        failDownload: false
      }
    }

    if (source.kind === 'url') {
      const url = typeof source.url === 'string' ? source.url.trim() : ''
      if (url.length === 0) {
        throw new ContractError('INVALID_INPUT', 'url source requires a non-empty url')
      }
      const supported =
        /\.zip(\?|#|$)/i.test(url) ||
        /github\.com\/[^/]+\/[^/]+/i.test(url) ||
        /\.git(\?|#|$)/i.test(url)
      if (!supported) {
        throw new ContractError('PLUGIN_SOURCE_INVALID', `Unsupported url source: ${url}`)
      }
      return {
        name: urlBasename(url),
        version: '1.0.0',
        description: `Plugin installed from ${url}.`,
        sourceLabel: 'Marketplace',
        idSuffix: 'marketplace',
        rootPath: `cache/downloads/${urlBasename(url)}`,
        eventSource: url,
        phases: ['resolve', 'download', 'extract', 'install'],
        failDownload: /fail/i.test(url)
      }
    }

    throw new ContractError(
      'PLUGIN_SOURCE_INVALID',
      `Unknown source kind: ${String((source as { kind?: string }).kind)}`
    )
  }

  private async emit(event: MarketplaceProgressEvent): Promise<void> {
    const delay = PROGRESS_DELAYS_MS[event.phase]
    await new Promise<void>((resolvePromise) => {
      window.setTimeout(() => {
        for (const listener of this.listeners) {
          try {
            listener(event)
          } catch {
            // listener failures must not break remaining listeners
          }
        }
        resolvePromise()
      }, delay)
    })
  }
}
