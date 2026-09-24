import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, extname, join, relative } from 'path'
import { ContractError } from '../shared/contract'
import type {
  PluginComponentInfo,
  PluginDiagnostic,
  PluginUserConfigSpec
} from '../shared/contract'
import { isMappedHookEvent, parseCommandMarkdown } from './pluginBridge'
import { discoverHookSources, parseHooksContent } from './hookSources'

export type FlexComponentDecl = string | string[] | Record<string, unknown>

export interface FlexPluginManifestAuthor {
  name?: string
  email?: string
  url?: string
}

export interface FlexUserConfigEntry {
  title?: string
  description?: string
  type?: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  default?: string | number | boolean
  required?: boolean
  sensitive?: boolean
}

export interface FlexPluginManifest {
  name: string
  version: string
  description?: string
  author?: string | FlexPluginManifestAuthor
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  extensions?: FlexComponentDecl
  skills?: FlexComponentDecl
  commands?: FlexComponentDecl
  hooks?: FlexComponentDecl
  mcpServers?: FlexComponentDecl
  dependencies?: string[]
  userConfig?: Record<string, FlexUserConfigEntry>
}

export interface ComponentEnumeration {
  components: PluginComponentInfo[]
  extensionPaths: string[]
  skillRoots: string[]
  commandDirs: string[]
  hookPaths: string[]
  diagnostics: PluginDiagnostic[]
}

export const MANIFEST_CANDIDATES = [
  '.flex-plugin/plugin.json',
  '.zcode-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  'plugin.json'
] as const

const MANIFEST_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const EXTENSION_FILE_RE = /\.(ts|js|mjs|cjs)$/
const UNSUPPORTED_MANIFEST_FIELDS = ['channels', 'lspServers', 'outputStyles', 'settings'] as const
const USER_CONFIG_TYPES = ['string', 'number', 'boolean', 'directory', 'file'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidManifest(message: string): never {
  throw new ContractError('PLUGIN_MANIFEST_INVALID', message)
}

export function findManifestPath(rootPath: string): string | null {
  for (const candidate of MANIFEST_CANDIDATES) {
    const full = join(rootPath, candidate)
    if (existsSync(full) && statSync(full).isFile()) return full
  }
  return null
}

function validateComponentDecl(raw: unknown, field: string): FlexComponentDecl | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return raw as string[]
  }
  if (isPlainObject(raw)) return raw
  return invalidManifest(`"${field}" must be a string, string array, or object`)
}

function validateUserConfig(raw: unknown): Record<string, FlexUserConfigEntry> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) invalidManifest('"userConfig" must be an object')
  const out: Record<string, FlexUserConfigEntry> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) invalidManifest(`userConfig."${key}" must be an object`)
    const type = entry.type
    if (type !== undefined && !(USER_CONFIG_TYPES as readonly string[]).includes(type as string)) {
      invalidManifest(`userConfig."${key}".type must be one of ${USER_CONFIG_TYPES.join(', ')}`)
    }
    if (entry.default !== undefined &&
        !['string', 'number', 'boolean'].includes(typeof entry.default)) {
      invalidManifest(`userConfig."${key}".default must be a string, number, or boolean`)
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      invalidManifest(`userConfig."${key}".required must be a boolean`)
    }
    if (entry.sensitive !== undefined && typeof entry.sensitive !== 'boolean') {
      invalidManifest(`userConfig."${key}".sensitive must be a boolean`)
    }
    out[key] = {
      ...(entry.title !== undefined ? { title: String(entry.title) } : {}),
      ...(entry.description !== undefined ? { description: String(entry.description) } : {}),
      ...(entry.type !== undefined ? { type: entry.type as FlexUserConfigEntry['type'] } : {}),
      ...('default' in entry ? { default: entry.default as string | number | boolean } : {}),
      ...(entry.required !== undefined ? { required: entry.required } : {}),
      ...(entry.sensitive !== undefined ? { sensitive: entry.sensitive } : {})
    }
  }
  return out
}

export function parseManifest(manifestPath: string): FlexPluginManifest {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return invalidManifest(`Cannot parse ${manifestPath}: ${(err as Error).message}`)
  }
  if (!isPlainObject(raw)) invalidManifest('Manifest root must be an object')

  const name = raw.name
  if (typeof name !== 'string' || !MANIFEST_NAME_RE.test(name)) {
    invalidManifest(`"name" must match ${MANIFEST_NAME_RE.source}`)
  }

  const version = raw.version === undefined ? '0.0.0' : raw.version
  if (typeof version !== 'string') invalidManifest('"version" must be a string')

  const optionalString = (field: string): string | undefined => {
    const value = raw[field]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') invalidManifest(`"${field}" must be a string`)
    return value
  }

  let author: FlexPluginManifest['author']
  if (raw.author !== undefined && raw.author !== null) {
    if (typeof raw.author === 'string') {
      author = raw.author
    } else if (isPlainObject(raw.author)) {
      author = {
        ...(typeof raw.author.name === 'string' ? { name: raw.author.name } : {}),
        ...(typeof raw.author.email === 'string' ? { email: raw.author.email } : {}),
        ...(typeof raw.author.url === 'string' ? { url: raw.author.url } : {})
      }
    } else {
      invalidManifest('"author" must be a string or object')
    }
  }

  let keywords: string[] | undefined
  if (raw.keywords !== undefined && raw.keywords !== null) {
    if (!Array.isArray(raw.keywords) || !raw.keywords.every((k) => typeof k === 'string')) {
      invalidManifest('"keywords" must be an array of strings')
    }
    keywords = raw.keywords as string[]
  }

  let dependencies: string[] | undefined
  if (raw.dependencies !== undefined && raw.dependencies !== null) {
    if (!Array.isArray(raw.dependencies) || !raw.dependencies.every((d) => typeof d === 'string')) {
      invalidManifest('"dependencies" must be an array of strings')
    }
    dependencies = raw.dependencies as string[]
  }

  const description = optionalString('description')
  const homepage = optionalString('homepage')
  const repository = optionalString('repository')
  const license = optionalString('license')
  const extensions = validateComponentDecl(raw.extensions, 'extensions')
  const skills = validateComponentDecl(raw.skills, 'skills')
  const commands = validateComponentDecl(raw.commands, 'commands')
  const hooks = validateComponentDecl(raw.hooks, 'hooks')
  const mcpServers = validateComponentDecl(raw.mcpServers, 'mcpServers')
  const userConfig = validateUserConfig(raw.userConfig)

  return {
    name,
    version,
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    ...(repository !== undefined ? { repository } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(dependencies !== undefined ? { dependencies } : {}),
    ...(userConfig !== undefined ? { userConfig } : {})
  }
}

export function normalizeUserConfig(
  manifest: FlexPluginManifest,
  diagnostics: PluginDiagnostic[],
  pluginId?: string
): PluginUserConfigSpec[] | undefined {
  if (!manifest.userConfig) return undefined
  const specs: PluginUserConfigSpec[] = []
  for (const [key, entry] of Object.entries(manifest.userConfig)) {
    if (entry.sensitive === true) {
      diagnostics.push({
        code: 'plugin_sensitive_config_readonly',
        severity: 'warning',
        message: `Config "${key}" is sensitive; it cannot be edited in P1.`,
        ...(pluginId ? { pluginId } : {})
      })
    }
    specs.push({
      key,
      title: entry.title ?? key,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      type: entry.type ?? 'string',
      ...('default' in entry ? { default: entry.default } : {}),
      ...(entry.required !== undefined ? { required: entry.required } : {}),
      ...(entry.sensitive !== undefined ? { sensitive: entry.sensitive } : {})
    })
  }
  return specs
}

function toRelPosix(rootPath: string, absPath: string): string {
  return relative(rootPath, absPath).split('\\').join('/')
}

function listDir(dir: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(entry.name)
    else if (entry.isFile()) files.push(entry.name)
  }
  return { dirs, files }
}

function isExtensionFile(filePath: string): boolean {
  return EXTENSION_FILE_RE.test(extname(filePath)) && statSync(filePath).isFile()
}

function resolveDeclEntries(rootPath: string, decl: FlexComponentDecl | undefined, fallbackDir: string): string[] {
  const candidate = decl ?? fallbackDir
  const entries = typeof candidate === 'string' ? [candidate] : Array.isArray(candidate) ? candidate : []
  return entries.map((entry) => join(rootPath, entry))
}

function expandExtensionTarget(rootPath: string, absTarget: string, out: string[], diagnostics: PluginDiagnostic[]): void {
  if (!existsSync(absTarget)) {
    diagnostics.push({
      code: 'plugin_component_missing',
      severity: 'warning',
      message: `Declared extension path not found: ${toRelPosix(rootPath, absTarget)}`
    })
    return
  }
  if (isExtensionFile(absTarget)) {
    out.push(absTarget)
    return
  }
  if (!statSync(absTarget).isDirectory()) {
    diagnostics.push({
      code: 'plugin_component_unsupported',
      severity: 'warning',
      message: `Extension path is neither a file nor a directory: ${toRelPosix(rootPath, absTarget)}`
    })
    return
  }
  for (const indexName of ['index.ts', 'index.js', 'index.mjs', 'index.cjs']) {
    const indexPath = join(absTarget, indexName)
    if (existsSync(indexPath) && statSync(indexPath).isFile()) {
      out.push(indexPath)
      return
    }
  }
  const { files } = listDir(absTarget)
  const topLevel = files
    .filter((file) => EXTENSION_FILE_RE.test(extname(file)))
    .map((file) => join(absTarget, file))
    .sort()
  if (topLevel.length > 0) {
    out.push(...topLevel)
    return
  }
  diagnostics.push({
    code: 'plugin_component_missing',
    severity: 'warning',
    message: `Extension directory has no index or top-level .ts/.js files: ${toRelPosix(rootPath, absTarget)}`
  })
}

function parseSkillFrontmatter(skillDir: string): { name?: string; description?: string } {
  try {
    const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return {}
    const out: { name?: string; description?: string } = {}
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
      if (!kv) continue
      let value = kv[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (kv[1] === 'name') out.name = value
      else if (kv[1] === 'description') out.description = value
    }
    return out
  } catch {
    return {}
  }
}

function collectSkills(rootPath: string, decl: FlexComponentDecl | undefined, result: ComponentEnumeration): void {
  if (typeof decl === 'object' && !Array.isArray(decl)) {
    result.diagnostics.push({
      code: 'plugin_unsupported_component',
      severity: 'warning',
      message: 'Inline skill declarations are not supported; use a directory path.'
    })
    return
  }

  const skillDirs: string[] = []
  if (decl !== undefined) {
    skillDirs.push(...resolveDeclEntries(rootPath, decl, 'skills'))
  } else if (existsSync(join(rootPath, 'skills')) && statSync(join(rootPath, 'skills')).isDirectory()) {
    skillDirs.push(join(rootPath, 'skills'))
  }

  const skillRoots: string[] = []
  for (const dir of skillDirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      result.diagnostics.push({
        code: 'plugin_component_missing',
        severity: 'warning',
        message: `Declared skills path not found: ${toRelPosix(rootPath, dir)}`
      })
      continue
    }
    if (existsSync(join(dir, 'SKILL.md'))) {
      skillRoots.push(dir)
      continue
    }
    for (const sub of listDir(dir).dirs.sort()) {
      const subDir = join(dir, sub)
      if (existsSync(join(subDir, 'SKILL.md'))) skillRoots.push(subDir)
    }
  }

  for (const skillDir of skillRoots) {
    const meta = parseSkillFrontmatter(skillDir)
    result.components.push({
      kind: 'skill',
      name: meta.name ?? skillDir.split(/[\\/]/).pop() ?? 'skill',
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      path: toRelPosix(rootPath, skillDir)
    })
    result.skillRoots.push(skillDir)
  }
}

function collectP2Component(
  rootPath: string,
  kind: 'command' | 'mcp',
  label: string,
  decl: FlexComponentDecl | undefined,
  fallbackPath: string,
  result: ComponentEnumeration
): void {
  if (typeof decl === 'object' && !Array.isArray(decl)) {
    result.diagnostics.push({
      code: 'plugin_unsupported_component',
      severity: 'warning',
      message: `Inline ${label} declarations are not supported in P1.`
    })
    return
  }
  const entries = decl === undefined
    ? [join(rootPath, fallbackPath)]
    : resolveDeclEntries(rootPath, decl, fallbackPath)
  let found = 0
  for (const entry of entries) {
    if (!existsSync(entry)) continue
    if (statSync(entry).isDirectory()) {
      if (kind === 'command') result.commandDirs.push(entry)
      const files = listDir(entry).files
        .filter((file) => kind === 'command' && extname(file) === '.md')
        .map((file) => join(entry, file))
        .sort()
      for (const file of files) {
        found += 1
        const stem = file.slice(0, -extname(file).length).split(/[\\/]/).pop() ?? label
        let name = stem
        let description: string | undefined
        try {
          const parsed = parseCommandMarkdown(readFileSync(file, 'utf8'))
          name = parsed.frontmatter.name?.trim() || stem
          description = parsed.frontmatter.description
        } catch {
          name = stem
        }
        result.components.push({
          kind,
          name,
          ...(description !== undefined ? { description } : {}),
          path: toRelPosix(rootPath, file)
        })
      }
    } else {
      found += 1
      if (kind === 'command') result.commandDirs.push(dirname(entry))
      result.components.push({
        kind,
        name: entry.split(/[\\/]/).pop() ?? label,
        path: toRelPosix(rootPath, entry)
      })
    }
  }
  if (found > 0 && kind !== 'command') {
    result.diagnostics.push({
      code: 'plugin_unsupported_component',
      severity: 'warning',
      message: `${label} components are registered but not loaded in P1 (P2 roadmap).`
    })
  }
}

function collectHookComponents(
  rootPath: string,
  manifestPath: string | null,
  decl: FlexComponentDecl | undefined,
  result: ComponentEnumeration
): void {
  const discovery = discoverHookSources({
    rootPath,
    ...(manifestPath !== null ? { manifestPath } : {}),
    manifestHooks: decl
  })
  for (const diag of discovery.diagnostics) {
    result.diagnostics.push({ ...diag })
  }
  const unsupportedEvents = new Set<string>()
  const seenEvents = new Set<string>()
  for (const source of discovery.sources) {
    const parsed = parseHooksContent(source.content, source.path)
    for (const diag of parsed.diagnostics) {
      result.diagnostics.push({ ...diag })
    }
    if (parsed.diagnostics.some((diag) => diag.code === 'plugin_hook_read_failed')) {
      continue
    }
    result.hookPaths.push(source.path)
    for (const entry of parsed.entries) {
      if (!isMappedHookEvent(entry.event)) {
        unsupportedEvents.add(entry.event)
        continue
      }
      if (seenEvents.has(entry.event)) continue
      seenEvents.add(entry.event)
      result.components.push({
        kind: 'hook',
        name: entry.event,
        path: toRelPosix(rootPath, source.path)
      })
    }
  }
  if (unsupportedEvents.size > 0) {
    result.diagnostics.push({
      code: 'plugin_unsupported_hook',
      severity: 'warning',
      message: `Hook event(s) not executable by this kernel: ${[...unsupportedEvents]
        .sort()
        .join(', ')}`
    })
  }
}

export function enumerateComponents(rootPath: string, manifest: FlexPluginManifest): ComponentEnumeration {
  const result: ComponentEnumeration = {
    components: [],
    extensionPaths: [],
    skillRoots: [],
    commandDirs: [],
    hookPaths: [],
    diagnostics: []
  }

  if (typeof manifest.extensions === 'object' && !Array.isArray(manifest.extensions)) {
    result.diagnostics.push({
      code: 'plugin_unsupported_component',
      severity: 'warning',
      message: 'Inline extension declarations are not supported; use a path.'
    })
  } else if (manifest.extensions !== undefined || existsSync(join(rootPath, 'extensions'))) {
    for (const target of resolveDeclEntries(rootPath, manifest.extensions, 'extensions')) {
      expandExtensionTarget(rootPath, target, result.extensionPaths, result.diagnostics)
    }
  }

  collectSkills(rootPath, manifest.skills, result)

  collectP2Component(rootPath, 'command', 'Command', manifest.commands, 'commands', result)
  collectHookComponents(rootPath, findManifestPath(rootPath), manifest.hooks, result)
  collectP2Component(rootPath, 'mcp', 'MCP', manifest.mcpServers, '.mcp.json', result)

  result.extensionPaths = [...new Set(result.extensionPaths)].sort()
  result.skillRoots = [...new Set(result.skillRoots)].sort()
  result.commandDirs = [...new Set(result.commandDirs)].sort()
  result.hookPaths = [...new Set(result.hookPaths)].sort()

  for (const path of result.extensionPaths) {
    result.components.push({
      kind: 'extension',
      name: path.split(/[\\/]/).pop()?.replace(EXTENSION_FILE_RE, '') ?? 'extension',
      path: toRelPosix(rootPath, path)
    })
  }
  result.components.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))

  for (const field of UNSUPPORTED_MANIFEST_FIELDS) {
    if ((manifest as unknown as Record<string, unknown>)[field] !== undefined) {
      result.diagnostics.push({
        code: 'plugin_unsupported_component',
        severity: 'warning',
        message: `Manifest field "${field}" is not supported by FlexAgent (P2/P3 roadmap).`
      })
    }
  }

  if (manifest.dependencies && manifest.dependencies.length > 0) {
    result.diagnostics.push({
      code: 'plugin_dependencies_unsupported',
      severity: 'warning',
      message: `Plugin dependencies are ignored in P1: ${manifest.dependencies.join(', ')}`
    })
  }

  return result
}

export function countComponents(components: PluginComponentInfo[]): Partial<Record<PluginComponentInfo['kind'], number>> {
  const counts: Partial<Record<PluginComponentInfo['kind'], number>> = {}
  for (const component of components) {
    counts[component.kind] = (counts[component.kind] ?? 0) + 1
  }
  return counts
}

export function tryReadManifest(rootPath: string): { manifest?: FlexPluginManifest; diagnostics: PluginDiagnostic[] } {
  const manifestPath = findManifestPath(rootPath)
  if (!manifestPath) {
    return {
      diagnostics: [
        {
          code: 'PLUGIN_MANIFEST_INVALID',
          severity: 'error',
          message: `No plugin.json found under ${rootPath}`
        }
      ]
    }
  }
  try {
    return { manifest: parseManifest(manifestPath), diagnostics: [] }
  } catch (err) {
    return {
      diagnostics: [
        {
          code: 'PLUGIN_MANIFEST_INVALID',
          severity: 'error',
          message: (err as Error).message
        }
      ]
    }
  }
}
