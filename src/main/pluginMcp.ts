import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'
import type { PluginDiagnostic } from '../shared/contract'
import type { PluginMcpServerConfig } from '../shared/kernel-protocol'
import type { HookTemplateContext } from './userConfig'
import type { FlexPluginManifest } from './pluginManifest'

const SUPPORTED_MCP_TYPES = new Set(['stdio', 'http'])

export interface McpCollectionInput {
  rootPath: string
  manifest: FlexPluginManifest
  dataPath: string
  cwd: string
  pluginId: string
  pluginName: string
  userConfigValues: Record<string, string | number | boolean>
  sensitiveKeys: string[]
  interpolate: (template: string, ctx: HookTemplateContext) => string
  createEnvOverlay: (
    plugin: { rootPath: string; dataPath: string; id: string; name: string },
    cwd: string
  ) => Record<string, string>
}

export interface McpCollectionResult {
  configs: Record<string, PluginMcpServerConfig>
  paths: string[]
  diagnostics: PluginDiagnostic[]
}

class McpUnsupportedTransportError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveInside(root: string, spec: string): string | null {
  const rootAbs = resolve(root)
  const full = isAbsolute(spec) ? resolve(spec) : resolve(rootAbs, spec)
  if (full === rootAbs || full.startsWith(rootAbs + sep)) return full
  return null
}

function loadMcpDefinitionsFromFile(
  path: string,
  root: string,
  diagnostics: PluginDiagnostic[],
  pluginId: string
): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    diagnostics.push({
      code: 'plugin_mcp_read_failed',
      severity: 'error',
      message: `Failed to read MCP config: ${path}: ${err instanceof Error ? err.message : String(err)}`,
      pluginId
    })
    return {}
  }
  try {
    return normalizeMcpDefinitions(JSON.parse(raw), path, diagnostics, pluginId)
  } catch {
    diagnostics.push({
      code: 'plugin_mcp_read_failed',
      severity: 'error',
      message: `Malformed MCP config JSON: ${path}`,
      pluginId
    })
    return {}
  }
}

function normalizeMcpDefinitions(
  value: unknown,
  source: string,
  diagnostics: PluginDiagnostic[],
  pluginId: string
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    diagnostics.push({
      code: 'plugin_mcp_invalid',
      severity: 'error',
      message: `MCP config must be an object: ${source}`,
      pluginId
    })
    return {}
  }
  const servers = isPlainObject(value.mcpServers) ? value.mcpServers : value
  const out: Record<string, unknown> = {}
  for (const [name, config] of Object.entries(servers)) {
    if (isPlainObject(config)) out[name] = config
  }
  return out
}

function loadMcpDefinitionsFromDecl(
  decl: unknown,
  root: string,
  diagnostics: PluginDiagnostic[],
  pluginId: string
): Record<string, unknown> {
  if (decl === undefined || decl === null) return {}
  if (typeof decl === 'string') {
    const path = resolveInside(root, decl)
    if (!path) {
      diagnostics.push({
        code: 'plugin_component_path_invalid',
        severity: 'error',
        message: `Plugin mcpServers path escapes plugin root: ${decl}`,
        pluginId
      })
      return {}
    }
    return loadMcpDefinitionsFromFile(path, root, diagnostics, pluginId)
  }
  if (Array.isArray(decl)) {
    return Object.assign(
      {},
      ...decl.map((entry) => loadMcpDefinitionsFromDecl(entry, root, diagnostics, pluginId))
    )
  }
  return normalizeMcpDefinitions(decl, 'manifest.mcpServers', diagnostics, pluginId)
}

function templateContext(
  input: McpCollectionInput,
  sensitiveKeys: string[]
): HookTemplateContext {
  return {
    values: input.userConfigValues,
    sensitiveKeys,
    plugin: {
      rootPath: input.rootPath,
      dataPath: input.dataPath,
      id: input.pluginId,
      name: input.pluginName
    },
    projectDir: input.cwd
  }
}

function resolveMcpServerConfig(
  server: Record<string, unknown>,
  input: McpCollectionInput,
  diagnostics: PluginDiagnostic[]
): PluginMcpServerConfig {
  const declaredType = typeof server.type === 'string' ? server.type : undefined
  const type = declaredType ?? (typeof server.command === 'string' ? 'stdio' : 'http')
  if (!SUPPORTED_MCP_TYPES.has(type)) {
    throw new McpUnsupportedTransportError(
      declaredType
        ? `Unsupported MCP transport: ${declaredType}`
        : 'MCP server declares a url (sse); only stdio and http (streamable) are supported'
    )
  }
  const envContext = templateContext(input, [])
  const cmdContext = templateContext(input, input.sensitiveKeys)
  const baseEnv = input.createEnvOverlay(
    { rootPath: input.rootPath, dataPath: input.dataPath, id: input.pluginId, name: input.pluginName },
    input.cwd
  )
  const env: Record<string, string> = { ...baseEnv }
  if (isPlainObject(server.env)) {
    for (const [key, value] of Object.entries(server.env)) {
      if (typeof value === 'string') env[key] = input.interpolate(value, envContext)
    }
  }
  env.FLEX_PLUGIN_ID = input.pluginId
  const expose = server.expose === 'direct' ? ({ expose: 'direct' } as const) : {}
  if (type === 'http') {
    if (typeof server.url !== 'string' || server.url.length === 0) {
      throw new Error('http MCP server requires url')
    }
    const headers: Record<string, string> = {}
    if (isPlainObject(server.headers)) {
      for (const [key, value] of Object.entries(server.headers)) {
        if (typeof value === 'string') headers[key] = input.interpolate(value, cmdContext)
      }
    }
    return {
      type: 'http',
      url: input.interpolate(server.url, cmdContext),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      env,
      ...expose,
      ...(typeof server.timeoutMs === 'number' ? { timeoutMs: server.timeoutMs } : {})
    }
  }
  if (typeof server.command !== 'string' || server.command.length === 0) {
    throw new Error('stdio MCP server requires command')
  }
  const args = Array.isArray(server.args)
    ? server.args
        .filter((arg): arg is string => typeof arg === 'string')
        .map((arg) => input.interpolate(arg, cmdContext))
    : undefined
  return {
    type: 'stdio',
    command: input.interpolate(server.command, cmdContext),
    ...(args !== undefined && args.length > 0 ? { args } : {}),
    env,
    ...expose,
    ...(typeof server.cwd === 'string' && server.cwd.length > 0
      ? { cwd: input.interpolate(server.cwd, cmdContext) }
      : {}),
    ...(typeof server.timeoutMs === 'number' ? { timeoutMs: server.timeoutMs } : {})
  }
}

export function collectMcpServerConfigs(input: McpCollectionInput): McpCollectionResult {
  const diagnostics: PluginDiagnostic[] = []
  const fromFile = loadMcpDefinitionsFromFile(
    join(input.rootPath, '.mcp.json'),
    input.rootPath,
    diagnostics,
    input.pluginId
  )
  const fromManifest = loadMcpDefinitionsFromDecl(
    input.manifest.mcpServers,
    input.rootPath,
    diagnostics,
    input.pluginId
  )
  const merged = { ...fromFile, ...fromManifest }
  const configs: Record<string, PluginMcpServerConfig> = {}
  const paths: string[] = []
  for (const [serverName, server] of Object.entries(merged)) {
    const key = `plugin:${input.pluginName}:${serverName}`
    try {
      if (!isPlainObject(server)) {
        throw new Error('MCP server config must be an object')
      }
      if (server.enabled === false) continue
      configs[key] = resolveMcpServerConfig(server, input, diagnostics)
      paths.push(key)
    } catch (error) {
      if (error instanceof McpUnsupportedTransportError) {
        diagnostics.push({
          code: 'plugin_unsupported_mcp',
          severity: 'warning',
          message: `${key}: ${error.message}`,
          pluginId: input.pluginId
        })
        continue
      }
      diagnostics.push({
        code: 'plugin_mcp_invalid',
        severity: 'error',
        message: `${key}: ${error instanceof Error ? error.message : String(error)}`,
        pluginId: input.pluginId
      })
    }
  }
  return { configs, paths, diagnostics }
}
