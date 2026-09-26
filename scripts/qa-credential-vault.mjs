/**
 * Credential vault regression — the four paths the vault is judged on:
 * **存** (a secret lands sealed), **取** (it comes back usable and stays sealed),
 * **迁移** (a pre-vault plaintext file is re-sealed in place), **失败** (nothing
 * is silently dropped and the error says what to do).
 *
 * Plus one negative case that is the point of the whole ticket: if a secret
 * reaches a log sink, the redaction layer catches it before it reaches JSONL.
 *
 *   node scripts/qa-credential-vault.mjs
 *
 * `electron` is aliased to scripts/stubs/electron-safeStorage.mjs for the first
 * bundle, so the `ss1` path runs the real codec against a fake native module.
 * The second bundle leaves `electron` external — which is what every non-Electron
 * runner resolves it to (this repo's other QA scripts, `node` diagnostics) — and
 * asserts the `hv1` fallback. Each bundle is imported after its own throwaway
 * USERPROFILE.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = process.cwd()
const SS1_DIR = join(ROOT, 'out', 'qa', 'ss1')
const HERMETIC_DIR = join(ROOT, 'out', 'qa', 'hv1')

const HTTP_TOKEN = 'Bearer sk-proj-9f3Kd8Zq2LtVbXn7RwYc4'
const STDIO_TOKEN = 'ghp_2Kd8Zq2LtVbXn7RwYc4Mp5Qs6Tf9'
/** Short on purpose: the vault is the primary control, redaction is the backstop. */
const SHORT_TOKEN = 'sk-abc123'

const results = []

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail && !condition ? ` — ${detail}` : ''}`)
}

/** Collect console output produced while `fn` runs. */
async function capture(fn) {
  const info = console.info
  const error = console.error
  const lines = []
  console.info = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  try {
    return { value: await fn(), lines }
  } finally {
    console.info = info
    console.error = error
  }
}

function freshHome(label) {
  const root = mkdtempSync(join(tmpdir(), `flexagent-vault-${label}-`))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.FLEXAGENT_AUDIT_HOME = join(root, 'audit')
  return { root, home, mcpFile: join(home, '.flexagent', 'mcp.json') }
}

const readDisk = (mcpFile) => JSON.parse(readFileSync(mcpFile, 'utf8'))

function writeDisk(mcpFile, servers) {
  writeFileSync(mcpFile, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8')
}

async function bundle(outDir, electron) {
  await build({
    entryPoints: [
      join(ROOT, 'src/main/userMcp.ts'),
      join(ROOT, 'src/main/security/auditLog.ts'),
      join(ROOT, 'src/main/security/credentialVault.ts')
    ],
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
    outExtension: { '.js': '.mjs' },
    ...electron
  })
}

const load = (dir, name) =>
  import(`${pathToFileURL(join(dir, name.replace(/\.js$/, '.mjs'))).href}?t=${Date.now()}`)

async function main() {
  await bundle(SS1_DIR, {
    alias: { electron: join(ROOT, 'scripts', 'stubs', 'electron-safeStorage.mjs') }
  })
  await bundle(HERMETIC_DIR, { external: ['electron'] })

  // ── 存 / 取 / 失败, against the ss1 codec ──────────────────────────────────
  const { home, mcpFile } = freshHome('ss1')
  const { UserMcpService } = await load(SS1_DIR, 'userMcp.js')
  const { vaultAlgorithm, isEnvelope, UNREADABLE_MARK } = await load(SS1_DIR, 'security/credentialVault.js')
  const { recordAudit, readAudit } = await load(SS1_DIR, 'security/auditLog.js')

  check('vault picks the safeStorage codec when Electron provides one', vaultAlgorithm() === 'ss1')

  const service = new UserMcpService()
  await service.save({
    name: 'qa-http',
    config: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: HTTP_TOKEN } }
  })
  await service.save({
    name: 'qa-stdio',
    config: {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_TOKEN: STDIO_TOKEN, PATH: '/usr/bin' }
    }
  })

  // 存: the file on disk is the artefact that matters.
  const onDisk = readDisk(mcpFile)
  const diskText = readFileSync(mcpFile, 'utf8')
  check(
    'no plaintext token in mcp.json after save',
    !diskText.includes(HTTP_TOKEN) && !diskText.includes(STDIO_TOKEN)
  )
  check(
    'stored secret values are envelopes',
    isEnvelope(onDisk.mcpServers['qa-http'].headers.Authorization) &&
      isEnvelope(onDisk.mcpServers['qa-stdio'].env.API_TOKEN)
  )
  check(
    'a secret-bearing field is sealed as a whole, harmless-looking keys included',
    isEnvelope(onDisk.mcpServers['qa-stdio'].env.PATH)
  )
  check(
    'fields outside the secret map are untouched',
    onDisk.mcpServers['qa-stdio'].command === 'node' &&
      JSON.stringify(onDisk.mcpServers['qa-http'].url) === '"https://example.com/mcp"'
  )

  // 取: the caller gets the plaintext back; the file keeps its sealed copy.
  const listed = await service.list()
  check(
    'list() returns the plaintext the user typed',
    listed.find((s) => s.name === 'qa-http')?.config.headers.Authorization === HTTP_TOKEN &&
      listed.find((s) => s.name === 'qa-stdio')?.config.env.API_TOKEN === STDIO_TOKEN
  )
  check(
    'reading does not disturb the sealed file',
    readFileSync(mcpFile, 'utf8') === diskText
  )

  // 失败: a well-formed envelope the backend refuses to open.
  const tampered = `ss1|${Buffer.from('not what safeStorage produced', 'utf8').toString('base64')}`
  writeDisk(mcpFile, {
    ...onDisk.mcpServers,
    'qa-http': { ...onDisk.mcpServers['qa-http'], headers: { Authorization: tampered } }
  })
  const failed = await capture(() => service.list())
  check(
    'an unreadable entry is kept, not dropped',
    failed.value.some((s) => s.name === 'qa-http'),
    'the entry disappeared from list()'
  )
  check(
    'the unreadable value is replaced by a visible marker',
    failed.value.find((s) => s.name === 'qa-http')?.config.headers.Authorization === UNREADABLE_MARK
  )
  check(
    'the failure is reported by name, never by value',
    failed.lines.some((line) => line.includes('qa-http') && line.includes('unreadable')),
    failed.lines.join(' | ')
  )
  check(
    'the failure line carries none of the stored ciphertext',
    !failed.lines.some((line) => line.includes(tampered))
  )

  const strictError = await capture(() =>
    service
      .save({
        name: 'qa-http',
        config: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'fresh-token' } }
      })
      .then(
        () => null,
        (err) => err
      )
  )
  const message = strictError.value?.message ?? ''
  check('an edit of an unreadable entry is refused', strictError.value !== null)
  check(
    'the refusal is actionable and names the entry',
    message.includes('qa-http') && /delete|re-enter the token/i.test(message),
    message
  )
  check(
    'the refused write left the stored value untouched',
    readDisk(mcpFile).mcpServers['qa-http'].headers.Authorization === tampered
  )

  // 迁移: a file written before the vault existed.
  writeDisk(mcpFile, {
    'legacy-http': { type: 'http', url: 'https://legacy.example.com/mcp', headers: { Authorization: HTTP_TOKEN } },
    'legacy-stdio': { type: 'stdio', command: 'node', env: { API_TOKEN: STDIO_TOKEN } }
  })
  const migrated = await capture(() => service.list())
  check('a plaintext file still loads', migrated.value.some((s) => s.name === 'legacy-http'))
  check(
    'migration writes a log line',
    migrated.lines.some((line) => line.includes('[credential-vault]') && line.includes('migrated')),
    migrated.lines.join(' | ')
  )
  const afterMigration = readDisk(mcpFile)
  check(
    'migration rewrites the file with envelopes',
    !JSON.stringify(afterMigration).includes(HTTP_TOKEN) &&
      !JSON.stringify(afterMigration).includes(STDIO_TOKEN) &&
      isEnvelope(afterMigration.mcpServers['legacy-http'].headers.Authorization)
  )
  check(
    'migration keeps every entry and its non-secret fields',
    Object.keys(afterMigration.mcpServers).sort().join(',') === 'legacy-http,legacy-stdio' &&
      afterMigration.mcpServers['legacy-stdio'].command === 'node'
  )

  // ── 日志: if a secret does reach a log sink ────────────────────────────────
  await service.save({
    name: 'qa-log',
    config: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: SHORT_TOKEN } }
  })
  recordAudit({
    kind: 'redaction',
    sessionId: 'qa',
    tool: 'mcp',
    outcome: 'secrets-sealed',
    // The whole file, not one field: this is the worst case a future caller
    // can hand to an audit entry, and what the vault has to survive.
    target: readFileSync(mcpFile, 'utf8')
  })
  const auditText = readFileSync(join(process.env.FLEXAGENT_AUDIT_HOME, 'permissions.jsonl'), 'utf8')
  const auditEntry = JSON.parse(
    auditText
      .split('\n')
      .filter((line) => line.includes('"tool":"mcp"'))
      .at(-1)
  )
  check(
    'a secret reaching the audit sink is masked',
    !JSON.stringify(auditEntry).includes(SHORT_TOKEN),
    auditEntry.target
  )
  check('the masked line still records that something was there', auditText.includes('[[redacted]]'))
  check(
    'the migration log line carries no value',
    !migrated.lines.some((line) => line.includes(HTTP_TOKEN) || line.includes(STDIO_TOKEN)),
    migrated.lines.join(' | ')
  )

  // ── hv1: what every non-Electron runner gets ───────────────────────────────
  const hermetic = freshHome('hv1')
  const { UserMcpService: HermeticService } = await load(HERMETIC_DIR, 'userMcp.js')
  const { vaultAlgorithm: hermeticAlg } = await load(HERMETIC_DIR, 'security/credentialVault.js')
  check('no usable safeStorage means the hermetic codec', hermeticAlg() === 'hv1')
  const hermeticService = new HermeticService()
  await hermeticService.save({
    name: 'hv1-http',
    config: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: HTTP_TOKEN } }
  })
  const hermeticDisk = readFileSync(join(hermetic.home, '.flexagent', 'mcp.json'), 'utf8')
  check('the fallback still stores no plaintext', !hermeticDisk.includes(HTTP_TOKEN))
  check(
    'the fallback still reads back',
    (await hermeticService.list()).find((s) => s.name === 'hv1-http')?.config.headers.Authorization ===
      HTTP_TOKEN
  )

  for (const { root } of [home, hermetic.root]) rmSync(root, { recursive: true, force: true })

  const broken = results.filter((r) => !r.ok)
  console.log(`\n${results.length - broken.length}/${results.length} passed`)
  if (broken.length > 0) {
    console.log(`FAILED: ${broken.map((r) => r.name).join(', ')}`)
    process.exit(1)
  }
  console.log('PASS  credential vault: 存 / 取 / 迁移 / 失败 / 日志 all green')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
