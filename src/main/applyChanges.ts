import { applyPatch, parsePatch, reversePatch } from 'diff'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, resolve, sep } from 'path'
import {
  ContractError,
  type ApplyFileChangesInput,
  type ApplyFileChangesResult,
  type FileChange
} from '../shared/contract'
import type { SessionRegistry } from './registry'

const PATH_ESCAPE_REASON = 'path escapes session cwd'

function resolveContained(cwd: string, relPosix: string): string {
  if (
    !relPosix ||
    relPosix.startsWith('/') ||
    relPosix.startsWith('\\') ||
    relPosix.includes('\\') ||
    /^[a-zA-Z]:/.test(relPosix)
  ) {
    throw new Error(PATH_ESCAPE_REASON)
  }
  const segments = relPosix.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error(PATH_ESCAPE_REASON)
  }
  const root = resolve(cwd)
  const abs = resolve(root, ...segments)
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  if (abs === root || !abs.startsWith(rootPrefix)) {
    throw new Error(PATH_ESCAPE_REASON)
  }
  return abs
}

function readIfExists(abs: string): string | null {
  if (!existsSync(abs)) return null
  return readFileSync(abs, 'utf8')
}

function reverseApplyMatches(current: string, patchText: string): boolean {
  try {
    const parsed = parsePatch(patchText)
    if (parsed.length === 0) return false
    const reversed = reversePatch(parsed)
    const single = Array.isArray(reversed) ? reversed[0] : reversed
    if (!single) return false
    return applyPatch(current, single) !== false
  } catch {
    return false
  }
}

function safeApplyPatch(source: string, patchText: string): string | false {
  try {
    return applyPatch(source, patchText)
  } catch {
    return false
  }
}

function writeTarget(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function applyOne(
  cwd: string,
  file: FileChange,
  result: ApplyFileChangesResult
): void {
  const path = file?.path
  if (typeof path !== 'string' || path.length === 0) {
    result.failed.push({ path: String(path ?? ''), reason: 'path must be a non-empty string' })
    return
  }

  let abs: string
  try {
    abs = resolveContained(cwd, path)
  } catch (err) {
    result.failed.push({ path, reason: err instanceof Error ? err.message : PATH_ESCAPE_REASON })
    return
  }

  if (file.status === 'deleted') {
    try {
      if (existsSync(abs)) {
        unlinkSync(abs)
        result.applied.push(path)
      } else {
        result.alreadyApplied.push(path)
      }
    } catch (err) {
      result.failed.push({ path, reason: err instanceof Error ? err.message : 'unlink failed' })
    }
    return
  }

  if (file.status !== 'modified' && file.status !== 'added') {
    result.failed.push({ path, reason: `unknown status: ${String(file.status)}` })
    return
  }

  if (typeof file.patch !== 'string') {
    result.failed.push({ path, reason: 'patch must be a string' })
    return
  }

  const current = readIfExists(abs)
  const source = current ?? ''

  // `added` always means "create from empty base". When the file already
  // exists, never re-apply forward (diff may append/duplicate); only treat
  // content-equal as alreadyApplied.
  if (file.status === 'added') {
    const expected = safeApplyPatch('', file.patch)
    if (expected === false) {
      result.failed.push({ path, reason: 'failed to create file from patch' })
      return
    }
    if (current === null) {
      try {
        writeTarget(abs, expected)
        result.applied.push(path)
      } catch (err) {
        result.failed.push({ path, reason: err instanceof Error ? err.message : 'write failed' })
      }
      return
    }
    if (current === expected) {
      result.alreadyApplied.push(path)
      return
    }
    if (reverseApplyMatches(current, file.patch)) {
      result.alreadyApplied.push(path)
      return
    }
    result.failed.push({
      path,
      reason: 'file already exists with different content than patch'
    })
    return
  }

  const next = safeApplyPatch(source, file.patch)
  if (next !== false) {
    if (current !== null && next === current) {
      result.alreadyApplied.push(path)
      return
    }
    try {
      writeTarget(abs, next)
      result.applied.push(path)
    } catch (err) {
      result.failed.push({ path, reason: err instanceof Error ? err.message : 'write failed' })
    }
    return
  }

  if (current !== null && reverseApplyMatches(current, file.patch)) {
    result.alreadyApplied.push(path)
    return
  }

  result.failed.push({
    path,
    reason: current === null ? 'file not found and patch does not apply to empty content' : 'patch does not apply to current file content'
  })
}

export function applyFileChanges(
  registry: SessionRegistry,
  input: ApplyFileChangesInput
): ApplyFileChangesResult {
  if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
    throw new ContractError('INVALID_INPUT', 'sessionId is required')
  }
  if (!Array.isArray(input.files)) {
    throw new ContractError('INVALID_INPUT', 'files must be an array')
  }

  const rec = registry.require(input.sessionId)
  if (rec.runState === 'running') {
    throw new ContractError('SESSION_BUSY', 'cannot apply file changes while the session is running')
  }

  const result: ApplyFileChangesResult = { applied: [], alreadyApplied: [], failed: [] }
  for (const file of input.files) {
    if (!file || typeof file !== 'object') {
      result.failed.push({ path: '', reason: 'file entry must be an object' })
      continue
    }
    applyOne(rec.cwd, file, result)
  }
  return result
}
