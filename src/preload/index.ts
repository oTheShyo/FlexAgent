import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  ContractError,
  IPC,
  type ApplyFileChangesInput,
  type ApplyFileChangesResult,
  type CodexApi,
  type ContractErrorCode,
  type CreateSessionInput,
  type KernelEvent,
  type PromptInput,
  type RespondPermissionInput,
  type SessionDetail,
  type SessionId,
  type SessionSummary,
  type TerminalCreateInput,
  type TerminalInputInput,
  type TerminalResizeInput
} from '../shared/contract'

interface IpcFailure {
  code?: unknown
  message?: unknown
  details?: unknown
}

const CONTRACT_ERROR_CODES = new Set<string>([
  'SESSION_NOT_FOUND',
  'SESSION_BUSY',
  'INVALID_INPUT',
  'PERMISSION_EXPIRED',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_LIMIT',
  'KERNEL_INTERNAL'
])

function toContractErrorCode(code: string): ContractErrorCode {
  return CONTRACT_ERROR_CODES.has(code) ? (code as ContractErrorCode) : 'KERNEL_INTERNAL'
}

function failureFromIpcError(err: unknown): IpcFailure {
  if (err instanceof ContractError) {
    return { code: err.code, message: err.message, details: err.details }
  }
  if (err !== null && typeof err === 'object') {
    const failure = err as IpcFailure
    if (typeof failure.code === 'string') {
      return {
        code: failure.code,
        message: typeof failure.message === 'string' ? failure.message : String(failure.code),
        details: failure.details
      }
    }
    if (typeof failure.message === 'string') {
      // main embeds JSON payload in Error.message; Electron may prefix
      // `Error invoking remote method 'chan': ` before it.
      const msg = failure.message
      const brace = msg.indexOf('{')
      if (brace >= 0) {
        try {
          const parsed = JSON.parse(msg.slice(brace)) as IpcFailure
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.code === 'string') {
            return {
              code: parsed.code,
              message:
                typeof parsed.message === 'string' ? parsed.message : String(parsed.code),
              details: parsed.details
            }
          }
        } catch {
          // not JSON — fall through
        }
      }
      return { code: 'KERNEL_INTERNAL', message: msg, details: failure.details }
    }
  }
  return {
    code: 'KERNEL_INTERNAL',
    message: err instanceof Error ? err.message : String(err)
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const failure = failureFromIpcError(err)
    const code = toContractErrorCode(
      typeof failure.code === 'string' ? failure.code : 'KERNEL_INTERNAL'
    )
    const message =
      typeof failure.message === 'string' ? failure.message : String(failure.code ?? code)
    // Reject a plain object (not Error): contextBridge keeps {code,message,details}
    // intact across the isolated world; Error instances lose custom properties.
    return Promise.reject({
      name: 'ContractError',
      code,
      message,
      details: failure.details
    })
  }
}

const codex: CodexApi = {
  listSessions: () => invoke<SessionSummary[]>(IPC.listSessions),

  createSession: (input: CreateSessionInput) =>
    invoke<SessionSummary>(IPC.createSession, input),

  openSession: (sessionId: SessionId) => invoke<SessionDetail>(IPC.openSession, sessionId),

  deleteSession: (sessionId: SessionId) => invoke<void>(IPC.deleteSession, sessionId),

  prompt: (input: PromptInput) => invoke(IPC.prompt, input),

  abort: (sessionId: SessionId) => invoke<void>(IPC.abort, sessionId),

  respondPermission: (input: RespondPermissionInput) =>
    invoke<void>(IPC.respondPermission, input),

  subscribe(sessionId: SessionId, listener: (event: KernelEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: KernelEvent): void => {
      if (payload && payload.sessionId === sessionId) listener(payload)
    }
    ipcRenderer.on(IPC.kernelEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC.kernelEvent, handler)
    }
  },

  terminalCreate: (input: TerminalCreateInput) => invoke(IPC.terminalCreate, input),

  terminalInput: (input: TerminalInputInput) => invoke<void>(IPC.terminalInput, input),

  terminalResize: (input: TerminalResizeInput) => invoke<void>(IPC.terminalResize, input),

  terminalKill: (terminalId: string) => invoke<void>(IPC.terminalKill, terminalId),

  applyFileChanges: (input: ApplyFileChangesInput) =>
    invoke<ApplyFileChangesResult>(IPC.applyFileChanges, input)
}

// Not CodexApi — §7.3 accept-disconnect only; frontend must not depend on it.
const diag = {
  killWorker: () => invoke<{ killed: boolean }>('diag:killWorker')
}

contextBridge.exposeInMainWorld('electron', { codex, diag })

declare global {
  interface Window {
    electron?: {
      codex: CodexApi
      diag?: { killWorker: () => Promise<{ killed: boolean }> }
    }
  }
}
