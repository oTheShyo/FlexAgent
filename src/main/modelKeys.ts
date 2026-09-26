/**
 * Ticket 26 — where a model's API key actually lives.
 *
 * `models.json` belongs to PI and is loaded by `ModelConfig.load`, which
 * validates the whole file: an `apiKey` that is not a string fails the schema and
 * silently empties *every* custom model, and an `apiKey` that is a string is used
 * verbatim as the bearer token. So the file cannot hold an encrypted object, and
 * holding an encrypted string would only move the secret — the kernel would still
 * send it.
 *
 * What it *can* hold is a reference. `ModelRuntime.setRuntimeApiKey()` injects a
 * credential that outranks the configured one, and when a credential is present
 * the configured value is never resolved at all (measured: `scripts/probe-runtime-
 * apikey-header.mjs` — a provider whose models.json key is an unresolvable
 * `${FLEXAGENT_KEY_...}` template still sends the injected key, and sends nothing
 * when no key was injected). So:
 *
 *   models.json   → `${FLEXAGENT_KEY_<PROVIDER>}` (a name, not a secret)
 *   this file     → the real key, sealed by `credentialVault`
 *   worker        → decrypts via IPC and calls `setRuntimeApiKey`
 *
 * Nothing secret is on disk in plaintext, and nothing goes through the
 * environment — an env var would be inherited by every bash subprocess the agent
 * spawns, which is a wider exposure than the file we are protecting.
 *
 * A key the user wrote as their own template (`$MY_KEY`, `!op item get ...`) is
 * left exactly as it is: that is PI's own feature and it is not our secret.
 */
import { homedir } from 'os'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { ContractError } from '../shared/contract'
import {
  CredentialError,
  decryptSecret,
  encryptSecret,
  isEnvelope,
  UNREADABLE_MARK
} from './security/credentialVault'

/** Sealed model keys, outside PI's own directory on purpose. */
export function modelKeysFilePath(): string {
  return join(homedir(), '.flexagent', 'model-keys.json')
}

/**
 * The reference written into `models.json`. Provider ids allow `-`, env var
 * names do not, so the id is folded to `[A-Za-z0-9_]`: an unfolds-able name would
 * be treated as a literal and would quietly become the bearer token instead of
 * failing loudly.
 */
export function managedKeyTemplate(providerId: string): string {
  return `\${FLEXAGENT_KEY_${providerId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}}`
}

/** True for the reference above, false for a real key or the user's own template. */
export function isManagedKey(value: unknown): boolean {
  return typeof value === 'string' && /^\$\{FLEXAGENT_KEY_[A-Za-z0-9_]+\}$/.test(value.trim())
}

export interface ModelKeysRead {
  /** Plaintext key by provider id. Entries that would not decrypt are absent. */
  keys: Record<string, string>
  /** Providers whose stored value could not be opened; reported, never dropped. */
  unreadable: string[]
}

interface StoredShape {
  keys?: Record<string, unknown>
}

function readStore(): StoredShape {
  const file = modelKeysFilePath()
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A corrupt store is not an empty store: the keys may still be recoverable
    // and an overwrite would destroy them. Surface it instead.
    throw new ContractError(
      'KERNEL_INTERNAL',
      `Model key store is unreadable: ${file} — not overwriting it`
    )
  }
  const keys = (parsed as StoredShape | null)?.keys
  return typeof keys === 'object' && keys !== null && !Array.isArray(keys)
    ? { keys: keys as Record<string, unknown> }
    : {}
}

/** Same discipline as `mcp.json`: tmp + rename, so a crash cannot truncate it. */
function writeStore(store: StoredShape): void {
  const file = modelKeysFilePath()
  mkdirSync(dirname(file), { recursive: true })
  const sorted: Record<string, unknown> = {}
  for (const name of Object.keys(store.keys ?? {}).sort()) sorted[name] = store.keys?.[name]
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ keys: sorted }, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

export function readModelKeys(): ModelKeysRead {
  const stored = readStore().keys ?? {}
  const keys: Record<string, string> = {}
  const unreadable: string[] = []
  for (const [provider, value] of Object.entries(stored)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (value === UNREADABLE_MARK) {
      unreadable.push(provider)
      continue
    }
    try {
      keys[provider] = decryptSecret(value, `model key for "${provider}"`)
    } catch {
      unreadable.push(provider)
    }
  }
  return { keys, unreadable }
}

/** Seal one provider's key. An empty plaintext removes the entry instead. */
export function putModelKey(provider: string, plaintext: string): void {
  const store = readStore()
  const keys = { ...(store.keys ?? {}) }
  if (plaintext.trim().length === 0) delete keys[provider]
  else keys[provider] = encryptSecret(plaintext.trim())
  writeStore({ keys })
}

export function dropModelKey(provider: string): void {
  const store = readStore()
  const keys = { ...(store.keys ?? {}) }
  if (keys[provider] === undefined) return
  delete keys[provider]
  writeStore({ keys })
}

/**
 * A pre-vault install kept its key in `models.json` as plaintext. Move it here
 * and hand back the reference to write in its place. Returns undefined when the
 * value is not ours to move (the user's own template, or already a reference).
 */
export function adoptPlaintextKey(provider: string, value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0 || isManagedKey(trimmed)) return undefined
  // `$FOO` / `!cmd` are PI features the user chose; moving them would break them
  // and would put someone else's secret source into our store.
  if (trimmed.startsWith('$') || trimmed.startsWith('!')) return undefined
  if (isEnvelope(trimmed)) return undefined
  putModelKey(provider, trimmed)
  return managedKeyTemplate(provider)
}

/**
 * Move a stored key to a new provider id without opening it. Re-sealing would
 * mean decrypting in the main process for no reason — the envelope is already
 * opaque and the algorithm it names does not change.
 */
export function moveModelKey(from: string, to: string): boolean {
  if (from === to) return false
  const store = readStore()
  const keys = store.keys ?? {}
  if (keys[from] === undefined || keys[to] !== undefined) return false
  const next = { ...keys }
  next[to] = keys[from]
  delete next[from]
  writeStore({ keys: next })
  return true
}

/** Lets callers distinguish "no key" from "no readable key" without importing errors. */
export { CredentialError as ModelKeyCredentialError }
