/**
 * Custom subagent settings IPC (ticket 16): the settings page's CRUD surface.
 *
 * Handlers live in their own module, not `ipc.ts` — same reason as
 * `permissionRulesIpc.ts`: the guard import would drag the whole handler
 * table (windows, dialogs, terminals) into every consumer otherwise.
 */
import { ipcMain } from './ipcGuard'
import {
  ContractError,
  CONTRACT_ERROR_CODES,
  IPC,
  type ContractErrorCode,
  type CustomAgentDefinitionInput,
  type CustomAgentsSnapshot,
  type CustomAgentDiagnostic
} from '../shared/contract'
import {
  deleteCustomAgent,
  isBuiltinName,
  loadAgentRegistry,
  saveCustomAgent,
  setCustomAgentEnabled
} from './agents/customAgents'
import type { AgentDiagnostic } from './agents/customAgents'
import type { AgentRole } from './agents/roles'
import type { KernelHost } from './kernel'

function toDiagnostic(diag: AgentDiagnostic): CustomAgentDiagnostic {
  return { file: diag.file, code: diag.code, message: diag.message, severity: diag.severity }
}

function toAgent(role: AgentRole): CustomAgentsSnapshot['agents'][number] {
  return {
    name: role.name,
    label: role.label,
    description: role.description,
    tools: [...role.tools],
    enabled: role.enabled !== false,
    builtin: role.builtin === true,
    persona: role.persona,
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.maxTurns !== undefined ? { maxTurns: role.maxTurns } : {})
  }
}

function snapshot(): CustomAgentsSnapshot {
  const registry = loadAgentRegistry()
  return {
    agents: registry.all.map(toAgent),
    diagnostics: registry.diagnostics.map(toDiagnostic)
  }
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

export function registerCustomAgentsIpc(kernel: KernelHost): void {
  // The multi-agent extension snapshots the agent registry when the worker
  // builds a session's resource loader, and loaders are cached per cwd — a
  // CRUD write that skips this would stay invisible to the task tool until an
  // unrelated reload. Awaiting the reload (instead of firing and forgetting)
  // also orders it ahead of any session attach the caller issues next.
  const invalidate = async (): Promise<void> => {
    await kernel.request({ type: 'reloadResources' })
  }

  ipcMain.handle(IPC.listCustomAgents, () => guard(() => snapshot()))

  ipcMain.handle(IPC.saveCustomAgent, (_event, input: CustomAgentDefinitionInput) =>
    guard(async () => {
      if (isBuiltinName(input.name)) {
        throw new ContractError('INVALID_INPUT', `built-in role "${input.name}" cannot be modified`)
      }
      saveCustomAgent(input)
      await invalidate()
      return snapshot()
    })
  )

  ipcMain.handle(IPC.deleteCustomAgent, (_event, input: { name: string }) =>
    guard(async () => {
      deleteCustomAgent(input.name)
      await invalidate()
      return snapshot()
    })
  )

  ipcMain.handle(IPC.setCustomAgentEnabled, (_event, input: { name: string; enabled: boolean }) =>
    guard(async () => {
      setCustomAgentEnabled(input.name, input.enabled)
      await invalidate()
      return snapshot()
    })
  )
}
