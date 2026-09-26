/**
 * Credential vault — secrets at rest for the config files this app owns.
 *
 * `~/.flexagent/mcp.json` used to hold API tokens in plain text: one file any
 * process running as the user can read, one file that ends up in screenshots,
 * sync folders and bug reports. This module is the seam that keeps those values
 * sealed on disk and plain only inside the window where they are in use.
 *
 * Two codecs, one on-disk shape. Every secret is stored as
 *
 *     `<alg>|<base64>`
 *
 * where `alg` records *how* the value was sealed, so a reader can pick the
 * right decoder instead of trusting the file to say what it is:
 *
 *  - `ss1` — Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux
 *    libsecret). The OS holds the key; it is bound to the logged-in user and
 *    is not handed to anything else running as them. This is the real thing
 *    and is what runs in the app.
 *  - `hv1` — AES-256-GCM behind a 256-bit key in `~/.flexagent/vault.key`.
 *    Used when `safeStorage` is missing or refuses to encrypt, which is every
 *    non-Electron runner: this repo's QA scripts and any `node` diagnostic.
 *    Weaker — it protects the file against a casual copy, not against the user
 *    who owns it — but it never writes a plaintext key either, and refusing to
 *    store the secret at all would be worse than storing it in the weakest
 *    form available.
 *
 * Why an envelope *string* and not an envelope *object*: `env` and `headers`
 * are `{ [name: string]: string }` in the contract, and both files this vault
 * serves are read by code that knows nothing about encryption. An object would
 * be a contract change in both the types and the IPC payload; a string is
 * invisible to the caller. That is the whole point — the layers above should
 * not be able to tell the vault is here, so there is no side-channel for a
 * future change to leak through.
 *
 * What this module deliberately does *not* do: it never logs a plaintext or an
 * envelope (both are readable artefacts), and it never turns a decryption
 * failure into an empty configuration — the caller decides what is usable, see
 * `UNREADABLE_MARK` and `decryptSecret`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

/** `ss1` = Electron safeStorage, `hv1` = hermetic AES-256-GCM. */
export type VaultAlgorithm = 'ss1' | 'hv1'

/**
 * Stands in for a value that could not be decrypted. Left *in place* — dropping
 * the entry would be the one thing worse than an unreadable one: the server
 * would disappear from the list, and the user would have no idea why.
 */
export const UNREADABLE_MARK = '__vault_unreadable__'

/** `ss1|<base64>` or `hv1|<base64>`. Padding and `+/` are expected inside. */
const ENVELOPE_RE = /^(ss1|hv1)\|[A-Za-z0-9+/]+={0,2}$/

const KEY_FILE_NAME = 'vault.key'
const KEY_BYTES = 32
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16

/**
 * Raised when a stored credential cannot be turned back into the value the
 * user typed. Messages are written to be acted on ("delete the entry and
 * re-enter the token"), never to be printed as-is into a log line: the secret
 * itself is never part of one.
 */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialError'
  }
}

function algorithmOf(envelope: string): VaultAlgorithm | undefined {
  return ENVELOPE_RE.test(envelope) ? (envelope.slice(0, 3) as VaultAlgorithm) : undefined
}

export function isEnvelope(value: unknown): boolean {
  return typeof value === 'string' && algorithmOf(value) !== undefined
}

interface Codec {
  alg: VaultAlgorithm
  encrypt(plaintext: string): string
  decrypt(envelope: string): string
}

/** The slice of Electron's `safeStorage` this module needs. */
interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * `electron` is only resolvable inside the Electron main build, and importing
 * it statically breaks every plain-node bundle of a module that reaches this
 * one (the resolution happens at build time, the absence only at run time).
 * Resolving the handle on first use keeps both worlds working.
 */
function safeStorageHandle(): SafeStorageLike | undefined {
  try {
    const electron = require('electron') as { safeStorage?: SafeStorageLike } | undefined
    const safeStorage = electron?.safeStorage
    if (safeStorage === undefined) return undefined
    // `isEncryptionAvailable` is false on Linux without a keyring, and throws
    // in odd environments. Either way: not usable, so a codec that throws on
    // every call would only turn a missing keyring into a broken config.
    try {
      if (!safeStorage.isEncryptionAvailable()) return undefined
    } catch {
      return undefined
    }
    return safeStorage
  } catch {
    return undefined
  }
}

/**
 * Windows DPAPI / macOS Keychain / Linux libsecret. The OS key outlives nothing
 * we control and is revoked with the user profile, which is exactly the property
 * `hv1` cannot offer.
 */
function safeStorageCodec(handle: SafeStorageLike): Codec {
  const prefix = 'ss1|'
  return {
    alg: 'ss1',
    encrypt: (plaintext) => prefix + handle.encryptString(plaintext).toString('base64'),
    decrypt: (envelope) => handle.decryptString(Buffer.from(envelope.slice(prefix.length), 'base64'))
  }
}

/** `~/.flexagent/vault.key`, minted on first use. */
function vaultKeyPath(): string {
  return join(homedir(), '.flexagent', KEY_FILE_NAME)
}

function loadVaultKey(): Buffer {
  const path = vaultKeyPath()
  let key: Buffer
  try {
    key = readFileSync(path)
  } catch {
    key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(path), { recursive: true })
    // 0600 is the point: the key is the root of trust for everything sealed
    // with `hv1`, and a world-readable key file turns every envelope back into
    // plaintext for whoever reads it next. Best effort — Windows ignores the
    // mode, and a crash between the two calls is a key that gets rewritten.
    writeFileSync(path, key, { mode: 0o600 })
  }
  if (key.length !== KEY_BYTES) {
    // A truncated or hand-edited file is not a key. Re-mint rather than derive
    // a 256-bit key out of arbitrary bytes, and rather than refuse to ever
    // store a secret.
    key = randomBytes(KEY_BYTES)
    writeFileSync(path, key, { mode: 0o600 })
  }
  return key
}

/** AES-256-GCM. No KDF: the key is already 256 bits of randomness. */
function hermeticCodec(): Codec {
  const key = loadVaultKey()
  const prefix = 'hv1|'
  return {
    alg: 'hv1',
    encrypt: (plaintext) => {
      const iv = randomBytes(GCM_IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return prefix + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    },
    decrypt: (envelope) => {
      const raw = Buffer.from(envelope.slice(prefix.length), 'base64')
      if (raw.length <= GCM_IV_BYTES + GCM_TAG_BYTES) {
        throw new CredentialError('the payload is shorter than its own header')
      }
      const iv = raw.subarray(0, GCM_IV_BYTES)
      const tag = raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES)
      const body = raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    }
  }
}

let cached: Codec | undefined

/** Resolve the codec once per process; exposed so logs can name the alg. */
export function vaultAlgorithm(): VaultAlgorithm {
  return codec().alg
}

function codec(): Codec {
  if (cached === undefined) {
    const handle = safeStorageHandle()
    cached = handle === undefined ? hermeticCodec() : safeStorageCodec(handle)
  }
  return cached
}

/** Seal a plaintext. The only writer-facing entry point. */
export function encryptSecret(plaintext: string): string {
  return codec().encrypt(plaintext)
}

/**
 * The codec a given envelope was sealed with. Deliberately *not* `codec()`:
 * an envelope from another backend — or from an install whose key file is gone
 * — has to be decoded by the backend it names, and guessing wrong turns a
 * recoverable read into a fresh outage.
 */
function codecFor(alg: VaultAlgorithm): Codec {
  if (alg === 'ss1') {
    const handle = safeStorageHandle()
    if (handle !== undefined) return safeStorageCodec(handle)
  }
  return hermeticCodec()
}

/**
 * Open one envelope. Throws `CredentialError` — callers decide whether that
 * stops an edit or only a display, but nothing here returns a partial value.
 */
export function decryptSecret(envelope: string, where: string): string {
  const alg = algorithmOf(envelope)
  if (alg === undefined) {
    throw new CredentialError(`${where} is not a credential envelope — refusing to treat it as one`)
  }
  // Re-read the codec instead of using `resolved`: the file may have been
  // sealed by a different backend (or by a previous install whose key file is
  // gone), and guessing wrong would turn a recoverable read into a new outage.
  try {
    return codecFor(alg).decrypt(envelope)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new CredentialError(
      `The stored credential for ${where} could not be decrypted (${reason}). ` +
        'The value is still in the file — delete this entry and enter the token again, ' +
        'or check that the credential backend is available.'
    )
  }
}
