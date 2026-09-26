import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import type { MessageBoxOptions, WebContents } from 'electron'
import { randomUUID } from 'crypto'
import {
  ContractError,
  CONTRACT_ERROR_CODES,
  IPC,
  PERMISSION_MODES,
  WEB_EDIT_CHANNELS,
  type ApplyFileChangesInput,
  type ContractErrorCode,
  type CustomModelRef,
  type CustomModelSaveInput,
  type InstallPluginInput,
  type PermissionMode,
  type PermissionRuleSet,
  type PromptInput,
  type WorkspaceFileQuery,
  type RespondPermissionInput,
  type NetworkSettings,
  type SetModelInput,
  type SetModelRoleInput,
  type SetNetworkInput,
  type SetPermissionModeInput,
  type SetThinkingLevelInput,
  type TerminalCreateInput,
  type TerminalInputInput,
  type TerminalResizeInput,
  type UserMcpSaveInput,
  type WebEditKind
} from '../shared/contract'
import { applyFileChanges } from './applyChanges'
import type { KernelHost } from './kernel'
import type { SessionRegistry } from './registry'
import type { TerminalManager } from './pty'
import type { PluginService } from './plugins'
import type { UserMcpService } from './userMcp'
import type { UserModelsService } from './userModels'
import type { KernelSettingsService, NetworkConfig } from './kernelSettings'
import { writeRoleBinding } from './modelRouting'
import type { NetworkStatus } from '../shared/kernel-protocol'
import { scratchCwd, workspaceKey } from './workspace'
import { perfStart } from './perf'
import {
  approveSkillWrite,
  listPendingSkillWrites,
  listSkillUndo,
  rejectSkillWrite,
  revertSkillWrite
} from './skills/skillManage'
import { listSkills } from './skills/skillService'
import {
  addSkillHub,
  browseSkillHub,
  installSkill,
  listSkillHubs,
  reinstallSkill,
  removeSkillHub,
  uninstallSkill
} from './skills/skillHub'
import type { InstallSkillSource } from '../shared/contract'
import { addMemoryCard, listMemoryCards, removeMemoryCard } from './skills/memoryStore'
import { listSkillUsage } from './skills/skillUsage'
import { RECALL_BUDGET, extractRecallQueries, searchSessionRecords } from './skills/sessionSearch'
import { listWorkspaceFiles, invalidateWorkspaceFiles } from './workspaceFiles'
import { renderReferences } from './promptReferences'
import type { SessionSearchHit } from '../shared/contract'

interface IpcFailure {
  code?: unknown
  message?: unknown
  details?: unknown
}

const CONTRACT_ERROR_CODE_SET = new Set<string>(CONTRACT_ERROR_CODES)

/** §5.4: only contract enum codes cross IPC; anything else → KERNEL_INTERNAL. */
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
      // Electron's ipcMain.handle serializes non-Error rejections as
      // `Error invoking remote method '…': [object Object]` and drops custom
      // Error properties. Embed the full {code,message,details} payload in
      // Error.message so preload can restore ContractError fields (contract §5).
      // Object.assign would overwrite message with the human text — re-apply
      // the JSON payload last so preload's brace-parse still works.
      const payload = JSON.stringify(failure)
      const error = new Error(payload)
      Object.assign(error, failure, { message: payload })
      throw error
    })
}

function assertText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ContractError('INVALID_INPUT', 'text must be a non-empty string')
  }
  return text
}

/**
 * Window the titlebar strip drives. The focused window wins; a dialog that has
 * taken focus away from every window must not turn a control click into a no-op.
 */
function chromeWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

const ZOOM_STEP = 0.5

const EDIT_ACTIONS: Record<WebEditKind, (contents: WebContents) => void> = {
  undo: (contents) => contents.undo(),
  cut: (contents) => contents.cut(),
  copy: (contents) => contents.copy(),
  paste: (contents) => contents.paste(),
  selectAll: (contents) => contents.selectAll()
}

function runEdit(kind: WebEditKind): void {
  const contents = chromeWindow()?.webContents
  if (contents !== undefined) EDIT_ACTIONS[kind](contents)
}

function showAbout(): Promise<void> {
  const options: MessageBoxOptions = {
    type: 'info',
    title: `About ${app.getName()}`,
    message: app.getName(),
    detail: `Version ${app.getVersion()}`,
    buttons: ['OK']
  }
  const win = chromeWindow()
  return win === null
    ? dialog.showMessageBox(options).then(() => undefined)
    : dialog.showMessageBox(win, options).then(() => undefined)
}

/**
 * Merge what is stored with what the worker can actually do about it. The two
 * are deliberately separate answers: the settings can be on disk and still not
 * be in force, and saying so is the whole point of the Network panel.
 */
function composeNetworkSettings(
  path: string,
  values: NetworkConfig,
  status: NetworkStatus
): NetworkSettings {
  return {
    path,
    ...values,
    envProxy: status.envProxy,
    dispatcher: status.dispatcher,
    ...(status.note !== undefined ? { note: status.note } : {})
  }
}

export function registerIpcHandlers(
  kernel: KernelHost,
  registry: SessionRegistry,
  terminals: TerminalManager,
  plugins: PluginService,
  userMcp: UserMcpService,
  customModels: UserModelsService,
  network: KernelSettingsService
): void {
  ipcMain.handle(IPC.listSessions, () => guard(() => registry.list()))

  ipcMain.handle(IPC.createSession, (_e, input: { cwd?: unknown; title?: unknown }) =>
    guard(async () => {
      const perf = perfStart()
      if (input !== undefined && input !== null && typeof input !== 'object') {
        throw new ContractError('INVALID_INPUT', 'expected { cwd?, title? }')
      }
      // cwd is optional — a chat with no project yet lands in the scratch
      // workspace so New chat never has to interrupt with a folder picker.
      const requested = typeof input?.cwd === 'string' ? input.cwd.trim() : ''
      const cwd = requested.length > 0 ? requested : scratchCwd()
      const title = typeof input?.title === 'string' ? input.title : undefined
      const id = randomUUID()
      const rec = registry.create(id, cwd, title)
      perf.mark('registry.create')
      try {
        const result = (await kernel.request({
          type: 'createSession',
          sessionId: id,
          cwd: rec.cwd,
          title: rec.title
        })) as { piSessionFile?: string } | undefined
        perf.mark('kernel.request')
        if (result?.piSessionFile) registry.attachPiSession(id, result.piSessionFile)
        perf.mark('registry.attachPiSession')
        const stored = registry.require(id)
        perf.done('ipc.createSession', { sessionId: id })
        return {
          id: stored.id,
          title: stored.title,
          cwd: stored.cwd,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt,
          runState: stored.runState
        }
      } catch (err) {
        registry.remove(id)
        throw err
      }
    })
  )

  ipcMain.handle(IPC.openSession, (_e, sessionId: unknown) =>
    guard(async () => {
      const perf = perfStart()
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      const rec = registry.require(sessionId)
      perf.mark('registry.require')
      const detail = (await kernel.request({
        type: 'openSession',
        sessionId,
        cwd: rec.cwd,
        piSessionFile: rec.piSessionFile
      })) as { messages: unknown[] } | undefined
      perf.mark('kernel.request')
      perf.done('ipc.openSession', { sessionId, messages: detail?.messages?.length ?? 0 })
      return {
        summary: {
          id: rec.id,
          title: rec.title,
          cwd: rec.cwd,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          runState: rec.runState
        },
        messages: detail?.messages ?? []
      }
    })
  )

  ipcMain.handle(IPC.deleteSession, (_e, sessionId: unknown) =>
    guard(async () => {
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      registry.require(sessionId)
      try {
        await kernel.request({ type: 'disposeSession', sessionId })
      } catch {
        /* best-effort dispose */
      }
      terminals.disposeSession(sessionId)
      registry.remove(sessionId)
    })
  )

  ipcMain.handle(IPC.scratchCwd, () => guard(() => scratchCwd()))

  ipcMain.handle(IPC.setSessionCwd, (_e, input: { sessionId?: unknown; cwd?: unknown }) =>
    guard(async () => {
      const perf = perfStart()
      if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      if (typeof input.cwd !== 'string' || !input.cwd.trim()) {
        throw new ContractError('INVALID_INPUT', 'cwd is required')
      }
      const cwd = input.cwd.trim()
      const rec = registry.require(input.sessionId)
      // Tools resolve relative paths against the workspace, so the run has to
      // finish (or be aborted) before the folder may move under it.
      if (rec.runState !== 'idle') {
        throw new ContractError(
          'SESSION_BUSY',
          'cannot change the workspace while a run is in flight'
        )
      }
      if (workspaceKey(rec.cwd) !== workspaceKey(cwd)) {
        const result = (await kernel.request({
          type: 'setSessionCwd',
          sessionId: input.sessionId,
          cwd
        })) as { piSessionFile?: string } | undefined
        perf.mark('kernel.request')
        // open() may rewrite the session file; keep the registry pointing at it.
        if (result?.piSessionFile) registry.attachPiSession(input.sessionId, result.piSessionFile)
        registry.setCwd(input.sessionId, cwd)
        // Ticket 27: the cached file list is now the previous project's list.
        invalidateWorkspaceFiles(rec.cwd)
        perf.mark('registry.setCwd')
      }
      perf.done('ipc.setSessionCwd', { sessionId: input.sessionId, cwd })
      return registry.summary(input.sessionId)
    })
  )

/**
 * Short-term memory for a turn: which earlier sessions already covered this.
 *
 * Lives here rather than in the worker because the session registry does — the
 * worker holds transcripts, not the index. Every prompt pays this, so it runs
 * under the recall budget and never throws: a turn that starts slightly less
 * informed beats one that does not start.
 */
const RECALL_MIN_PROMPT = 6
const RECALL_MAX_HITS = 5

function recallForPrompt(text: string, currentSessionId: string): SessionSearchHit[] {
  const prompt = text.trim()
  if (prompt.length < RECALL_MIN_PROMPT) return []
  try {
    const records = registry.list().filter((record) => record.id !== currentSessionId)
    const merged = new Map<string, SessionSearchHit>()
    for (const query of extractRecallQueries(prompt)) {
      for (const hit of searchSessionRecords(records, query, 3, RECALL_BUDGET)) {
        if (!merged.has(hit.sessionId)) merged.set(hit.sessionId, hit)
      }
      if (merged.size >= RECALL_MAX_HITS) break
    }
    return [...merged.values()].slice(0, RECALL_MAX_HITS)
  } catch {
    return []
  }
}

  ipcMain.handle(IPC.prompt, (_e, input: PromptInput) =>
    guard(async () => {
      if (!input || typeof input.sessionId !== 'string') {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      assertText(input.text)
      registry.require(input.sessionId)
      const mode = input.mode === 'followUp' ? 'followUp' : 'steer'
      const rec = registry.require(input.sessionId)
      const disposition =
        rec.runState === 'idle'
          ? ('started' as const)
          : mode === 'followUp'
            ? ('queued' as const)
            : ('steering' as const)
      // Short-term memory: what earlier sessions already know about this. The
      // registry is here and the worker cannot reach it, so it rides the prompt
      // request. Failure must never block the turn.
      let recall: ReturnType<typeof searchSessionRecords> | undefined
      try {
        recall = recallForPrompt(input.text, input.sessionId)
      } catch {
        recall = undefined
      }
      // Ticket 27: the references travel as their own field and are rendered to
      // text here — main is where the registry (and so the session's cwd) lives,
      // and opening a file is work the agent's thread should not wait for. What
      // could not be attached comes back as notices rather than being dropped,
      // because a mention that contributes nothing is otherwise invisible.
      let promptContext: string | undefined
      let notices: string[] | undefined
      if (input.references !== undefined && input.references.length > 0) {
        try {
          const rendered = await renderReferences(rec.cwd, input.references)
          if (rendered.block.length > 0) promptContext = rendered.block
          if (rendered.notices.length > 0) notices = rendered.notices
        } catch (err) {
          // Rendering must never cost the user their turn. The references are
          // the part that fails; the prompt they typed still goes through.
          notices = [
            `The attached context could not be prepared: ${err instanceof Error ? err.message : String(err)}`
          ]
        }
      }
      const ack = (await kernel.request({
        type: 'prompt',
        sessionId: input.sessionId,
        text: input.text,
        disposition,
        ...(recall !== undefined ? { recall } : {}),
        ...(promptContext !== undefined ? { promptContext } : {})
      })) as { disposition?: string } | undefined
      registry.touch(input.sessionId)
      return {
        disposition: ack?.disposition ?? disposition,
        ...(notices !== undefined ? { notices } : {})
      }
    })
  )

  ipcMain.handle(IPC.abort, (_e, sessionId: unknown) =>
    guard(async () => {
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      registry.require(sessionId)
      await kernel.request({ type: 'abort', sessionId })
    })
  )

  ipcMain.handle(IPC.respondPermission, (_e, input: RespondPermissionInput) =>
    guard(async () => {
      if (!input || typeof input.sessionId !== 'string' || typeof input.toolCallId !== 'string') {
        throw new ContractError('INVALID_INPUT', 'sessionId and toolCallId are required')
      }
      if (input.decision !== 'allowOnce' && input.decision !== 'allowSession' && input.decision !== 'deny') {
        throw new ContractError('INVALID_INPUT', 'decision must be allowOnce|allowSession|deny')
      }
      registry.require(input.sessionId)
      await kernel.request({
        type: 'respondPermission',
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        decision: input.decision
      })
    })
  )

  ipcMain.handle(IPC.getPermissionMode, (_e, sessionId: unknown) =>
    guard(async () => {
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      registry.require(sessionId)
      return kernel.request({ type: 'getPermissionMode', sessionId })
    })
  )

  ipcMain.handle(IPC.setPermissionMode, (_e, input: SetPermissionModeInput) =>
    guard(async () => {
      if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      if (!PERMISSION_MODES.includes(input.mode)) {
        throw new ContractError('INVALID_INPUT', `unknown permission mode: ${String(input.mode)}`)
      }
      registry.require(input.sessionId)
      return kernel.request({ type: 'setPermissionMode', sessionId: input.sessionId, mode: input.mode })
    })
  )

  ipcMain.handle(IPC.listPermissionRules, () =>
    guard(async () => kernel.request({ type: 'listPermissionRules' }))
  )

  ipcMain.handle(IPC.terminalCreate, (_e, input: TerminalCreateInput) =>
    guard(() => {
      if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      return terminals.create(input)
    })
  )

  ipcMain.handle(IPC.terminalInput, (_e, input: TerminalInputInput) =>
    guard(() => {
      if (!input || typeof input.terminalId !== 'string') {
        throw new ContractError('INVALID_INPUT', 'terminalId is required')
      }
      terminals.input(input.terminalId, input.data)
    })
  )

  ipcMain.handle(IPC.terminalResize, (_e, input: TerminalResizeInput) =>
    guard(() => {
      if (!input || typeof input.terminalId !== 'string') {
        throw new ContractError('INVALID_INPUT', 'terminalId is required')
      }
      terminals.resize(input.terminalId, input.cols, input.rows)
    })
  )

  ipcMain.handle(IPC.terminalKill, (_e, terminalId: unknown) =>
    guard(() => {
      if (typeof terminalId !== 'string' || !terminalId) {
        throw new ContractError('INVALID_INPUT', 'terminalId is required')
      }
      terminals.kill(terminalId)
    })
  )

  ipcMain.handle(IPC.applyFileChanges, (_e, input: ApplyFileChangesInput) =>
    guard(() => applyFileChanges(registry, input))
  )

  ipcMain.handle(IPC.listModels, () =>
    guard(async () => (await kernel.request({ type: 'listModels' })) ?? [])
  )

  ipcMain.handle(IPC.getModelConfig, (_e, sessionId: unknown) =>
    guard(async () => {
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      registry.require(sessionId)
      return kernel.request({ type: 'getModelConfig', sessionId })
    })
  )

  ipcMain.handle(IPC.setModel, (_e, input: SetModelInput) =>
    guard(async () => {
      if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      if (typeof input.provider !== 'string' || !input.provider) {
        throw new ContractError('INVALID_INPUT', 'provider is required')
      }
      if (typeof input.id !== 'string' || !input.id) {
        throw new ContractError('INVALID_INPUT', 'id is required')
      }
      registry.require(input.sessionId)
      return kernel.request({
        type: 'setModel',
        sessionId: input.sessionId,
        provider: input.provider,
        id: input.id,
        thinkingLevel: input.thinkingLevel
      })
    })
  )

  ipcMain.handle(IPC.setThinkingLevel, (_e, input: SetThinkingLevelInput) =>
    guard(async () => {
      if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      registry.require(input.sessionId)
      return kernel.request({
        type: 'setThinkingLevel',
        sessionId: input.sessionId,
        level: input.level
      })
    })
  )

  ipcMain.handle(IPC.pickDirectory, () =>
    guard(async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0] ?? null
    })
  )

  // ── Custom models (v1.9) ──
  // The file is the kernel's own models.json, so its path comes from the worker
  // (which knows PI's agent dir) rather than being recomputed here. Every write
  // is followed by a kernel-side reload *and* a check that the entry actually
  // resolves — otherwise the UI could report success while `listModels` stayed
  // empty, which is exactly what a wrong path does.
  ipcMain.handle(IPC.listCustomModels, () => guard(async () => customModels.list(await kernel.modelsPath())))

  ipcMain.handle(IPC.customModelsPath, () => guard(() => kernel.modelsPath()))

  ipcMain.handle(IPC.saveCustomModel, (_e, input: CustomModelSaveInput) =>
    guard(async () => {
      const write = await customModels.save(await kernel.modelsPath(), input)
      // The key left for the vault during the save, so the runtime has to be
      // given it before the provider is recomposed — otherwise the model shows
      // up resolved but authenticated by nothing.
      await kernel.applyModelKeys()
      const error = await kernel.reloadModels(write.providers, { ...write.ref, present: true })
      return error === undefined ? write.result : { ...write.result, error }
    })
  )

  ipcMain.handle(IPC.removeCustomModel, (_e, input: CustomModelRef) =>
    guard(async () => {
      const write = await customModels.remove(await kernel.modelsPath(), input)
      // A provider that lost its last model also lost its key; tell the runtime
      // so it stops holding a credential for something that no longer exists.
      await kernel.applyModelKeys()
      const error = await kernel.reloadModels(write.providers, { ...write.ref, present: false })
      return error === undefined ? write.result : { ...write.result, error }
    })
  )

  // ── Model routing (v2.0) ──────────────────────────────────────────────────
  // The routing table is ours (`~/.flexagent/routing.json`), but whether a
  // binding is *usable* is the kernel's call, so every read and every write ends
  // with the worker resolving the roles again. A binding the kernel cannot
  // resolve comes back with a per-role `error` instead of a silent fallback.
  ipcMain.handle(IPC.listModelRoles, () => guard(() => kernel.resolveModelRoles()))

  ipcMain.handle(IPC.setModelRole, (_e, input: SetModelRoleInput) =>
    guard(async () => {
      if (!input || typeof input !== 'object') {
        throw new ContractError('INVALID_INPUT', 'expected { role, model }')
      }
      await writeRoleBinding(input.role, input.model ?? null)
      return kernel.resolveModelRoles()
    })
  )

  // These two live in the kernel's own settings.json (httpProxy /
  // httpIdleTimeoutMs / retry.maxRetries). PI only applies them from its CLI
  // entry point, which this app never runs — so after writing, the worker is
  // asked to install them in this process and to say whether that worked.
  ipcMain.handle(IPC.getNetworkSettings, () =>
    guard(async () => {
      const file = await kernel.settingsPath()
      return composeNetworkSettings(file, network.read(file), await kernel.networkStatus())
    })
  )

  ipcMain.handle(IPC.setNetworkSettings, (_e, input: SetNetworkInput) =>
    guard(async () => {
      if (!input || typeof input !== 'object') {
        throw new ContractError('INVALID_INPUT', 'expected { proxy?, idleTimeoutMs?, maxRetries? }')
      }
      const file = await kernel.settingsPath()
      const stored = await network.write(file, input)
      const status = await kernel.applyNetwork(stored.proxy, stored.idleTimeoutMs)
      return composeNetworkSettings(file, stored, status)
    })
  )

  ipcMain.handle(IPC.sessionUsage, (_e, sessionId: unknown) =>
    guard(() => {
      if (typeof sessionId !== 'string') {
        throw new ContractError('INVALID_INPUT', 'sessionId must be a string')
      }
      return kernel.sessionUsage(sessionId)
    })
  )

  ipcMain.handle(IPC.listPlugins, () => guard(() => plugins.list()))
  ipcMain.handle(IPC.listSlashCommands, () => guard(() => plugins.slashCommands()))

  ipcMain.handle(IPC.getPlugin, (_e, id: unknown) =>
    guard(() => {
      if (typeof id !== 'string' || !id) {
        throw new ContractError('INVALID_INPUT', 'id is required')
      }
      return plugins.get(id)
    })
  )

  ipcMain.handle(IPC.setPluginEnabled, (_e, input: { id?: unknown; enabled?: unknown }) =>
    guard(async () => {
      if (!input || typeof input.id !== 'string' || typeof input.enabled !== 'boolean') {
        throw new ContractError('INVALID_INPUT', 'id and enabled are required')
      }
      return plugins.setEnabled(input.id, input.enabled)
    })
  )

  ipcMain.handle(IPC.installPlugin, (_e, input: InstallPluginInput) =>
    guard(async () => {
      if (
        !input ||
        !input.source ||
        input.source.kind !== 'directory' ||
        typeof input.source.path !== 'string' ||
        !input.source.path
      ) {
        throw new ContractError('INVALID_INPUT', 'source.path is required')
      }
      return plugins.install(input)
    })
  )

  ipcMain.handle(IPC.uninstallPlugin, (_e, id: unknown) =>
    guard(async () => {
      if (typeof id !== 'string' || !id) {
        throw new ContractError('INVALID_INPUT', 'id is required')
      }
      await plugins.uninstall(id)
    })
  )

  // ── User-level MCP servers (v1.8) ──

  ipcMain.handle(IPC.listUserMcpServers, () => guard(() => userMcp.list()))

  ipcMain.handle(IPC.saveUserMcpServer, (_e, input: UserMcpSaveInput) =>
    guard(async () => {
      const list = await userMcp.save(input)
      await plugins.reloadKernel()
      return list
    })
  )

  ipcMain.handle(IPC.removeUserMcpServer, (_e, name: unknown) =>
    guard(async () => {
      if (typeof name !== 'string' || !name) {
        throw new ContractError('INVALID_INPUT', 'name is required')
      }
      const list = await userMcp.remove(name)
      await plugins.reloadKernel()
      return list
    })
  )

  ipcMain.handle(IPC.toggleUserMcpServer, (_e, input: { name?: unknown; enabled?: unknown }) =>
    guard(async () => {
      if (!input || typeof input.name !== 'string' || typeof input.enabled !== 'boolean') {
        throw new ContractError('INVALID_INPUT', 'name and enabled are required')
      }
      const list = await userMcp.toggle(input.name, input.enabled)
      await plugins.reloadKernel()
      return list
    })
  )

  ipcMain.handle(IPC.listMcpServerStatus, () => guard(() => kernel.getMcpStatus()))

  // §7.3 walkthrough only — not part of CodexApi / shared/contract.
  ipcMain.handle('diag:killWorker', () =>
    guard(() => kernel.killWorkerForTest())
  )

  // ── Skills / Memory / History (v1.7) ──

  ipcMain.handle(IPC.listSkills, () => guard(() => listSkills(plugins)))

  ipcMain.handle(IPC.listPendingSkillWrites, () => guard(() => listPendingSkillWrites()))

  ipcMain.handle(IPC.approveSkillWrite, (_e, id: unknown) =>
    guard(async () => {
      if (typeof id !== 'string' || !id) {
        throw new ContractError('INVALID_INPUT', 'id is required')
      }
      approveSkillWrite(id)
      // Skills are baked into cached loaders at construction — drop them so
      // the next attach discovers the newly approved skill.
      try {
        await kernel.request({ type: 'reloadResources' })
      } catch {
        // Worker down: the restart path rebuilds loaders from scratch anyway.
      }
    })
  )

  ipcMain.handle(IPC.rejectSkillWrite, (_e, id: unknown) =>
    guard(() => {
      if (typeof id !== 'string' || !id) {
        throw new ContractError('INVALID_INPUT', 'id is required')
      }
      rejectSkillWrite(id)
    })
  )

  ipcMain.handle(IPC.listSkillUndo, () => guard(() => listSkillUndo()))

  ipcMain.handle(IPC.revertSkillWrite, (_e, id: unknown) =>
    guard(() => {
      if (typeof id !== 'string' || !id) {
        throw new ContractError('INVALID_INPUT', 'id is required')
      }
      const result = revertSkillWrite(id)
      if (result.reverted.length === 0) {
        throw new ContractError('INVALID_INPUT', 'nothing to revert — the files were already in that state')
      }
      // The reverted skill is live again, so cached loaders carrying the old one
      // have to go.
      try {
        void kernel.request({ type: 'reloadResources' })
      } catch {
        // Worker down: an attach after the next start rebuilds loaders anyway.
      }
    })
  )

  // ── Skill Hub (v1.8) ──

  ipcMain.handle(IPC.listSkillHubs, () => guard(() => listSkillHubs()))

  ipcMain.handle(IPC.addSkillHub, (_e, input: { name?: unknown; url?: unknown }) =>
    guard(() => {
      if (!input || typeof input.name !== 'string' || typeof input.url !== 'string') {
        throw new ContractError('INVALID_INPUT', 'name and url are required')
      }
      return addSkillHub({ name: input.name, url: input.url })
    })
  )

  ipcMain.handle(IPC.removeSkillHub, (_e, id: unknown) =>
    guard(() => {
      if (typeof id !== 'string' || !id) {
        throw new ContractError('INVALID_INPUT', 'id is required')
      }
      removeSkillHub(id)
    })
  )

  ipcMain.handle(IPC.browseSkillHub, (_e, id: unknown) =>
    guard(() =>
      browseSkillHub(id === undefined || id === null ? undefined : (id as string))
    )
  )

  ipcMain.handle(IPC.installSkill, (_e, input: { source?: unknown; overwrite?: unknown }) =>
    guard(async () => {
      if (!input || typeof input.source !== 'object' || input.source === null) {
        throw new ContractError('INVALID_INPUT', 'source is required')
      }
      const src = input.source as { kind?: unknown; hub?: unknown; name?: unknown; folderPath?: unknown; source?: unknown }
      let parsed: InstallSkillSource
      if (src.kind === 'hub') {
        if (typeof src.hub !== 'string' || typeof src.name !== 'string') {
          throw new ContractError('INVALID_INPUT', 'hub source requires hub and name')
        }
        parsed = { kind: 'hub', hub: src.hub, name: src.name }
      } else if (src.kind === 'folder') {
        if (typeof src.folderPath !== 'string' || !src.folderPath) {
          throw new ContractError('INVALID_INPUT', 'folder source requires folderPath')
        }
        parsed = { kind: 'folder', folderPath: src.folderPath }
      } else if (src.kind === 'source') {
        if (typeof src.source !== 'string' || !src.source) {
          throw new ContractError('INVALID_INPUT', 'source kind requires a source string')
        }
        parsed = { kind: 'source', source: src.source }
      } else {
        throw new ContractError('INVALID_INPUT', `Unknown installSkill source kind: ${String(src.kind)}`)
      }
      const summary = await installSkill(parsed, input.overwrite === true)
      try {
        await kernel.request({ type: 'reloadResources' })
      } catch {
        // Worker down: the restart path rebuilds loaders from scratch anyway.
      }
      return summary
    })
  )

  ipcMain.handle(IPC.uninstallSkill, (_e, name: unknown) =>
    guard(async () => {
      if (typeof name !== 'string' || !name) {
        throw new ContractError('INVALID_INPUT', 'name is required')
      }
      uninstallSkill(name)
      try {
        await kernel.request({ type: 'reloadResources' })
      } catch {
        // Worker down: the restart path rebuilds loaders from scratch anyway.
      }
    })
  )

  ipcMain.handle(IPC.reinstallSkill, (_e, name: unknown) =>
    guard(async () => {
      if (typeof name !== 'string' || !name) {
        throw new ContractError('INVALID_INPUT', 'name is required')
      }
      const summary = await reinstallSkill(name)
      try {
        await kernel.request({ type: 'reloadResources' })
      } catch {
        // Worker down: the restart path rebuilds loaders from scratch anyway.
      }
      return summary
    })
  )

  ipcMain.handle(IPC.listMemoryCards, () => guard(() => listMemoryCards()))

  ipcMain.handle(
    IPC.addMemoryCard,
    (_e, input: { file?: unknown; text?: unknown; scope?: unknown }) =>
      guard(() => {
        if (!input || (input.file !== 'MEMORY' && input.file !== 'USER')) {
          throw new ContractError('INVALID_INPUT', 'file must be MEMORY or USER')
        }
        if (typeof input.text !== 'string' || !input.text.trim()) {
          throw new ContractError('INVALID_INPUT', 'text is required')
        }
        if (input.scope !== undefined && (typeof input.scope !== 'string' || input.scope.length === 0)) {
          throw new ContractError('INVALID_INPUT', 'scope must be a non-empty string')
        }
        // Written straight to disk: the UI is not mid-run, so there is no turn to
        // defer to. Warnings go back to the caller — the card was stored, but
        // something about it is probably wrong and the user can judge that.
        const result = addMemoryCard(input.file, input.text, input.scope)
        return { id: result.id, warnings: result.warnings }
      })
  )

  ipcMain.handle(IPC.removeMemoryCard, (_e, input: { file?: unknown; ref?: unknown; index?: unknown }) =>
    guard(() => {
      if (!input || (input.file !== 'MEMORY' && input.file !== 'USER')) {
        throw new ContractError('INVALID_INPUT', 'file must be MEMORY or USER')
      }
      // `ref` is the v1.10 form (id or index); `index` is what v1.7 sent.
      const ref = input.ref !== undefined ? input.ref : input.index
      if (typeof ref === 'string') {
        if (ref.length === 0) throw new ContractError('INVALID_INPUT', 'card id must be a non-empty string')
      } else if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 0) {
        throw new ContractError('INVALID_INPUT', 'card reference must be an id string or a non-negative integer index')
      }
      removeMemoryCard(input.file, ref)
    })
  )

  ipcMain.handle(IPC.listSkillUsage, () => guard(() => listSkillUsage()))

  ipcMain.handle(IPC.searchSessions, (_e, query: unknown) =>
    guard(() => {
      if (typeof query !== 'string') {
        throw new ContractError('INVALID_INPUT', 'query must be a string')
      }
      const records = registry
        .list()
        .map((summary) => registry.get(summary.id))
        .filter((record): record is NonNullable<typeof record> => record !== undefined)
      return searchSessionRecords(records, query)
    })
  )

  ipcMain.handle(IPC.listWorkspaceFiles, (_e, input: unknown) =>
    guard(async () => {
      const query = input as WorkspaceFileQuery | undefined
      if (query === undefined || typeof query.sessionId !== 'string') {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      // Scanned here rather than in the worker: walking a tree while the agent
      // is mid-run would stall the run, and the cwd is already on the record.
      return listWorkspaceFiles(registry.require(query.sessionId).cwd, query.query ?? '')
    })
  )

  // ── Frameless window chrome (TitleBar strip) ──

  ipcMain.handle(IPC.windowMinimize, () => guard(() => chromeWindow()?.minimize()))

  ipcMain.handle(IPC.windowMaximizeToggle, () =>
    guard(() => {
      const win = chromeWindow()
      if (win === null) return false
      const wasMaximized = win.isMaximized()
      if (wasMaximized) win.unmaximize()
      else win.maximize()
      return !wasMaximized
    })
  )

  ipcMain.handle(IPC.windowClose, () => guard(() => chromeWindow()?.close()))

  ipcMain.handle(IPC.windowQuit, () => guard(() => app.quit()))

  ipcMain.handle(IPC.webReload, () =>
    guard(() => {
      chromeWindow()?.webContents.reload()
    })
  )

  ipcMain.handle(IPC.webZoomIn, () =>
    guard(() => {
      const contents = chromeWindow()?.webContents
      if (contents !== undefined) contents.setZoomLevel(contents.getZoomLevel() + ZOOM_STEP)
    })
  )

  ipcMain.handle(IPC.webZoomOut, () =>
    guard(() => {
      const contents = chromeWindow()?.webContents
      if (contents !== undefined) contents.setZoomLevel(contents.getZoomLevel() - ZOOM_STEP)
    })
  )

  ipcMain.handle(IPC.webZoomReset, () =>
    guard(() => {
      chromeWindow()?.webContents.setZoomLevel(0)
    })
  )

  ipcMain.handle(WEB_EDIT_CHANNELS.undo, () => guard(() => runEdit('undo')))
  ipcMain.handle(WEB_EDIT_CHANNELS.cut, () => guard(() => runEdit('cut')))
  ipcMain.handle(WEB_EDIT_CHANNELS.copy, () => guard(() => runEdit('copy')))
  ipcMain.handle(WEB_EDIT_CHANNELS.paste, () => guard(() => runEdit('paste')))
  ipcMain.handle(WEB_EDIT_CHANNELS.selectAll, () => guard(() => runEdit('selectAll')))

  ipcMain.handle(IPC.appAbout, () => guard(showAbout))
}
