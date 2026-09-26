/**
 * Ticket 26 — the model API key leaves `models.json`.
 *
 * The kernel loads that file with a whole-file schema check, so the key cannot
 * become an encrypted object (one bad provider empties every custom model) and
 * cannot become an encrypted string either (the kernel would send it as the
 * bearer token). What it becomes is a *reference*: the real key is sealed in
 * `~/.flexagent/model-keys.json` and injected into the runtime at start-up, which
 * the kernel prefers over the configured value — see
 * `scripts/probe-runtime-apikey-header.mjs` for the measurement that decided it.
 *
 * Asserted here, in the order the ticket lists them:
 *   存 · 取 · 迁移 · 失败, plus the cases that decide whether this is safe at
 *   all (the user's own `$MY_KEY` is left alone; a deleted provider does not keep
 *   its key; a reference whose key is gone reads as unset rather than configured).
 *
 * `electron` is left external, so this exercises the `hv1` fallback — the codec
 * every non-Electron runner gets, and the one that has to work on CI.
 *
 *   node scripts/qa-model-key-vault.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = process.cwd()
const OUT = join(ROOT, 'out', 'qa', 'model-keys')
/** Deliberately key-shaped: long enough that redaction would notice it too. */
const PLAINTEXT = 'sk-proj-9f3Kd8Zq2LtVbXn7RwYc4'
const PROVIDER = 'ustc-provider'
const MODEL_ID = 'qwen3-8b-chat'

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${!condition && detail ? ` — ${detail}` : ''}`)
}

function freshHome(label) {
  const root = mkdtempSync(join(tmpdir(), `flexagent-mk-${label}-`))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.USERPROFILE = home
  process.env.HOME = home
  return { root, home }
}

async function bundle() {
  await build({
    entryPoints: [
      join(ROOT, 'src/main/modelKeys.ts'),
      join(ROOT, 'src/main/userModels.ts'),
      join(ROOT, 'src/main/security/credentialVault.ts')
    ],
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
    outExtension: { '.js': '.mjs' },
    external: ['electron']
  })
}

const load = (name) =>
  import(`${pathToFileURL(join(OUT, `${name}.mjs`)).href}?t=${Date.now()}`)

/**
 * Reload the bundle for each case.
 *
 * Not paranoia: the vault codec is resolved per module instance, so an instance
 * created under one HOME keeps that HOME's key. Reusing it across a `freshHome()`
 * would encrypt with one key and decrypt with another, which is a failure of the
 * harness rather than of the code under test — and it would read as one.
 */
async function fresh() {
  const [keys, models, vault] = await Promise.all([
    load('modelKeys'),
    load('userModels'),
    load('security/credentialVault') // esbuild keeps the entry points' layout
  ])
  return { keys, models, vault }
}

async function main() {
  await bundle()

  // ── 存: a saved key is not on disk in the models file ──────────────────────
  {
    const { home } = freshHome('save')
    const { keys, models, vault } = await fresh()
    const file = join(home, 'models.json')
    writeFileSync(file, '{}\n', 'utf8')
    const service = new models.UserModelsService()
    await service.save(file, {
      provider: PROVIDER,
      id: MODEL_ID,
      baseUrl: 'https://api.example.invalid/v1',
      api: 'openai-completions',
      apiKey: PLAINTEXT
    })

    const onDisk = readFileSync(file, 'utf8')
    check('models.json no longer contains the key', !onDisk.includes(PLAINTEXT), 'plaintext present')
    const stored = JSON.parse(onDisk)
    const declared = stored.providers[PROVIDER].apiKey
    check('the entry holds a vault reference', keys.isManagedKey(declared), String(declared))
    check('the reference names this provider', declared === keys.managedKeyTemplate(PROVIDER))
    check(
      'the reference is a legal env var name (so a missing key fails loudly)',
      /^\$\{FLEXAGENT_KEY_[A-Za-z0-9_]+\}$/.test(declared),
      'a name with "-" would resolve to a literal and be sent as the token'
    )
    check(
      'the rest of the entry survived',
      stored.providers[PROVIDER].baseUrl === 'https://api.example.invalid/v1' &&
        stored.providers[PROVIDER].models[0].id === MODEL_ID
    )
    check('the key store exists', existsSync(keys.modelKeysFilePath()))
    const sealed = JSON.parse(readFileSync(keys.modelKeysFilePath(), 'utf8')).keys[PROVIDER]
    check('what the store holds is an envelope', vault.isEnvelope(sealed), String(sealed).slice(0, 24))
    check('the store does not hold the key either', !readFileSync(keys.modelKeysFilePath(), 'utf8').includes(PLAINTEXT))
  }

  // ── 取: it comes back ──────────────────────────────────────────────────────
  {
    const { home } = freshHome('read')
    const { keys, models, vault } = await fresh()
    const file = join(home, 'models.json')
    writeFileSync(file, '{}\n', 'utf8')
    const service = new models.UserModelsService()
    await service.save(file, {
      provider: PROVIDER,
      id: MODEL_ID,
      baseUrl: 'https://api.example.invalid/v1',
      api: 'openai-completions',
      apiKey: PLAINTEXT
    })
    const read = keys.readModelKeys()
    check('the key comes back byte for byte', read.keys[PROVIDER] === PLAINTEXT)
    check('nothing was reported unreadable', read.unreadable.length === 0)
    check('the list still marks the key as set', service.list(file).some((m) => m.apiKeySet === true))
  }

  // ── 迁移: a pre-vault file is adopted on the read path ─────────────────────
  {
    const { home } = freshHome('migrate')
    const { keys, models, vault } = await fresh()
    const file = join(home, 'models.json')
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: 'https://api.example.invalid/v1',
            api: 'openai-completions',
            apiKey: PLAINTEXT,
            models: [{ id: MODEL_ID }]
          }
        }
      }),
      'utf8'
    )
    // No save: an upgrade that only moves keys when the user edits the provider
    // leaves the secret in place indefinitely.
    const moved = await models.migratePlaintextKeys(file)
    check('the migration names the provider it moved', moved.includes(PROVIDER), moved.join(','))
    check('the migrated file has no plaintext', !readFileSync(file, 'utf8').includes(PLAINTEXT))
    check('the migrated key is readable', keys.readModelKeys().keys[PROVIDER] === PLAINTEXT)
    check('a second pass moves nothing', (await models.migratePlaintextKeys(file)).length === 0)
  }

  // ── 失败: an unreadable value is reported, not dropped ─────────────────────
  {
    const { home } = freshHome('fail')
    const { keys, models, vault } = await fresh()
    const file = join(home, 'models.json')
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: 'https://api.example.invalid/v1',
            api: 'openai-completions',
            apiKey: keys.managedKeyTemplate(PROVIDER),
            models: [{ id: MODEL_ID }]
          }
        }
      }),
      'utf8'
    )
    mkdirSync(join(home, '.flexagent'), { recursive: true })
    writeFileSync(
      keys.modelKeysFilePath(),
      JSON.stringify({ keys: { [PROVIDER]: 'hv1|not-really-a-ciphertext' } }, null, 2),
      'utf8'
    )
    const read = keys.readModelKeys()
    check('the broken entry is reported', read.unreadable.includes(PROVIDER))
    check('it is not handed over as a key', read.keys[PROVIDER] === undefined)
    const service = new models.UserModelsService()
    check(
      'and the model no longer claims to be configured',
      service.list(file).every((m) => m.apiKeySet !== true),
      'a reference with no key behind it must not read as set'
    )
    check(
      'the provider is named for cleanup',
      models.staleManagedProviders(file).includes(PROVIDER)
    )
  }

  // ── the user's own template is theirs, not ours ────────────────────────────
  {
    const { home } = freshHome('template')
    const { keys, models, vault } = await fresh()
    const file = join(home, 'models.json')
    writeFileSync(file, '{}\n', 'utf8')
    const service = new models.UserModelsService()
    await service.save(file, {
      provider: PROVIDER,
      id: MODEL_ID,
      baseUrl: 'https://api.example.invalid/v1',
      api: 'openai-completions',
      apiKey: '$MY_OWN_KEY'
    })
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    check("a user's env template is stored verbatim", stored.providers[PROVIDER].apiKey === '$MY_OWN_KEY')
    check('and nothing was put in the vault', keys.readModelKeys().keys[PROVIDER] === undefined)
  }

  // ── a deleted provider does not keep its key ───────────────────────────────
  {
    const { home } = freshHome('remove')
    const { keys, models, vault } = await fresh()
    const file = join(home, 'models.json')
    writeFileSync(file, '{}\n', 'utf8')
    const service = new models.UserModelsService()
    await service.save(file, {
      provider: PROVIDER,
      id: MODEL_ID,
      baseUrl: 'https://api.example.invalid/v1',
      api: 'openai-completions',
      apiKey: PLAINTEXT
    })
    await service.remove(file, { provider: PROVIDER, id: MODEL_ID })
    check('the key is gone with the provider', keys.readModelKeys().keys[PROVIDER] === undefined)
  }

  // ── a renamed provider keeps its credential ────────────────────────────────
  {
    const { home } = freshHome('rename')
    const { keys, models, vault } = await fresh()
    const file = join(home, 'models.json')
    writeFileSync(file, '{}\n', 'utf8')
    const service = new models.UserModelsService()
    await service.save(file, {
      provider: PROVIDER,
      id: MODEL_ID,
      baseUrl: 'https://api.example.invalid/v1',
      api: 'openai-completions',
      apiKey: PLAINTEXT
    })
    await service.save(file, {
      provider: 'new-name',
      id: MODEL_ID,
      baseUrl: 'https://api.example.invalid/v1',
      api: 'openai-completions',
      original: { provider: PROVIDER, id: MODEL_ID }
    })
    const read = keys.readModelKeys()
    check('the key follows the provider', read.keys['new-name'] === PLAINTEXT)
    check('and leaves the old id', read.keys[PROVIDER] === undefined)
  }

  // ── the worker side never puts a key in a log line ─────────────────────────
  {
    const worker = readFileSync(join(ROOT, 'src/main/worker.ts'), 'utf8')
    // Bounded by the function's own return: slicing to the next blank-line `}`
    // swallowed the rest of the file and picked up unrelated `process.env` uses,
    // which failed this case for the wrong reason.
    const start = worker.indexOf('async function applyModelKeys')
    const END = 'return { applied, failed, cleared }'
    const body = worker.slice(start, worker.indexOf(END, start) + END.length)
    check('applyModelKeys exists', body.length > 0)
    check('its error log names the provider, not the key', /console\.error\([\s\S]{0,200}\$\{provider\}/.test(body))
    check('its error log does not interpolate the key', !/\$\{key\}/.test(body))
    check('it injects through the runtime, not the environment', body.includes('setRuntimeApiKey') && !body.includes('process.env'))
    check(
      'and it drops keys for providers that lost them',
      body.includes('removeRuntimeApiKey') && body.includes('clear')
    )
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks green`)
  if (failed.length > 0) {
    console.log(`FAILING: ${failed.map((f) => f.name).join('; ')}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
