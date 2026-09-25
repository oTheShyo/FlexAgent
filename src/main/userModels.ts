/**
 * User-defined models — the kernel's own `models.json`.
 *
 * The file belongs to PI (`getAgentDir()/models.json`), so this service never
 * guesses its location: the caller passes the path the kernel reported. It owns
 * exactly one thing — *editing* that file without breaking what the kernel
 * expects:
 *
 *   { "providers": { "<providerId>": {
 *       "name"?, "baseUrl"?, "apiKey"?, "api"?, "headers"?, "compat"?,
 *       "models": [ { "id", "name"?, "api"?, "contextWindow"?, … } ],
 *       "modelOverrides"?
 *   } } }
 *
 * Three rules keep it safe:
 *  - **Surgical writes.** The document is parsed to plain objects, one entry is
 *    changed, the rest is written back untouched (key order, model order and
 *    indentation included). Hand-written fields this service does not know about
 *    (`modelOverrides`, `compat`, cost tables, future keys) survive.
 *  - **Validate what PI refuses.** A provider entry PI cannot compose is worse
 *    than no entry: `ModelConfig.load` validates the *whole file*, so one bad
 *    provider silently empties every custom model. The checks here mirror
 *    `modelFromJson` in PI's provider-composer.
 *  - **Never move secrets.** An omitted `apiKey` means "keep the stored one", so
 *    adding a model to an existing provider cannot wipe its credential.
 *
 * Errors are ContractErrors so the renderer sees a specific reason.
 */
import { ContractError, CUSTOM_MODEL_APIS } from '../shared/contract'
import type {
  CustomModelApi,
  CustomModelEntry,
  CustomModelRef,
  CustomModelSaveInput,
  CustomModelWriteResult
} from '../shared/contract'
import { asString, isRecord, readJsonDocument, writeJsonDocument } from './jsonFile'
import type { JsonDocument } from './jsonFile'

const PROVIDER_RE = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_ID_LENGTH = 200
/**
 * Provider keys that outlive their last model: these change how the provider
 * behaves for *other* models (a built-in's baseUrl, `modelOverrides`, headers),
 * so removing them would be collateral damage. `baseUrl`/`apiKey`/`api` are
 * deliberately absent — they exist to serve the models that are now gone, and a
 * deleted model should not leave a key behind on disk.
 */
const PROVIDER_KEEP_KEYS = ['modelOverrides', 'headers', 'compat', 'oauth', 'name']

interface Document extends JsonDocument {
  providers: Record<string, Record<string, unknown>>
}

/** Read + parse, then lift the provider map out of the root. */
function readDocument(path: string): Document {
  const document = readJsonDocument(path, 'models.json')
  const providers: Record<string, Record<string, unknown>> = {}
  const declared = document.root.providers
  if (isRecord(declared)) {
    for (const [id, entry] of Object.entries(declared)) {
      if (isRecord(entry)) providers[id] = { ...entry }
    }
  }
  return { ...document, providers }
}

function requireProvider(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_RE.test(value)) {
    throw new ContractError(
      'INVALID_INPUT',
      'Provider must match [a-zA-Z0-9_-]{1,64} (e.g. "openai", "ustc")'
    )
  }
  return value
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError('INVALID_INPUT', 'Model id is required')
  }
  const id = value.trim()
  if (id.length > MAX_ID_LENGTH) {
    throw new ContractError('INVALID_INPUT', `Model id must be at most ${MAX_ID_LENGTH} characters`)
  }
  return id
}

function normalizeLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ContractError('INVALID_INPUT', 'Display name must be a string')
  const label = value.trim()
  return label.length > 0 ? label : undefined
}

function normalizeBaseUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError('INVALID_INPUT', 'Base URL must be a non-empty string')
  }
  const url = value.trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ContractError('INVALID_INPUT', `Base URL is not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ContractError('INVALID_INPUT', 'Base URL must start with http:// or https://')
  }
  return url.replace(/\/+$/, '')
}

function normalizeApi(value: unknown): CustomModelApi | undefined {
  if (value === undefined) return undefined
  const api = CUSTOM_MODEL_APIS.find((candidate) => candidate === value)
  if (api === undefined) {
    throw new ContractError('INVALID_INPUT', `Unsupported API type: ${String(value)}`)
  }
  return api
}

/**
 * `apiKey` may be a literal secret or a PI config template (`$MY_KEY`,
 * `${MY_KEY}`); both are stored verbatim. `undefined` keeps the stored value.
 */
function normalizeApiKey(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError('INVALID_INPUT', 'API key must be a non-empty string (or left blank to keep it)')
  }
  return value.trim()
}

function normalizeRef(input: CustomModelRef | undefined): CustomModelRef | undefined {
  if (input === undefined) return undefined
  if (!isRecord(input)) throw new ContractError('INVALID_INPUT', 'Expected { provider, id }')
  return { provider: requireProvider(input.provider), id: requireId(input.id) }
}

function modelEntries(provider: Record<string, unknown>): Record<string, unknown>[] {
  const models = provider.models
  if (!Array.isArray(models)) return []
  return models.filter(isRecord)
}

function summarize(providers: Record<string, Record<string, unknown>>): CustomModelEntry[] {
  const out: CustomModelEntry[] = []
  for (const providerId of Object.keys(providers).sort()) {
    const config = providers[providerId]
    const baseUrl = asString(config.baseUrl)
    const apiKeySet = asString(config.apiKey) !== undefined
    for (const model of modelEntries(config)) {
      const id = asString(model.id)
      if (id === undefined) continue
      const label = asString(model.name)
      const api = asString(model.api) ?? asString(config.api)
      out.push({
        provider: providerId,
        id,
        ...(label !== undefined && label !== id ? { label } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(api !== undefined ? { api } : {}),
        ...(model.reasoning === true ? { reasoning: true } : {}),
        apiKeySet
      })
    }
  }
  return out
}

async function persist(document: Document): Promise<void> {
  const providers: Record<string, unknown> = {}
  // Provider keys are sorted for a stable diff; model arrays keep file order.
  for (const key of Object.keys(document.providers).sort()) providers[key] = document.providers[key]
  document.root = { ...document.root, providers }
  await writeJsonDocument(document, 'models.json')
}

/** Drop an entry, and its provider once nothing meaningful is left in it. */
function dropEntry(document: Document, ref: CustomModelRef): boolean {
  const provider = document.providers[ref.provider]
  if (provider === undefined) return false
  const models = modelEntries(provider).filter((model) => asString(model.id) !== ref.id)
  if (models.length === modelEntries(provider).length) return false
  if (models.length > 0) {
    provider.models = models
    return true
  }
  const keepsProvider = PROVIDER_KEEP_KEYS.some((key) => provider[key] !== undefined)
  if (keepsProvider) {
    provider.models = []
    return true
  }
  delete document.providers[ref.provider]
  return true
}

export class UserModelsService {
  /** Every custom model across every provider entry. Never returns secrets. */
  list(file: string): CustomModelEntry[] {
    return summarize(readDocument(file).providers)
  }

  /**
   * Create or update one model. `file` is the path the kernel reported
   * (`kernel.modelsPath()`), never a path computed here.
   */
  async save(file: string, input: CustomModelSaveInput): Promise<UserModelsWrite> {
    if (!isRecord(input)) {
      throw new ContractError('INVALID_INPUT', 'expected { provider, id, baseUrl, apiKey, api }')
    }
    const providerId = requireProvider(input.provider)
    const id = requireId(input.id)
    const label = normalizeLabel(input.label)
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const api = normalizeApi(input.api)
    const apiKey = normalizeApiKey(input.apiKey)
    const original = normalizeRef(input.original)

    const document = readDocument(file)
    // A rename edits *the* entry; without this the write would leave two.
    if (original !== undefined && (original.provider !== providerId || original.id !== id)) {
      dropEntry(document, original)
    }

    const provider = document.providers[providerId] ?? {}
    // `undefined` means "leave what is stored": a blank key field in the form
    // must never wipe an existing credential.
    if (baseUrl !== undefined) provider.baseUrl = baseUrl
    if (api !== undefined) provider.api = api
    if (apiKey !== undefined) provider.apiKey = apiKey

    const existing = modelEntries(provider)
    const current = existing.find((model) => asString(model.id) === id)
    const next: Record<string, unknown> = {}
    if (current !== undefined) Object.assign(next, current)
    next.id = id
    if (label !== undefined) next.name = label
    else if (next.name === id) delete next.name
    // `reasoning` gates PI's thinking-level menu (a model without it reports
    // only `off`). Explicit true/false writes/clears; omitted keeps the stored
    // value so hand-tuned entries are not silently downgraded.
    if (input.reasoning === true) next.reasoning = true
    else if (input.reasoning === false) delete next.reasoning
    // Replace in place, append otherwise — the file's own order is meaningful
    // (it is what the model picker shows) and a re-sort would rewrite it.
    const at = existing.findIndex((model) => asString(model.id) === id)
    if (at >= 0) existing[at] = next
    else existing.push(next)
    provider.models = existing
    document.providers[providerId] = provider

    assertComposable(providerId, provider)
    await persist(document)
    const providers = [providerId]
    // A rename can leave the old provider with nothing to serve.
    if (original !== undefined && original.provider !== providerId) providers.push(original.provider)
    return {
      result: { models: summarize(document.providers) },
      providers,
      ref: { provider: providerId, id }
    }
  }

  async remove(file: string, input: CustomModelRef): Promise<UserModelsWrite> {
    const ref = normalizeRef(input)
    if (ref === undefined) throw new ContractError('INVALID_INPUT', 'expected { provider, id }')
    const document = readDocument(file)
    if (!dropEntry(document, ref)) {
      throw new ContractError('CUSTOM_MODEL_NOT_FOUND', `Unknown custom model: ${ref.provider}/${ref.id}`)
    }
    await persist(document)
    return {
      result: { models: summarize(document.providers) },
      providers: [ref.provider],
      ref
    }
  }
}

/** What one write produced — plus what the kernel has to be asked to re-check. */
export interface UserModelsWrite {
  result: CustomModelWriteResult
  /** Provider ids the write touched; a rename can touch two. */
  providers: string[]
  /** The entry the write targeted, for the post-write kernel verification. */
  ref: CustomModelRef
}

/**
 * Reject what PI would reject at composition time — see `modelFromJson` in
 * provider-composer.ts: a custom model needs `api` and `baseUrl` (model- or
 * provider-level), and a provider needs an auth method to be usable at all.
 */
function assertComposable(providerId: string, provider: Record<string, unknown>): void {
  if (asString(provider.baseUrl) === undefined) {
    throw new ContractError(
      'INVALID_INPUT',
      `Provider "${providerId}" needs a Base URL — the kernel cannot route a custom model without one`
    )
  }
  if (asString(provider.api) === undefined) {
    throw new ContractError(
      'INVALID_INPUT',
      `Provider "${providerId}" needs an API type (the kernel refuses a custom model with no "api")`
    )
  }
  if (asString(provider.apiKey) === undefined) {
    throw new ContractError(
      'INVALID_INPUT',
      `Provider "${providerId}" needs an API key — without one the kernel registers no models for it`
    )
  }
}
