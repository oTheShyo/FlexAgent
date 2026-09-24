import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import {
  ContractError,
  CONTRACT_ERROR_CODES,
  IPC,
  type ApplyFileChangesInput,
  type ContractErrorCode,
  type InstallPluginInput,
  type PromptInput,
  type RespondPermissionInput,
  type SetModelInput,
  type SetThinkingLevelInput,
  type TerminalCreateInput,
  type TerminalInputInput,
  type TerminalResizeInput
} from '../shared/contract'
import { applyFileChanges } from './applyChanges'
import type { KernelHost } from './kernel'
import type { SessionRegistry } from './registry'
import type { TerminalManager } from './pty'
import type { PluginService } from './plugins'
import { scratchCwd, workspaceKey } from './workspace'

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

export function registerIpcHandlers(
  kernel: KernelHost,
  registry: SessionRegistry,
  terminals: TerminalManager,
  plugins: PluginService
): void {
  ipcMain.handle(IPC.listSessions, () => guard(() => registry.list()))

  ipcMain.handle(IPC.createSession, (_e, input: { cwd?: unknown; title?: unknown }) =>
    guard(async () => {
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
      try {
        const result = (await kernel.request({
          type: 'createSession',
          sessionId: id,
          cwd: rec.cwd,
          title: rec.title
        })) as { piSessionFile?: string } | undefined
        if (result?.piSessionFile) registry.attachPiSession(id, result.piSessionFile)
        const stored = registry.require(id)
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
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new ContractError('INVALID_INPUT', 'sessionId is required')
      }
      const rec = registry.require(sessionId)
      const detail = (await kernel.request({
        type: 'openSession',
        sessionId,
        cwd: rec.cwd,
        piSessionFile: rec.piSessionFile
      })) as { messages: unknown[] } | undefined
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
        // open() may rewrite the session file; keep the registry pointing at it.
        if (result?.piSessionFile) registry.attachPiSession(input.sessionId, result.piSessionFile)
        registry.setCwd(input.sessionId, cwd)
      }
      return registry.summary(input.sessionId)
    })
  )

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
      const ack = (await kernel.request({
        type: 'prompt',
        sessionId: input.sessionId,
        text: input.text,
        disposition
      })) as { disposition?: string } | undefined
      registry.touch(input.sessionId)
      return { disposition: ack?.disposition ?? disposition }
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

  // §7.3 walkthrough only — not part of CodexApi / shared/contract.
  ipcMain.handle('diag:killWorker', () =>
    guard(() => kernel.killWorkerForTest())
  )
}
