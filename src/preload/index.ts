import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  ContractError,
  CONTRACT_ERROR_CODES,
  IPC,
  WEB_EDIT_CHANNELS,
  type ApplyFileChangesInput,
  type ApplyFileChangesResult,
  type CodexApi,
  type ContractErrorCode,
  type CreateSessionInput,
  type CustomModelEntry,
  type CustomModelRef,
  type CustomModelSaveInput,
  type CustomModelWriteResult,
  type InstallFromMarketplaceInput,
  type InstallPluginInput,
  type KernelEvent,
  type SetPluginCapabilitiesInput,
  type MarketplaceApi,
  type MarketplaceInfo,
  type MarketplaceProgressEvent,
  type MarketplaceSearchInput,
  type MarketplaceSearchResult,
  type AddMarketplaceInput,
  type MemoryCard,
  type MemoryCardFile,
  type MemoryCardRef,
  type MemoryWriteReceipt,
  type ModelConfig,
  type GlobalUsageStats,
  type MemorySettings,
  type NetworkSettings,
  type QuestionSettings,
  type SetMemoryAutoExtractInput,
  type SetQuestionAutoContinueInput,
  type RoutingState,
  type SetModelRoleInput,
  type SetNetworkInput,
  type UsageReport,
  type ModelOption,
  type PluginCapabilityView,
  type PluginChangeEvent,
  type PluginDetail,
  type PluginId,
  type PluginSummary,
  type McpServerStatusEntry,
  type McpServerStatusEvent,
  type PluginMcpServerOverrides,
  type UserMcpSaveInput,
  type UserMcpServerSummary,
  type PermissionMode,
  type PermissionRuleSet,
  type CustomAgentDefinitionInput,
  type CustomAgentsSnapshot,
  type ForkSessionInput,
  type GoalCommandInput,
  type GoalCommandResult,
  type GoalStateSummary,
  type PlanState,
  type RespondPlanInput,
  type RespondPlanResult,
  type RemovePermissionRuleInput,
  type SavePermissionRuleInput,
  type PromptInput,
  type RenameSessionInput,
  type RespondPermissionInput,
  type RespondQuestionInput,
  type StopQuestionTimerInput,
  type SetSessionArchivedInput,
  type SetPermissionModeInput,
  type SessionDetail,
  type SessionId,
  type SessionSummary,
  type SetModelInput,
  type SetSessionCwdInput,
  type SetThinkingLevelInput,
  type SessionSearchHit,
  type WorkspaceFileQuery,
  type SessionContextQuery,
  type SessionContextResult,
  type SkillPendingWrite,
  type SkillUndoEntry,
  type SkillUsageEntry,
  type SkillSummary,
  type SkillHubInfo,
  type SkillHubEntry,
  type AddSkillHubInput,
  type InstallSkillInput,
  type SlashCommandSummary,
  type TerminalCreateInput,
  type TerminalInputInput,
  type TerminalResizeInput,
  type WebEditKind,
  type WindowControlsApi
} from '../shared/contract'

interface IpcFailure {
  code?: unknown
  message?: unknown
  details?: unknown
}

const CONTRACT_ERROR_CODE_SET = new Set<string>(CONTRACT_ERROR_CODES)

function toContractErrorCode(code: string): ContractErrorCode {
  return CONTRACT_ERROR_CODE_SET.has(code) ? (code as ContractErrorCode) : 'KERNEL_INTERNAL'
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

  scratchCwd: () => invoke<string>(IPC.scratchCwd),

  setSessionCwd: (input: SetSessionCwdInput) =>
    invoke<SessionSummary>(IPC.setSessionCwd, input),

  renameSession: (input: RenameSessionInput) =>
    invoke<SessionSummary>(IPC.renameSession, input),

  setSessionArchived: (input: SetSessionArchivedInput) =>
    invoke<SessionSummary>(IPC.setSessionArchived, input),

  forkSession: (input: ForkSessionInput) => invoke<SessionSummary>(IPC.forkSession, input),

  goalCommand: (input: GoalCommandInput) => invoke<GoalCommandResult>(IPC.goalCommand, input),

  getGoal: (sessionId: SessionId) => invoke<GoalStateSummary | undefined>(IPC.getGoal, sessionId),

  getPlan: (sessionId: SessionId) => invoke<PlanState | undefined>(IPC.getPlan, sessionId),

  respondPlan: (input: RespondPlanInput) => invoke<RespondPlanResult>(IPC.respondPlan, input),

  prompt: (input: PromptInput) => invoke(IPC.prompt, input),

  abort: (sessionId: SessionId) => invoke<void>(IPC.abort, sessionId),

  respondQuestion: (input: RespondQuestionInput) => invoke<void>(IPC.respondQuestion, input),
  stopQuestionTimer: (input: StopQuestionTimerInput) =>
    invoke<void>(IPC.stopQuestionTimer, input),

  respondPermission: (input: RespondPermissionInput) =>
    invoke<void>(IPC.respondPermission, input),

  getPermissionMode: (sessionId: SessionId) =>
    invoke<PermissionMode>(IPC.getPermissionMode, sessionId),

  setPermissionMode: (input: SetPermissionModeInput) =>
    invoke<PermissionMode>(IPC.setPermissionMode, input),

  listPermissionRules: () => invoke<PermissionRuleSet>(IPC.listPermissionRules),

  savePermissionRule: (input: SavePermissionRuleInput) =>
    invoke<PermissionRuleSet>(IPC.savePermissionRule, input),

  removePermissionRule: (input: RemovePermissionRuleInput) =>
    invoke<PermissionRuleSet>(IPC.removePermissionRule, input),

  listCustomAgents: () => invoke<CustomAgentsSnapshot>(IPC.listCustomAgents),

  saveCustomAgent: (input: CustomAgentDefinitionInput) =>
    invoke<CustomAgentsSnapshot>(IPC.saveCustomAgent, input),

  deleteCustomAgent: (input: { name: string }) =>
    invoke<CustomAgentsSnapshot>(IPC.deleteCustomAgent, input),

  setCustomAgentEnabled: (input: { name: string; enabled: boolean }) =>
    invoke<CustomAgentsSnapshot>(IPC.setCustomAgentEnabled, input),

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
    invoke<ApplyFileChangesResult>(IPC.applyFileChanges, input),

  listModels: () => invoke<ModelOption[]>(IPC.listModels),

  getModelConfig: (sessionId: SessionId) => invoke<ModelConfig>(IPC.getModelConfig, sessionId),

  setModel: (input: SetModelInput) => invoke<ModelConfig>(IPC.setModel, input),

  setThinkingLevel: (input: SetThinkingLevelInput) =>
    invoke<ModelConfig>(IPC.setThinkingLevel, input),

  pickDirectory: () => invoke<string | null>(IPC.pickDirectory),

  listCustomModels: () => invoke<CustomModelEntry[]>(IPC.listCustomModels),

  customModelsPath: () => invoke<string>(IPC.customModelsPath),

  saveCustomModel: (input: CustomModelSaveInput) =>
    invoke<CustomModelWriteResult>(IPC.saveCustomModel, input),

  removeCustomModel: (input: CustomModelRef) =>
    invoke<CustomModelWriteResult>(IPC.removeCustomModel, input),

  listModelRoles: () => invoke<RoutingState>(IPC.listModelRoles),

  setModelRole: (input: SetModelRoleInput) => invoke<RoutingState>(IPC.setModelRole, input),

  getNetworkSettings: () => invoke<NetworkSettings>(IPC.getNetworkSettings),

  setNetworkSettings: (input: SetNetworkInput) =>
    invoke<NetworkSettings>(IPC.setNetworkSettings, input),

  sessionUsage: (sessionId: SessionId) => invoke<UsageReport>(IPC.sessionUsage, sessionId),

  getMemorySettings: () => invoke<MemorySettings>(IPC.getMemorySettings),
  setMemoryAutoExtract: (input: SetMemoryAutoExtractInput) =>
    invoke<MemorySettings>(IPC.setMemoryAutoExtract, input),

  getUsageStats: () => invoke<GlobalUsageStats>(IPC.getUsageStats),

  getQuestionSettings: () => invoke<QuestionSettings>(IPC.getQuestionSettings),
  setQuestionAutoContinue: (input: SetQuestionAutoContinueInput) =>
    invoke<QuestionSettings>(IPC.setQuestionAutoContinue, input),

  listPlugins: () => invoke<PluginSummary[]>(IPC.listPlugins),

  listSlashCommands: () => invoke<SlashCommandSummary[]>(IPC.listSlashCommands),

  getPlugin: (id: PluginId) => invoke<PluginDetail>(IPC.getPlugin, id),

  setPluginEnabled: (id: PluginId, enabled: boolean) =>
    invoke<PluginSummary>(IPC.setPluginEnabled, { id, enabled }),

  installPlugin: (input: InstallPluginInput) => invoke<PluginSummary>(IPC.installPlugin, input),

  uninstallPlugin: (id: PluginId) => invoke<void>(IPC.uninstallPlugin, id),

  setPluginCapabilities: (input: SetPluginCapabilitiesInput) =>
    invoke<PluginCapabilityView>(IPC.setPluginCapabilities, input),

  subscribePlugins(listener: (event: PluginChangeEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: PluginChangeEvent): void => {
      listener(payload)
    }
    ipcRenderer.on(IPC.pluginsChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.pluginsChanged, handler)
    }
  },

  listUserMcpServers: () => invoke<UserMcpServerSummary[]>(IPC.listUserMcpServers),

  saveUserMcpServer: (input: UserMcpSaveInput) =>
    invoke<UserMcpServerSummary[]>(IPC.saveUserMcpServer, input),

  removeUserMcpServer: (name: string) =>
    invoke<UserMcpServerSummary[]>(IPC.removeUserMcpServer, name),

  toggleUserMcpServer: (name: string, enabled: boolean) =>
    invoke<UserMcpServerSummary[]>(IPC.toggleUserMcpServer, { name, enabled }),

  listMcpServerStatus: () => invoke<McpServerStatusEntry[]>(IPC.listMcpServerStatus),

  listPluginMcpServerOverrides: () =>
    invoke<PluginMcpServerOverrides>(IPC.listPluginMcpServerOverrides),

  setPluginMcpServerEnabled: (input: { key: string; enabled: boolean }) =>
    invoke<PluginMcpServerOverrides>(IPC.setPluginMcpServerEnabled, input),

  subscribeMcpStatus(listener: (event: McpServerStatusEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: McpServerStatusEvent): void => {
      listener(payload)
    }
    ipcRenderer.on(IPC.mcpStatusChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.mcpStatusChanged, handler)
    }
  },

  listSkills: () => invoke<SkillSummary[]>(IPC.listSkills),

  listPendingSkillWrites: () => invoke<SkillPendingWrite[]>(IPC.listPendingSkillWrites),

  approveSkillWrite: (id: string) => invoke<void>(IPC.approveSkillWrite, id),

  rejectSkillWrite: (id: string) => invoke<void>(IPC.rejectSkillWrite, id),

  listSkillUndo: () => invoke<SkillUndoEntry[]>(IPC.listSkillUndo),

  revertSkillWrite: (id: string) => invoke<void>(IPC.revertSkillWrite, id),

  listMemoryCards: () => invoke<MemoryCard[]>(IPC.listMemoryCards),

  addMemoryCard: (file: MemoryCardFile, text: string, scope?: string) =>
    invoke<MemoryWriteReceipt>(IPC.addMemoryCard, { file, text, scope }),

  removeMemoryCard: (file: MemoryCardFile, ref: MemoryCardRef) =>
    invoke<void>(IPC.removeMemoryCard, { file, ref }),

  listSkillUsage: () => invoke<SkillUsageEntry[]>(IPC.listSkillUsage),

  searchSessions: (query: string) => invoke<SessionSearchHit[]>(IPC.searchSessions, query),

  listWorkspaceFiles: (input: WorkspaceFileQuery) =>
    invoke<string[]>(IPC.listWorkspaceFiles, input),

  readSessionContext: (input: SessionContextQuery) =>
    invoke<SessionContextResult>(IPC.readSessionContext, input),

  listSkillHubs: () => invoke<SkillHubInfo[]>(IPC.listSkillHubs),

  addSkillHub: (input: AddSkillHubInput) => invoke<SkillHubInfo>(IPC.addSkillHub, input),

  removeSkillHub: (id: string) => invoke<void>(IPC.removeSkillHub, id),

  browseSkillHub: (id?: string) => invoke<SkillHubEntry[]>(IPC.browseSkillHub, id),

  installSkill: (input: InstallSkillInput) => invoke<SkillSummary>(IPC.installSkill, input),

  uninstallSkill: (name: string) => invoke<void>(IPC.uninstallSkill, name),

  reinstallSkill: (name: string) => invoke<SkillSummary>(IPC.reinstallSkill, name)
}

// Not CodexApi — §7.3 accept-disconnect only; frontend must not depend on it.
const diag = {
  killWorker: () => invoke<{ killed: boolean }>('diag:killWorker')
}

const marketplace: MarketplaceApi = {
  listMarketplaces: () => invoke<MarketplaceInfo[]>(IPC.listMarketplaces),

  addMarketplace: (input: AddMarketplaceInput) =>
    invoke<MarketplaceInfo>(IPC.addMarketplace, input),

  searchMarketplaces: (input: MarketplaceSearchInput) =>
    invoke<MarketplaceSearchResult[]>(IPC.searchMarketplaces, input),

  installFromMarketplace: (input: InstallFromMarketplaceInput) =>
    invoke<PluginSummary>(IPC.installFromMarketplace, input),

  subscribeMarketplaceProgress(listener: (event: MarketplaceProgressEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: MarketplaceProgressEvent): void => {
      listener(payload)
    }
    ipcRenderer.on(IPC.marketplaceProgress, handler)
    return () => {
      ipcRenderer.removeListener(IPC.marketplaceProgress, handler)
    }
  }
}

const windowControls: WindowControlsApi = {
  minimize: () => invoke<void>(IPC.windowMinimize),

  maximizeToggle: () => invoke<boolean>(IPC.windowMaximizeToggle),

  close: () => invoke<void>(IPC.windowClose),

  quit: () => invoke<void>(IPC.windowQuit),

  reload: () => invoke<void>(IPC.webReload),

  zoomIn: () => invoke<void>(IPC.webZoomIn),

  zoomOut: () => invoke<void>(IPC.webZoomOut),

  zoomReset: () => invoke<void>(IPC.webZoomReset),

  edit: (kind: WebEditKind) => invoke<void>(WEB_EDIT_CHANNELS[kind]),

  about: () => invoke<void>(IPC.appAbout),

  onMaximizedChange(listener: (maximized: boolean) => void): () => void {
    const handler = (_event: IpcRendererEvent, maximized: boolean): void => {
      listener(maximized)
    }
    ipcRenderer.on(IPC.windowMaximized, handler)
    return () => {
      ipcRenderer.removeListener(IPC.windowMaximized, handler)
    }
  }
}

contextBridge.exposeInMainWorld('electron', { codex, diag, marketplace, windowControls })

declare global {
  interface Window {
    electron?: {
      codex: CodexApi
      diag?: { killWorker: () => Promise<{ killed: boolean }> }
      marketplace?: MarketplaceApi
      windowControls?: WindowControlsApi
    }
  }
}
