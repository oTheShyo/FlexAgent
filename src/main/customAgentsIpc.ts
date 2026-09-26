/**
 * Custom subagent settings IPC (ticket 16): the settings page's CRUD surface.
 *
 * Handlers live in their own module, not `ipc.ts` — same reason as
 * `permissionRulesIpc.ts`: the guard import would drag the whole handler
 * table (windows, dialogs, terminals) into every consumer otherwise.
 */
import { ipcMain } from './ipcGuard'
import {
  IPC,
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

export function registerCustomAgentsIpc(): void {
  ipcMain.handle(IPC.listCustomAgents, () => snapshot())

  ipcMain.handle(IPC.saveCustomAgent, (_event, input: CustomAgentDefinitionInput) => {
    if (isBuiltinName(input.name)) {
      throw new Error(`built-in role "${input.name}" cannot be modified`)
    }
    saveCustomAgent(input)
    return snapshot()
  })

  ipcMain.handle(IPC.deleteCustomAgent, (_event, input: { name: string }) => {
    deleteCustomAgent(input.name)
    return snapshot()
  })

  ipcMain.handle(IPC.setCustomAgentEnabled, (_event, input: { name: string; enabled: boolean }) => {
    setCustomAgentEnabled(input.name, input.enabled)
    return snapshot()
  })
}
