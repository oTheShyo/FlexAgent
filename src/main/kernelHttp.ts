/**
 * The kernel's HTTP dispatcher, reached by file path.
 *
 * A proxy cannot be configured from outside PI's CLI: Node's default dispatcher
 * ignores `HTTP_PROXY`/`HTTPS_PROXY`, and PI only swaps in an
 * `EnvHttpProxyAgent` inside its CLI `main()`, which this app never runs. The
 * SDK path therefore has no proxy at all today.
 *
 * The functions that fix it are exported by `dist/core/http-dispatcher.js` but
 * **not** by the package's entry point, and PI's `exports` map has no wildcard,
 * so neither `import '@earendil-works/pi-coding-agent/dist/…'` nor a deep
 * `require.resolve` can reach them (both fail with
 * ERR_PACKAGE_PATH_NOT_EXPORTED — verified, not assumed).
 *
 * So the file is located by walking up from this bundle towards
 * `node_modules/@earendil-works/pi-coding-agent/…`, and imported by file URL.
 * Two consequences worth stating plainly:
 *
 *  - It depends on the kernel's internal layout. `resolveKernelHttpModule()`
 *    therefore checks the file exists before promising anything, and a miss is
 *    reported to the UI as `dispatcher: 'unavailable'` — the settings are then
 *    shown read-only rather than as fields that silently do nothing.
 *  - The dispatcher is per-thread. PI runs in this worker, so it is installed
 *    from here, not from the main process.
 */
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'

const RELATIVE_PATH = [
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'core',
  'http-dispatcher.js'
]

export interface KernelHttp {
  /** Fills in `HTTP_PROXY`/`HTTPS_PROXY` when they are empty. */
  applyProxy(proxy: string): void
  /** Installs (or re-installs) the global dispatcher with this idle timeout. */
  configureDispatcher(timeoutMs: number): void
}

interface KernelHttpModule {
  applyHttpProxySettings?: (proxy: string | undefined) => void
  configureHttpDispatcher?: (timeoutMs?: number) => void
}

/**
 * Walk up from this bundle looking for the kernel's dispatcher. `out/main`
 * (dev) and `resources/app.asar/out/main` (packaged) both reach the package the
 * same way.
 */
export function resolveKernelHttpModule(): string | null {
  let directory = __dirname
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, ...RELATIVE_PATH)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

let cached: Promise<KernelHttp | null> | null = null

/** Load once per worker; `null` when the kernel's internals moved. */
export function loadKernelHttp(): Promise<KernelHttp | null> {
  cached ??= (async () => {
    const path = resolveKernelHttpModule()
    if (path === null) return null
    const module = (await import(pathToFileURL(path).href)) as KernelHttpModule
    const applyProxy = module.applyHttpProxySettings
    const configureDispatcher = module.configureHttpDispatcher
    if (typeof applyProxy !== 'function' || typeof configureDispatcher !== 'function') {
      return null
    }
    return {
      applyProxy: (proxy: string) => applyProxy(proxy),
      configureDispatcher: (timeoutMs: number) => configureDispatcher(timeoutMs)
    }
  })().catch(() => null)
  return cached
}
