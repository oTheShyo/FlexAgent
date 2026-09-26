// issue 23 evidence: SSE transport end-to-end.
//
// Public SSE endpoints are vanishing (deepwiki /sse → 410, context7 /sse → 404
// — both diagnosed cleanly by our transport), so this drives the REAL protocol
// stack over the network: SDK's official SSEServerTransport hosts an MCP
// server (HTTP + SSE stream + POST message channel), and the client side is
// the exact same `connectMcpClient` buildTransport path the main process uses.
import { build } from 'esbuild'
import { createServer } from 'http'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { pathToFileURL } from 'url'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const SRC = join(ROOT, 'src', 'main')

// --- bundle the client exactly like the app uses it ---
const work = mkdtempSync(join(tmpdir(), 'flex-sse-ev-'))
const entry = join(work, 'entry.mjs')
writeFileSync(entry, `export * from ${JSON.stringify(join(SRC, 'mcp', 'mcpClient.ts'))}\n`, 'utf8')
const outfile = join(ROOT, 'scripts', '_sse-evidence-bundle.mjs')
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);' },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
rmSync(outfile, { force: true })
rmSync(work, { recursive: true, force: true })

// --- a real MCP server speaking HTTP+SSE (SDK official server transport) ---
const { SSEServerTransport } = await import(
  pathToFileURL(join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'sse.js')).href
)
const { McpServer } = await import(
  pathToFileURL(join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'mcp.js')).href
)
const { z } = await import('zod')

const sessions = new Map()
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/sse') {
    const transport = new SSEServerTransport('/messages', res)
    const server = new McpServer({ name: 'sse-evidence-server', version: '1.0.0' })
    server.tool('echo', 'Echo back the given message', { message: z.string() }, async ({ message }) => ({
      content: [{ type: 'text', text: `echo: ${message}` }]
    }))
    await server.connect(transport)
    sessions.set(transport.sessionId, { transport, server })
    return
  }
  if (req.method === 'POST' && url.pathname.startsWith('/messages')) {
    const sessionId = url.searchParams.get('sessionId')
    const session = sessionId !== null ? sessions.get(sessionId) : undefined
    if (session === undefined) {
      res.writeHead(404).end()
      return
    }
    await session.transport.handlePostMessage(req, res)
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen))
const port = httpServer.address().port

// --- client: the app's own transport construction ---
console.log(`connecting SSE transport to http://127.0.0.1:${port}/sse …`)
const handle = await mod.connectMcpClient(
  { type: 'sse', url: `http://127.0.0.1:${port}/sse`, env: {} },
  'sse-evidence'
)
console.log('1. connect (initialize + notifications/initialized): OK')

const tools = await mod.listMcpTools(handle)
console.log(`2. listTools: OK → ${tools.map((t) => t.name).join(', ')}`)

const result = await mod.callMcpTool(handle, 'echo', { message: 'issue 23 sse works' }, 15000)
const text = Array.isArray(result?.content) ? result.content.map((c) => c.text ?? '').join('') : ''
console.log(`3. callTool echo → "${text}"`)
if (text !== 'echo: issue 23 sse works') {
  console.error('UNEXPECTED tool result')
  process.exitCode = 1
}
await mod.closeMcpClient(handle)
console.log('4. close: OK')

// --- error path: a refused connection must fail fast with a diagnosis ---
console.log('\nerror path: connecting to a closed port …')
const t0 = Date.now()
try {
  await mod.connectMcpClient({ type: 'sse', url: 'http://127.0.0.1:1/sse', env: {} }, 'refused-evidence')
  console.error('UNEXPECTED: connect resolved')
  process.exitCode = 1
} catch (err) {
  console.log(`rejected in ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`)
}

httpServer.close()
console.log(process.exitCode === 1 ? '\nSSE evidence: FAIL' : '\nSSE evidence: PASS')
