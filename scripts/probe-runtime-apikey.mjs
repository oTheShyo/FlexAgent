/**
 * Probe: does `ModelRuntime.setRuntimeApiKey` actually override the apiKey that
 * models.json declares, and does it do so WITHOUT resolving that on-disk value?
 *
 * This decides the whole design for ticket 26. If the runtime key wins, the plan
 * is: models.json holds a harmless placeholder, the real key lives encrypted in
 * the vault, and the worker injects it into the runtime at startup — nothing
 * secret on disk, nothing secret in env (so it cannot leak into the bash
 * subprocesses the agent spawns).
 *
 * If it does not win, or if the on-disk value is still resolved (and therefore
 * still has to be a real key), the plan changes and this file records why.
 *
 * Run: node scripts/probe-runtime-apikey.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'pi-runtimekey-'))
const modelsPath = join(dir, 'models.json')

const PROVIDER = 'probe-provider'
const PLACEHOLDER = 'placeholder-not-a-real-key'
const REAL = 'sk-REAL-KEY-0000'

// The placeholder deliberately contains no `$`, so if PI ever resolves it, it
// stays a literal instead of throwing on a missing env var. That is the
// difference between "falls back to a bad key" and "throws at compose time".
writeFileSync(
  modelsPath,
  JSON.stringify(
    {
      providers: {
        [PROVIDER]: {
          name: 'Probe',
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          apiKey: PLACEHOLDER,
          models: [{ id: 'probe-model', name: 'Probe Model' }]
        }
      }
    },
    null,
    2
  )
)

const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')

const runtime = await ModelRuntime.create({
  modelsPath,
  // No network: this is about credential composition, not availability.
  refreshOnCreate: false,
  allowModelNetwork: false
})

const before = runtime.getProvider(PROVIDER)
console.log('provider present before injection:', before !== undefined)
console.log('  models before:', (runtime.getModels(PROVIDER) ?? []).map((m) => m.id))

try {
  await runtime.setRuntimeApiKey(PROVIDER, REAL)
  console.log('setRuntimeApiKey: OK')
} catch (err) {
  console.log('setRuntimeApiKey FAILED:', err instanceof Error ? err.message : String(err))
}

const after = runtime.getProvider(PROVIDER)
console.log('provider present after injection:', after !== undefined)
console.log('  models after:', (runtime.getModels(PROVIDER) ?? []).map((m) => m.id))

// The decisive question: what key will actually be sent? `getProvider` returns a
// composed Provider whose `auth` (if exposed) is what reaches the header.
console.log('--- provider object keys ---')
console.log(Object.keys(after ?? {}).join(', '))
const auth = after?.auth
console.log('auth:', JSON.stringify(auth ?? null))

// And: did resolving the on-disk placeholder ever happen? If PI had resolved it,
// an env-shaped value would have thrown inside compose. We can also test that
// directly by making the on-disk value a template that cannot resolve.

writeFileSync(
  modelsPath,
  JSON.stringify(
    {
      providers: {
        [PROVIDER]: {
          name: 'Probe',
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          apiKey: '${FLEXAGENT_KEY_DOES_NOT_EXIST}',
          models: [{ id: 'probe-model', name: 'Probe Model' }]
        }
      }
    },
    null,
    2
  )
)

console.log('--- second pass: on-disk value is an unresolvable env template ---')
try {
  const runtime2 = await ModelRuntime.create({
    modelsPath,
    refreshOnCreate: false,
    allowModelNetwork: false
  })
  const p2 = runtime2.getProvider(PROVIDER)
  console.log('provider composed with unresolvable template:', p2 !== undefined)
  await runtime2.setRuntimeApiKey(PROVIDER, REAL)
  console.log('setRuntimeApiKey after template: OK')
  console.log('auth now:', JSON.stringify(runtime2.getProvider(PROVIDER)?.auth ?? null))
} catch (err) {
  console.log('unresolvable template / injection FAILED:', err instanceof Error ? err.message : String(err))
}

rmSync(dir, { recursive: true, force: true })
