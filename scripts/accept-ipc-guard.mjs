// issue 21 acceptance: ipcGuard sender validation unit samples (pure logic).
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { createServer } from 'http'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const SRC = join(ROOT, 'src', 'main')

const work = mkdtempSync(join(tmpdir(), 'flex-accept-guard-'))
const entry = join(work, 'entry.mjs')
writeFileSync(entry, `export * from ${JSON.stringify(join(SRC, 'ipcGuard.ts'))}\n`, 'utf8')
// The bundle stays inside the project: `external: ['electron']` leaves a bare
// `import 'electron'` that Node resolves relative to the bundle's location,
// and only the project tree has electron installed.
const outfile = join(ROOT, 'scripts', '_guard-test-bundle.mjs')
// The electron import is stubbed: the pure-logic tests never touch Electron
// runtime objects, and importing the real electron package from a plain node
// process yields a CJS string export that cannot be destructured.
const stub = join(work, 'electron-stub.mjs')
writeFileSync(
  stub,
  'export const BrowserWindow = undefined\nexport const ipcMain = undefined\n',
  'utf8'
)
await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', alias: { electron: stub }, logLevel: 'silent' })
const { evaluateSender } = await import(pathToFileURL(outfile).href)
rmSync(outfile, { force: true })
rmSync(work, { recursive: true, force: true })

let passed = 0
let failed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    failures.push({ name, detail })
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function expect(name, facts, wantOk) {
  const verdict = evaluateSender(facts)
  ok(name, verdict.ok === wantOk, verdict.ok === wantOk ? undefined : `verdict: ${JSON.stringify(verdict)}`)
}

const DEV_URL = 'http://localhost:5173'
const RENDERER_ROOT = 'D:\\app\\FlexAgent\\out\\renderer'

// --- dev mode (ELECTRON_RENDERER_URL set) ---
expect('dev: main frame of vite origin accepts', {
  senderBelongsToAppWindow: true,
  frameUrl: `${DEV_URL}/src/main.tsx`,
  devRendererUrl: DEV_URL
}, true)

expect('dev: external https frame rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: 'https://evil.example/payload.html',
  devRendererUrl: DEV_URL
}, false)

expect('dev: devtools sender rejects (no app window)', {
  senderBelongsToAppWindow: false,
  frameUrl: 'devtools://devtools/bundled/inspector.html',
  devRendererUrl: DEV_URL
}, false)

// --- packaged mode (file:// renderer) ---
expect('packaged: bundled renderer index accepts', {
  senderBelongsToAppWindow: true,
  frameUrl: 'file:///D:/app/FlexAgent/out/renderer/index.html',
  rendererRoot: RENDERER_ROOT
}, true)

expect('packaged: renderer subpage accepts', {
  senderBelongsToAppWindow: true,
  frameUrl: 'file:///D:/app/FlexAgent/out/renderer/assets/preview.html',
  rendererRoot: RENDERER_ROOT
}, true)

expect('packaged: sibling directory prefix collision rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: 'file:///D:/app/FlexAgent/out/renderer-evil/index.html',
  rendererRoot: RENDERER_ROOT
}, false)

expect('packaged: foreign file path rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: 'file:///C:/Users/evil/evil.html',
  rendererRoot: RENDERER_ROOT
}, false)

expect('packaged: http frame rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: 'http://127.0.0.1:8080/phish.html',
  rendererRoot: RENDERER_ROOT
}, false)

expect('packaged: chrome-extension frame rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: 'chrome-extension://abcdef/popup.html',
  rendererRoot: RENDERER_ROOT
}, false)

// --- shared edge cases ---
expect('disposed frame rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: null,
  devRendererUrl: DEV_URL
}, false)

expect('about:blank frame rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: 'about:blank',
  devRendererUrl: DEV_URL
}, false)

expect('empty frame url rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: '',
  rendererRoot: RENDERER_ROOT
}, false)

expect('dev: lookalike origin with extra path prefix rejects', {
  senderBelongsToAppWindow: true,
  frameUrl: 'http://localhost:5173.evil.example/',
  devRendererUrl: DEV_URL
}, false)

console.log(`\naccept-ipc-guard: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed})`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
