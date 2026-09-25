/**
 * Measure what MCP actually costs today, so "lazy connect" is an argument about
 * milliseconds rather than a matter of taste.
 *
 *   node scripts/probe-mcp-connect.mjs            # every enabled server in ~/.flexagent/mcp.json
 *   node scripts/probe-mcp-connect.mjs --hang     # add a server that never answers (worst case)
 *
 * The number that matters is `connect + list`, because `attachSession` in
 * src/main/worker.ts awaits exactly that before `createAgentSession` runs.
 */
import { mkdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const OUT = join(process.cwd(), 'out', 'probe')
mkdirSync(OUT, { recursive: true })
const bundle = join(OUT, 'mcpClient.mjs')

await build({
  entryPoints: ['src/main/mcp/mcpClient.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['@modelcontextprotocol/*'],
  logLevel: 'error'
})

const { connectMcpClient, listMcpTools, closeMcpClient } = await import(pathToFileURL(bundle).href)

const file = join(homedir(), '.flexagent', 'mcp.json')
let servers = {}
try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  servers = parsed.mcpServers ?? parsed
} catch (err) {
  console.log(`(no usable ${file}: ${err.message})`)
}

const cases = Object.entries(servers)
  .filter(([, config]) => config.enabled !== false)
  .map(([name, config]) => ({
    name,
    config: { ...config, command: config.command, args: config.args ?? [] }
  }))

if (process.argv.includes('--hang')) {
  cases.push({
    name: 'hang-sim',
    config: {
      type: 'stdio',
      command: process.platform === 'win32' ? 'cmd' : 'sleep',
      args: process.platform === 'win32' ? ['/c', 'ping', '-n', '30', '127.0.0.1'] : ['30']
    }
  })
}

if (cases.length === 0) {
  console.log('no enabled MCP servers configured')
  process.exit(0)
}

let total = 0
for (const item of cases) {
  const started = Date.now()
  let phase = 'connect'
  try {
    const handle = await connectMcpClient(item.config, item.name)
    const connectMs = Date.now() - started
    phase = 'listTools'
    const tools = await listMcpTools(handle)
    const totalMs = Date.now() - started
    total += totalMs
    console.log(
      `${item.name.padEnd(12)} ${String(totalMs).padStart(6)}ms  (connect ${connectMs}ms, list ${
        totalMs - connectMs
      }ms, ${tools.length} tools)`
    )
    await closeMcpClient(handle)
  } catch (err) {
    const ms = Date.now() - started
    total += ms
    console.log(`${item.name.padEnd(12)} ${String(ms).padStart(6)}ms  FAILED at ${phase}: ${err.message}`)
  }
}

console.log(`\ntotal if these run on the attach critical path: ${total}ms`)
