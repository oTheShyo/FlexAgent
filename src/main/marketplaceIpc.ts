import { ipcMain } from './ipcGuard'
import {
  ContractError,
  CONTRACT_ERROR_CODES,
  IPC,
  type AddMarketplaceInput,
  type ContractErrorCode,
  type InstallFromMarketplaceInput,
  type MarketplaceSearchInput
} from '../shared/contract'
import type { MarketplaceService } from './pluginMarketplace'

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
    const f = err as IpcFailure
    if (typeof f.code === 'string') {
      return {
        code: toContractErrorCode(f.code),
        message: typeof f.message === 'string' ? f.message : String(f.code),
        details: f.details
      }
    }
    if (typeof f.message === 'string') {
      return { code: 'KERNEL_INTERNAL', message: f.message, details: f.details }
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

export function registerMarketplaceIpc(service: MarketplaceService): void {
  ipcMain.handle(IPC.listMarketplaces, () => guard(() => service.list()))

  ipcMain.handle(IPC.addMarketplace, (_e, input: AddMarketplaceInput) =>
    guard(async () => {
      if (!input || typeof input.source !== 'string' || !input.source.trim()) {
        throw new ContractError('INVALID_INPUT', 'source is required')
      }
      return service.addMarketplace(input)
    })
  )

  ipcMain.handle(IPC.searchMarketplaces, (_e, input: MarketplaceSearchInput) =>
    guard(() => {
      const safe: MarketplaceSearchInput = {}
      if (input && typeof input.query === 'string') safe.query = input.query
      if (input && typeof input.marketplace === 'string') safe.marketplace = input.marketplace
      return service.search(safe)
    })
  )

  ipcMain.handle(IPC.installFromMarketplace, (_e, input: InstallFromMarketplaceInput) =>
    guard(async () => {
      if (!input || !input.source || typeof input.source.kind !== 'string') {
        throw new ContractError('INVALID_INPUT', 'source.kind is required')
      }
      const kind = input.source.kind
      if (kind === 'path') {
        if (typeof input.source.path !== 'string' || !input.source.path) {
          throw new ContractError('INVALID_INPUT', 'source.path is required')
        }
      } else if (kind === 'url') {
        if (typeof input.source.url !== 'string' || !input.source.url) {
          throw new ContractError('INVALID_INPUT', 'source.url is required')
        }
      } else if (kind === 'entry') {
        if (
          typeof input.source.marketplace !== 'string' ||
          !input.source.marketplace ||
          typeof input.source.name !== 'string' ||
          !input.source.name
        ) {
          throw new ContractError('INVALID_INPUT', 'source.marketplace and source.name are required')
        }
      } else {
        throw new ContractError('INVALID_INPUT', 'source.kind must be path|url|entry')
      }
      return service.installFromMarketplace(input)
    })
  )
}
