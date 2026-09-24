import { statSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import { ContractError } from '../shared/contract'

const PLUGIN_SOURCE_CLEANUP_RETRY_DELAYS_MS = [0, 25, 100] as const

export function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) return null
  const resolved = resolve(rootPath, rawPath)
  const rel = relative(rootPath, resolved)
  if (rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))) return resolved
  return null
}

export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9_.@-]/g, '-')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export function isCommandUnavailableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export async function cleanupPluginSourceBestEffort(
  cleanup: (() => Promise<void>) | undefined,
  retryDelaysMs: readonly number[] = PLUGIN_SOURCE_CLEANUP_RETRY_DELAYS_MS
): Promise<unknown> {
  if (!cleanup) return undefined
  let cleanupError: unknown
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs))
    }
    try {
      await cleanup()
      return undefined
    } catch (error) {
      cleanupError = error
    }
  }
  return cleanupError
}

export function appendPluginSourceCleanupError(
  primaryError: unknown,
  cleanupError: unknown
): unknown {
  if (cleanupError === undefined || !(primaryError instanceof Error)) return primaryError
  const cleanupMessage =
    cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
  primaryError.message = `${primaryError.message}; plugin source cleanup also failed: ${cleanupMessage}`
  return primaryError
}

export function throwIfAborted(options: { signal?: AbortSignal } | undefined): void {
  if (options?.signal?.aborted) throw new Error('Plugin operation cancelled')
}

export function redactPluginSource(source: string): string {
  const trimmed = source.trim()
  try {
    const url = new URL(trimmed)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    if (/^[^\s:@]+:[^\s@]+@/u.test(trimmed)) return 'configured Git source'
    return trimmed
  }
}

export function redactPluginDiagnosticText(text: string): string {
  return text
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>()[\]{}]+/giu, (source) => redactPluginSource(source))
    .replace(/\b[^\s:@]+:[^\s@]+@[^\s]+/gu, 'configured Git source')
}

export function createGitUnavailableError(source: string, reason?: string): ContractError {
  const safeSource = redactPluginSource(source)
  const reasonSuffix = reason ? ` (${redactPluginDiagnosticText(reason)})` : ''
  return new ContractError(
    'PLUGIN_SOURCE_INVALID',
    `System Git is required for plugin source ${safeSource}${reasonSuffix}, but git is unavailable on this Agent Host. Install Git on the Agent Host, or use a public GitHub HTTPS or verified ZIP source.`
  )
}

export function createArchiveFetchError(source: string, cause: unknown): ContractError {
  const safeSource = redactPluginSource(source)
  const detail = redactPluginDiagnosticText(cause instanceof Error ? cause.message : String(cause))
  return new ContractError(
    'PLUGIN_DOWNLOAD_FAILED',
    `Failed to materialize public GitHub plugin source archive ${safeSource}: ${detail}`
  )
}
