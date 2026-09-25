/**
 * Security-layer logic check — no Electron, no model calls.
 *
 *   node scripts/diag-security.mjs
 *
 * Covers the layers added for the security chapter:
 *   - output filtering (`redactSecrets`)
 *   - the credential-path boundary, exercised through the **real** gate
 *   - the permission audit trail (write, redact-on-write, read back)
 *
 * The real TypeScript sources are bundled with esbuild and imported, the same
 * way `perm-regress.mjs` does it — reading them from source guarantees this
 * checks shipped behaviour, not a copy of it.
 *
 * Runs against throwaway FLEXAGENT_AUDIT_HOME and never touches the live
 * `~/.flexagent/audit` log. `~/.flexagent/permissions.json` is not read either:
 * rules are passed in explicitly.
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const home = mkdtempSync(join(tmpdir(), 'flexagent-security-diag-'))
process.env.FLEXAGENT_AUDIT_HOME = join(home, 'audit')

const OUT = join(process.cwd(), 'out', 'probe')
mkdirSync(OUT, { recursive: true })

async function bundleModule(entry, name) {
  const outfile = join(OUT, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error'
  })
  return import(pathToFileURL(outfile).href)
}

const { redactSecrets, findSecretKinds } = await bundleModule(
  'src/main/security/secretPatterns.ts',
  'security-secrets'
)
const { classifySensitivePath, commandTouchesSensitivePath } = await bundleModule(
  'src/main/security/sensitivePaths.ts',
  'security-paths'
)
const { recordAudit, readAudit, hashArgs, AUDIT_HOME } = await bundleModule(
  'src/main/security/auditLog.ts',
  'security-audit'
)
const { PermissionGate, PermissionMemory } = await bundleModule(
  'src/main/permissionGate.ts',
  'security-gate'
)
const { BUILTIN_RULES } = await bundleModule('src/main/permissionRules.ts', 'security-rules')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const gate = new PermissionGate()
let memory = new PermissionMemory('diag-session')
const evaluate = (toolName, args, mode = 'default') =>
  gate.evaluate(
    { toolName, args },
    {
      mode,
      cwd: join(home, 'workspace'),
      rules: [...BUILTIN_RULES],
      memory,
      sessionId: 'diag-session'
    }
  )

try {
  // -- output filtering ------------------------------------------------------
  const openai = redactSecrets('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345')
  check('masks an env-style provider key', !openai.text.includes('sk-proj-'), openai.text)
  check('reports the secret kind', openai.hits.some((h) => h.kind === 'openai-key'))

  const pem = redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow…\n-----END RSA PRIVATE KEY-----')
  check('masks a PEM private key block', pem.text.includes('[[redacted]]:private-key'))

  const header = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij')
  check('masks a bearer/JWT header', header.hits.length > 0, header.text)

  const url = redactSecrets('postgres://admin:hunter2secret@db.internal:5432/app')
  check('masks url userinfo but keeps host', url.text.includes('db.internal:5432') && !url.text.includes('hunter2secret'), url.text)

  const prose = 'Rotate the API key before the next release; the token TTL is 15 minutes.'
  check('leaves ordinary prose alone (no false positive)', redactSecrets(prose).text === prose)

  const code = 'const apiKey = process.env.OPENAI_API_KEY'
  check('leaves env indirection alone', redactSecrets(code).text === code, redactSecrets(code).text)

  check('findSecretKinds dedupes', findSecretKinds('sk-' + 'a'.repeat(30) + ' ' + 'sk-' + 'b'.repeat(30)).length === 1)

  // -- credential path classification ---------------------------------------
  check('~/.ssh is a credential location', classifySensitivePath('/home/u/.ssh/id_rsa')?.kind === 'ssh-directory')
  check('project .env is a credential location', classifySensitivePath('/repo/.env')?.kind === 'env-file')
  check('.env.example is exempt', classifySensitivePath('/repo/.env.example') === undefined)
  check('.npmrc is a credential location', classifySensitivePath('/home/u/.npmrc')?.kind === 'package-registry-token')
  check('kube config is a credential location', classifySensitivePath('/home/u/.kube/config')?.kind === 'cloud-credentials')
  check('source file is not a credential location', classifySensitivePath('/repo/src/index.ts') === undefined)
  check('cat ~/.ssh/id_rsa is detected inside a command', commandTouchesSensitivePath('cat ~/.ssh/id_rsa')?.kind === 'ssh-directory')

  // -- boundary through the real gate ---------------------------------------
  memory = new PermissionMemory('diag-session')
  const readEnv = await evaluate('read', { file_path: '/repo/.env' })
  check('reading a project .env asks', readEnv.outcome === 'ask', readEnv.verdict.reason)

  const readSrc = await evaluate('read', { file_path: '/repo/src/index.ts' })
  check('reading a normal source file still allows', readSrc.outcome === 'allow', readSrc.verdict.reason)

  const writeKey = await evaluate('write', { file_path: '/home/u/.ssh/id_rsa', content: 'x' })
  check('writing a private key is refused', writeKey.outcome === 'deny', writeKey.verdict.reason)

  const writeKeyBypass = await evaluate('write', { file_path: '/home/u/.ssh/id_rsa', content: 'x' }, 'bypass')
  check('bypass mode does not lift the credential refusal', writeKeyBypass.outcome === 'deny')

  const rmKey = await evaluate('bash', { command: 'rm ~/.ssh/id_rsa' })
  check('deleting a private key is refused', rmKey.outcome === 'deny', rmKey.verdict.reason)

  const catKey = await evaluate('bash', { command: 'cat ~/.ssh/id_rsa' })
  check('cat on a private key asks (was auto-allowed before)', catKey.outcome === 'ask', catKey.verdict.reason)

  const ls = await evaluate('bash', { command: 'ls -la' })
  check('ordinary read-only bash still allows', ls.outcome === 'allow', ls.verdict.reason)

  const writeEnv = await evaluate('write', { file_path: '/repo/.env.local', content: 'A=1' })
  check('writing a .env is refused', writeEnv.outcome === 'deny', writeEnv.verdict.reason)

  const plainWrite = await evaluate('write', { file_path: join(home, 'workspace', 'src', 'app.ts'), content: 'x' })
  check('workspace writes unaffected', plainWrite.outcome === 'allow', plainWrite.verdict.reason)

  const envIndirection = 'OPENAI_API_KEY=${OPENAI_API_KEY}\napiKey: process.env.OPENAI_API_KEY'
  check('env indirection survives both shapes', redactSecrets(envIndirection).text === envIndirection, redactSecrets(envIndirection).text)

  // Once the user explicitly allows the same call, session memory wins — the
  // boundary is a default for strangers, not a straitjacket for the owner.
  memory.record('read', PermissionMemory.fingerprintArgs({ file_path: '/repo/.env' }))
  const readEnvAgain = await evaluate('read', { file_path: '/repo/.env' })
  check('an explicit session allowance still overrides the ask', readEnvAgain.outcome === 'allow', readEnvAgain.verdict.via)

  const ruleWide = await gate.evaluate(
    { toolName: 'read', args: { file_path: '/repo/.env' } },
    {
      mode: 'default',
      cwd: join(home, 'workspace'),
      rules: [{ id: 'allow-everything', tool: '*', action: 'allow' }, ...BUILTIN_RULES],
      memory: new PermissionMemory('fresh'),
      sessionId: 'fresh'
    }
  )
  check('a blanket rules.json allow cannot open credential paths', ruleWide.outcome === 'ask', ruleWide.verdict.via)

  // -- audit trail -----------------------------------------------------------
  recordAudit({
    kind: 'permission',
    sessionId: 'sess-1',
    tool: 'bash',
    outcome: 'allow',
    via: 'heuristic',
    mode: 'default',
    reason: 'read-only command',
    argsHash: hashArgs('command=ls -la'),
    target: 'curl -H "Authorization: Bearer sk-' + 'z'.repeat(30) + '" https://x'
  })
  const entries = readAudit(10)
  check('audit records a decision', entries.length === 1 && entries[0].tool === 'bash')
  check('audit stores a hashed argument fingerprint', entries[0].argsHash === hashArgs('command=ls -la'))
  check('audit masks secrets inside its own fields', !JSON.stringify(entries).includes('sk-zzz'), entries[0].target)
  check('audit log exists at the overridden home', existsSync(join(AUDIT_HOME, 'permissions.jsonl')))
  check(
    'audit file is append-only JSONL',
    readFileSync(join(AUDIT_HOME, 'permissions.jsonl'), 'utf8').trim().split('\n').length === 1
  )

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
