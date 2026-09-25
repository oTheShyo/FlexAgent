import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { PluginMcpServerConfig } from '../../shared/kernel-protocol'

const DEFAULT_CONNECT_TIMEOUT_MS = 10000
const DEFAULT_CALL_TIMEOUT_MS = 60000

/**
 * Env handed to a stdio MCP server by default.
 *
 * Passing the whole `process.env` — which is what this used to do — hands every
 * provider API key on the machine to a third-party process that MCP gives us no
 * way to audit. MCP has no sandbox and no capability model, so the only real
 * control is what we choose to pass. Servers that genuinely need the full
 * environment can opt in with `envInherit: true`.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS'
]

function inheritEnv(config: PluginMcpServerConfig): Record<string, string> {
  if (config.envInherit === true) return { ...process.env } as Record<string, string>
  const out: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function sanitizeNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_')
  return sanitized.length > 0 ? sanitized : 'unknown'
}

export function toMcpToolName(serverKey: string, toolName: string): string {
  return `mcp__${sanitizeNamePart(serverKey)}__${sanitizeNamePart(toolName)}`
}

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/**
 * Handle wrapping an SDK Client (stdio or streamable-HTTP transport).
 * Opaque to callers — use connectMcpClient/listMcpTools/callMcpTool/closeMcpClient.
 */
export interface McpClientHandle {
  client: Client
  serverName: string
  closed: boolean
}

function buildTransport(
  config: PluginMcpServerConfig
): { transport: StdioClientTransport | StreamableHTTPClientTransport; type: 'stdio' | 'http' } {
  if (config.type === 'http') {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (typeof value === 'string') headers[key] = value
    }
    return {
      type: 'http',
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers }
      })
    }
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...inheritEnv(config), ...config.env })) {
    if (typeof value === 'string') env[key] = value
  }
  return {
    type: 'stdio',
    transport: new StdioClientTransport({
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      env
    })
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

export async function connectMcpClient(
  config: PluginMcpServerConfig,
  serverName: string
): Promise<McpClientHandle> {
  const connectTimeoutMs = Math.min(
    DEFAULT_CONNECT_TIMEOUT_MS,
    config.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  )
  const { transport } = buildTransport(config)
  const client = new Client({ name: 'flex-agent', version: '0.1.0' })
  const handle: McpClientHandle = { client, serverName, closed: false }
  try {
    // SDK connect() performs initialize + notifications/initialized internally.
    await withTimeout(client.connect(transport), connectTimeoutMs, `MCP server ${serverName} connect`)
  } catch (err) {
    handle.closed = true
    try {
      await client.close()
    } catch {
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
  return handle
}

export async function listMcpTools(handle: McpClientHandle): Promise<McpToolDescriptor[]> {
  const result = await handle.client.listTools()
  const out: McpToolDescriptor[] = []
  for (const tool of result.tools) {
    if (tool === null || typeof tool !== 'object') continue
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue
    out.push({
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.inputSchema !== null && typeof tool.inputSchema === 'object'
        ? { inputSchema: tool.inputSchema as Record<string, unknown> }
        : {})
    })
  }
  return out
}

export async function callMcpTool(
  handle: McpClientHandle,
  toolName: string,
  args: unknown,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<unknown> {
  return handle.client.callTool(
    {
      name: toolName,
      arguments:
        args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    },
    undefined,
    { timeout: timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) }
  )
}

export async function closeMcpClient(handle: McpClientHandle): Promise<void> {
  if (handle.closed) return
  handle.closed = true
  try {
    await handle.client.close()
  } catch {
  }
}
