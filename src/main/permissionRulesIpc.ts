/**
 * The rule-management half of the permission IPC.
 *
 * It lives outside `ipc.ts` because the rule file is the one piece of
 * permission state the kernel is not the authority for: `permissions.json` is
 * read per evaluation by the worker (see `effectiveRuleSet`), so writing it is
 * all that is needed — there is no kernel state to invalidate. Nothing here
 * needs a worker round trip, which is why this does not go through the kernel
 * request protocol like `listPermissionRules` does.
 *
 * The guard is duplicated from `ipc.ts`/`marketplaceIpc.ts` on purpose: these
 * handlers are registered from `main/index.ts`, and importing the guard out of
 * `ipc.ts` would drag the whole handler table (windows, dialogs, terminals)
 * into this module.
 */
import { ipcMain } from './ipcGuard'
import {
  ContractError,
  CONTRACT_ERROR_CODES,
  IPC,
  type ContractErrorCode,
  type RemovePermissionRuleInput,
  type SavePermissionRuleInput
} from '../shared/contract'
import { addUserRule, removeUserRule, type PersistedRuleInput } from './permissionRules'
import type { SessionRegistry } from './registry'

/**
 * The directory a rule belongs to, read from the session registry rather than
 * from the renderer: `projectPath` decides whether a rule fires, so it is
 * authority, not a UI hint.
 */
function resolveCwd(registry: SessionRegistry, sessionId: string): string {
  const session = registry.list().find((entry) => entry.id === sessionId)
  if (session === undefined) {
    throw new ContractError(
      'INVALID_INPUT',
      `Unknown session "${sessionId}" — the rule cannot be attributed to a project`
    )
  }
  return session.cwd
}

interface IpcFailure {
  code?: unknown
  message?: unknown
  details?: unknown
}

const CONTRACT_ERROR_CODE_SET = new Set<string>(CONTRACT_ERROR_CODES)

function toContractErrorCode(code: string): ContractErrorCode {
  return CONTRACT_ERROR_CODE_SET.has(code) ? (code as ContractErrorCode) : 'KERNEL_INTERNAL'
}

function toIpcFailure(err: unknown): IpcFailure {
  if (err instanceof ContractError) {
    return { code: err.code, message: err.message, details: err.details }
  }
  if (err !== null && typeof err === 'object') {
    const failure = err as IpcFailure
    if (typeof failure.code === 'string') {
      return {
        code: toContractErrorCode(failure.code),
        message: typeof failure.message === 'string' ? failure.message : String(failure.code),
        details: failure.details
      }
    }
    if (typeof failure.message === 'string') {
      return { code: 'KERNEL_INTERNAL', message: failure.message, details: failure.details }
    }
  }
  return {
    code: 'KERNEL_INTERNAL',
    message: err instanceof Error ? err.message : String(err)
  }
}

function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      const failure = toIpcFailure(err)
      const payload = JSON.stringify(failure)
      const error = new Error(payload)
      Object.assign(error, failure, { message: payload })
      throw error
    })
}

export function registerPermissionRuleIpc(registry: SessionRegistry): void {
  ipcMain.handle(IPC.savePermissionRule, (_event, input: SavePermissionRuleInput) =>
    guard(() =>
      addUserRule({ ...input, cwd: resolveCwd(registry, input.sessionId) } satisfies PersistedRuleInput)
    )
  )
  ipcMain.handle(IPC.removePermissionRule, (_event, input: RemovePermissionRuleInput) =>
    guard(() => removeUserRule(input.id))
  )
}
