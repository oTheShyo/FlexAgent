/**
 * Probe 2 (ticket 26): the decisive one.
 *
 * Probe 1 showed `setRuntimeApiKey` exists and that an unresolvable env template
 * in models.json does not break composition. But composition is lazy — the
 * template is only resolved when a request is made. So what matters is what
 * lands in the Authorization header.
 *
 * Setup: one throwaway HTTP server per case (so a late request from the previous
 * case cannot be mistaken for this one's), a provider whose models.json apiKey is
 * `${FLEXAGENT_KEY_ABSENT}` — a template with no env var behind it.
 *
 *   injected    → expect `Bearer sk-REAL-KEY-0000`
 *   not injected→ expect no request, or a request that fails to resolve the key
 *
 * First draft of this probe got the two cases confused by timing: the request
 * from case 1 arrived after case 1 had given up waiting, and was logged as case
 * 2's. Each case now owns its server and its agent dir.
 *
 * Run: node scripts/probe-runtime-apikey-header.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL = 'sk-REAL-KEY-0000'
const PROVIDER = 'probe-provider'

async function startServer() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization ?? null })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'probe-model' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, hits, port: server.address().port }
}

async function waitForHit(hits, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (hits.length > 0) return hits[0]
    await new Promise((r) => setTimeout(r, 40))
  }
  return null
}

const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')

async function attempt(label, { inject }) {
  const { server, hits, port } = await startServer()
  const dir = mkdtempSync(join(tmpdir(), 'pi-headerprobe-'))
  const modelsPath = join(dir, 'models.json')
  writeFileSync(
    modelsPath,
    JSON.stringify(
      {
        providers: {
          [PROVIDER]: {
            name: 'Probe',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: 'openai-completions',
            apiKey: '${FLEXAGENT_KEY_ABSENT}',
            models: [{ id: 'probe-model', name: 'Probe Model' }]
          }
        }
      },
      null,
      2
    )
  )

  let note = ''
  try {
    const runtime = await ModelRuntime.create({
      modelsPath,
      refreshOnCreate: false,
      allowModelNetwork: false
    })
    if (inject) await runtime.setRuntimeApiKey(PROVIDER, REAL)
    const model = runtime.getModel(PROVIDER, 'probe-model')
    if (model === undefined) {
      note = 'no model composed'
    } else {
      // Deliberately not awaited: we only care whether the request goes out and
      // with which header. Draining an API we do not implement would fail anyway.
      void runtime
        .streamSimple(model, { messages: [{ role: 'user', content: 'hi' }] })
        .catch?.(() => undefined)
    }
  } catch (err) {
    note = `threw — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
  }

  const hit = await waitForHit(hits, 5000)
  console.log(
    `${label.padEnd(26)} request=${hit ? hit.url : 'NONE'}  authorization=${hit ? hit.auth : 'NONE'}${note ? `  (${note})` : ''}`
  )
  server.close()
  rmSync(dir, { recursive: true, force: true })
}

await attempt('injected', { inject: true })
await attempt('not injected', { inject: false })
