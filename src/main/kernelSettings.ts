/**
 * How model requests leave the machine — stored in the kernel's own
 * `~/.pi/agent/settings.json`.
 *
 * These are PI's fields, not ours (`httpProxy`, `httpIdleTimeoutMs`,
 * `retry.maxRetries`), so the kernel's file is the right place: if PI ever
 * applies them in its SDK path on its own, nothing here has to change. Today it
 * does not — `applyHttpProxySettings` and `configureHttpDispatcher` are only
 * called from PI's CLI `main()` — which is why the worker applies them itself
 * and reports back whether that worked (see `worker.ts` `applyNetwork`).
 *
 * The write is surgical: `retry` keeps every key it already had, and unknown
 * keys anywhere in the file survive.
 */
import { ContractError } from '../shared/contract'
import type { SetNetworkInput } from '../shared/contract'
import { asString, isRecord, readJsonDocument, writeJsonDocument } from './jsonFile'

/** PI's `DEFAULT_HTTP_IDLE_TIMEOUT_MS`. */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000
/** PI's fallback for `retry.maxRetries`. */
export const DEFAULT_MAX_RETRIES = 3
const MAX_RETRIES = 10

const PROXY_PROTOCOLS = ['http:', 'https:', 'socks:', 'socks5:']

export interface NetworkConfig {
  proxy: string
  idleTimeoutMs: number
  maxRetries: number
}

function normalizeProxy(value: unknown): string {
  if (typeof value !== 'string') throw new ContractError('INVALID_INPUT', 'Proxy must be a string')
  const proxy = value.trim()
  if (proxy.length === 0) return ''
  let parsed: URL
  try {
    parsed = new URL(proxy)
  } catch {
    throw new ContractError('INVALID_INPUT', `Proxy is not a valid URL: ${proxy}`)
  }
  if (!PROXY_PROTOCOLS.includes(parsed.protocol)) {
    throw new ContractError(
      'INVALID_INPUT',
      `Proxy must start with ${PROXY_PROTOCOLS.map((scheme) => `${scheme}//`).join(', ')} — got ${parsed.protocol}//`
    )
  }
  return proxy
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ContractError('INVALID_INPUT', 'Idle timeout must be a non-negative number of milliseconds')
  }
  return Math.floor(value)
}

function normalizeRetries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_RETRIES) {
    throw new ContractError('INVALID_INPUT', `Max retries must be an integer between 0 and ${MAX_RETRIES}`)
  }
  return value
}

function readRetries(root: Record<string, unknown>, file: string): number {
  const retry = root.retry
  if (retry === undefined) return DEFAULT_MAX_RETRIES
  if (!isRecord(retry)) {
    throw new ContractError(
      'INVALID_INPUT',
      `"retry" in settings.json is not an object, so it cannot be edited without losing it. File: ${file}`
    )
  }
  const value = retry.maxRetries
  if (value === undefined) return DEFAULT_MAX_RETRIES
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_MAX_RETRIES
}

export class KernelSettingsService {
  /** Current network config. `file` is the path the kernel reported. */
  read(file: string): NetworkConfig {
    const document = readJsonDocument(file, 'settings.json')
    const proxy = asString(document.root.httpProxy) ?? ''
    const rawTimeout = document.root.httpIdleTimeoutMs
    const idleTimeoutMs =
      typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout >= 0
        ? Math.floor(rawTimeout)
        : DEFAULT_HTTP_IDLE_TIMEOUT_MS
    return { proxy, idleTimeoutMs, maxRetries: readRetries(document.root, file) }
  }

  /**
   * Apply a patch; omitted fields keep their current value *and their current
   * presence in the file*. A field the caller did not touch is not written, so
   * editing the proxy does not add an idle timeout the user never had.
   */
  async write(file: string, patch: SetNetworkInput): Promise<NetworkConfig> {
    const document = readJsonDocument(file, 'settings.json')
    const current = this.read(file)
    const next: NetworkConfig = {
      proxy: patch.proxy === undefined ? current.proxy : normalizeProxy(patch.proxy),
      idleTimeoutMs:
        patch.idleTimeoutMs === undefined
          ? current.idleTimeoutMs
          : normalizeTimeout(patch.idleTimeoutMs),
      maxRetries:
        patch.maxRetries === undefined ? current.maxRetries : normalizeRetries(patch.maxRetries)
    }
    if (patch.proxy !== undefined) {
      if (next.proxy.length === 0) delete document.root.httpProxy
      else document.root.httpProxy = next.proxy
    }
    if (patch.idleTimeoutMs !== undefined) document.root.httpIdleTimeoutMs = next.idleTimeoutMs
    if (patch.maxRetries !== undefined) {
      // Merge, never replace: `retry` also carries `enabled`, `baseDelayMs`,
      // `maxAgentDelayMs` and per-provider overrides.
      const retry = isRecord(document.root.retry) ? { ...document.root.retry } : {}
      if (next.maxRetries === DEFAULT_MAX_RETRIES) delete retry.maxRetries
      else retry.maxRetries = next.maxRetries
      if (Object.keys(retry).length === 0) delete document.root.retry
      else document.root.retry = retry
    }
    await writeJsonDocument(document, 'settings.json')
    return next
  }
}
