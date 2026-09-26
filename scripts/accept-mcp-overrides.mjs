// issue 23 evidence: plugin MCP server enable/disable override semantics.
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { pathToFileURL } from 'url'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const SRC = join(ROOT, 'src', 'main')

const work = mkdtempSync(join(tmpdir(), 'flex-ovr-ev-'))
const entry = join(work, 'entry.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(SRC, 'pluginMcp.ts'))}\nexport * from ${JSON.stringify(join(SRC, 'pluginMcpOverrides.ts'))}\n`,
  'utf8'
)
const outfile = join(ROOT, 'scripts', '_ovr-evidence-bundle.mjs')
// Stub electron: overrides land under a temp userData instead of the real one.
const stub = join(work, 'electron-stub.mjs')
writeFileSync(
  stub,
  'export const app = { getPath: () => process.env.FLEX_OVR_USER_DATA ?? "." }\nexport const ipcMain = {}\nexport const BrowserWindow = undefined\n',
  'utf8'
)
await build({
  entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20',
  alias: { electron: stub },
  banner: { js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);' },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
rmSync(outfile, { force: true })
rmSync(work, { recursive: true, force: true })
// Redirect the override file into a temp dir (stubbed app.getPath('userData')).
const userData = mkdtempSync(join(tmpdir(), 'flex-ovr-user-'))
process.env.FLEX_OVR_USER_DATA = userData

let passed = 0
let failed = 0
function ok(name, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`) } else { failed += 1; console.log(`  FAIL  ${name}`) }
}

// --- override file round-trip (writes to the real plugins storage root —
// acceptable: the file only exists in dev workspaces and starts empty) ---
mod.setPluginMcpServerOverride('plugin:demo:one', false)
mod.setPluginMcpServerOverride('plugin:demo:two', true)
const stored = mod.listPluginMcpServerOverrides()
ok('override file round-trips', stored['plugin:demo:one']?.enabled === false && stored['plugin:demo:two']?.enabled === true)

// --- collection semantics ---
function collectFor(server, overrides) {
  const root = mkdtempSync(join(tmpdir(), 'flex-ovr-plug-'))
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { srv: server } }), 'utf8')
  const result = mod.collectMcpServerConfigs({
    rootPath: root,
    manifest: { name: 'demo', version: '1.0.0' },
    dataPath: root, cwd: root, pluginId: 'demo', pluginName: 'demo',
    userConfigValues: {}, sensitiveKeys: [],
    interpolate: (t) => t,
    createEnvOverlay: () => ({}),
    ...(overrides !== undefined ? { overrides } : {})
  })
  rmSync(root, { recursive: true, force: true })
  return result
}

const r1 = collectFor({ type: 'http', url: 'https://example.com/mcp' }, undefined)
ok('default: server without override is collected', r1.paths.length === 1)

const r2 = collectFor({ type: 'http', url: 'https://example.com/mcp' }, { 'plugin:demo:srv': { enabled: false } })
ok('override false: server is skipped', r2.paths.length === 0)

const r3 = collectFor({ type: 'http', url: 'https://example.com/mcp', enabled: false }, { 'plugin:demo:srv': { enabled: true } })
ok('author disabled + user enabled: server is collected', r3.paths.length === 1)

const r4 = collectFor({ type: 'sse', url: 'https://example.com/sse' }, undefined)
ok('sse type: collected and typed', r4.paths.length === 1 && r4.configs['plugin:demo:srv']?.type === 'sse')

// sse with headers templates
const r5 = collectFor({ type: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer tok' } }, undefined)
ok('sse headers: carried through', r5.configs['plugin:demo:srv']?.headers?.Authorization === 'Bearer tok')

console.log(`\noverride evidence: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed})`)
process.exitCode = failed === 0 ? 0 : 1
