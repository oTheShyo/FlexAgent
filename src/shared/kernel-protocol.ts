import type {
  ContractErrorCode,
  KernelEvent,
  PromptDisposition,
  SessionId,
  ThinkingLevel,
  ToolCallId
} from './contract/index'

/**
 * Internal main ↔ worker protocol (NOT part of the renderer contract).
 * Renderer never sees these shapes — only KernelEvent via IPC.kernelEvent.
 */

/** Distributive strip of `seq` so the KernelEvent union stays discriminated. */
export type StripSeq<E> = E extends { seq: number } ? Omit<E, 'seq'> : E
export type WorkerKernelEvent = StripSeq<KernelEvent>

/** Distributive strip of `requestId` — plain Omit collapses the request union. */
export type StripRequestId<R> = R extends { requestId: string } ? Omit<R, 'requestId'> : R

/** Per-source runtime context for P2c hooks (env identity + userConfig interpolation values). */
export interface PluginHookContext {
  /** Absolute plugin root path (ZCODE_/FLEX_/CLAUDE_ PLUGIN_ROOT env + ${...} template). */
  pluginRoot: string
  /** Installed plugin id (ZCODE_/FLEX_ PLUGIN_ID env). */
  pluginId: string
  /** Plugin name (ZCODE_/FLEX_ PLUGIN_NAME env). */
  pluginName: string
  /** Resolved userConfig values (manifest defaults merged with configured options) for ${user_config.*}. */
  userConfig: Record<string, string | number | boolean>
  /** userConfig keys marked sensitive — rejected inside hook command templates. */
  sensitiveKeys: string[]
}

/** Resource spec for enabled plugins — consumed when the worker builds its resource loader. */
export interface PluginResourceSpec {
  /** Absolute paths to extension files/dirs (PI additionalExtensionPaths). */
  extensionPaths: string[]
  /** Absolute skill root dirs of enabled plugins (PI skills discovery). */
  skillRoots: string[]
  /** Absolute command dirs of enabled plugins (bridge registers *.md as PI slash commands). */
  commands: string[]
  /** Absolute hooks/hooks.json paths of enabled plugins (P2c — bridge runs them on kernel events). */
  hooks: string[]
  /** Per hooks-file context keyed by the absolute hooks path (P2c env + interpolation values). */
  hookContexts: Record<string, PluginHookContext>
  /** Absolute MCP config paths of enabled plugins (P2.5 placeholder — empty for now). */
  mcp: string[]
  /** Plugin storage root (worker cwd varies per session). */
  pluginStorageRoot: string
}

export type WorkerRequest =
  | { requestId: string; type: 'listSessions' }
  | { requestId: string; type: 'createSession'; sessionId: SessionId; cwd: string; title?: string }
  | { requestId: string; type: 'openSession'; sessionId: SessionId; cwd: string; piSessionFile?: string }
  | { requestId: string; type: 'prompt'; sessionId: SessionId; text: string; disposition: PromptDisposition }
  | { requestId: string; type: 'abort'; sessionId: SessionId }
  | { requestId: string; type: 'respondPermission'; sessionId: SessionId; toolCallId: ToolCallId; decision: 'allowOnce' | 'allowSession' | 'deny' }
  | { requestId: string; type: 'disposeSession'; sessionId: SessionId }
  | { requestId: string; type: 'listModels' }
  | { requestId: string; type: 'getModelConfig'; sessionId: SessionId }
  | { requestId: string; type: 'setModel'; sessionId: SessionId; provider: string; id: string; thinkingLevel?: ThinkingLevel }
  | { requestId: string; type: 'setThinkingLevel'; sessionId: SessionId; level: ThinkingLevel }
  | { requestId: string; type: 'reloadPlugins'; resourceSpec: PluginResourceSpec }
  | { requestId: string; type: 'shutdown' }

export type WorkerRequestInput = StripRequestId<WorkerRequest>

export type WorkerResponse =
  | { requestId: string; type: 'ok'; result?: unknown }
  | { requestId: string; type: 'fail'; code: ContractErrorCode; message: string; details?: unknown }
  | { type: 'event'; sessionId: SessionId; event: WorkerKernelEvent }

export type MainToWorker = WorkerRequest
export type WorkerToMain = WorkerResponse
