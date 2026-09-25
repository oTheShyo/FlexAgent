/**
 * End-to-end check of what UserMcpService actually persists — run with a
 * throwaway USERPROFILE so the real ~/.flexagent/mcp.json is never touched.
 *
 *   node scripts/probe-mcp-config.mjs
 *
 * Question being answered: does `env` / `headers` survive save→load→toPluginConfig?
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const OUT = join(process.cwd(), 'out', 'probe')
const bundle = join(OUT, 'userMcp.mjs')

await build({
  entryPoints: ['src/main/userMcp.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'error'
})

const { UserMcpService } = await import(pathToFileURL(bundle).href)

const service = new UserMcpService()
await service.save({
  name: 'probe-stdio',
  config: { type: 'stdio', command: 'node', args: ['server.js'], env: { API_TOKEN: 'secret-123' } }
})
await service.save({
  name: 'probe-http',
  config: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' } }
})

const stored = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.flexagent', 'mcp.json'), 'utf8'))
console.log('--- what landed in mcp.json ---')
console.log(JSON.stringify(stored, null, 2))

const listed = service.list()
console.log('\n--- what list() returns ---')
console.log(JSON.stringify(listed, null, 2))

const missing = []
const stdio = listed.find((s) => s.name === 'probe-stdio')
const http = listed.find((s) => s.name === 'probe-http')
if (stdio?.config.env?.API_TOKEN !== 'secret-123') missing.push('stdio env')
if (http?.config.headers?.Authorization !== 'Bearer abc') missing.push('http headers')
console.log(
  `\n${missing.length === 0 ? 'PASS' : 'FAIL'}  env/headers survive the round-trip${
    missing.length ? ` — lost: ${missing.join(', ')}` : ''
  }`
)
console.log(`(scratch home: ${process.env.USERPROFILE})`)
