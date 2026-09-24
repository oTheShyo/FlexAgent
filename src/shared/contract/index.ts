/**
 * FlexAgent cross-process contract (renderer ↔ main ↔ worker/kernel).
 *
 * Design rules (Alice ch.1 — interface longevity):
 * - This file is the ONLY stable seam. UI depends on CodexApi + KernelEvent.
 * - Add optional fields / new event variants only. Never repurpose existing fields.
 * - Transport (mock / Electron IPC / anything else) is disposable.
 * - PI (@earendil-works) types must NOT leak into this file.
 */

// ─── Primitives ───────────────────────────────────────────────────────────────

/** Opaque session id. Plain string so it survives JSON over IPC. */
export type SessionId = string

/** Opaque tool-call id (maps 1:1 to a PI toolCallId). */
export type ToolCallId = string

/** Opaque PTY instance id (main-process node-pty). */
export type TerminalId = string

/**
 * Run lifecycle for one session.
 * - `idle`    — no active run (`agent_settled` equivalent; safe to prompt freely)
 * - `running` — at least one run in flight (prompt requires steer/followUp semantics)
 */
export type RunState = 'idle' | 'running'

export type MessageRole = 'user' | 'assistant'

/** Wire shape for transcript messages (history restore + live echoes). */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: number
}

export interface SessionSummary {
  id: SessionId
  /** Display title (from first user message or user rename). */
  title: string
  /** Absolute workspace path — the agent's cwd. */
  cwd: string
  createdAt: number
  updatedAt: number
  runState: RunState
}

export interface SessionDetail {
  summary: SessionSummary
  /** Full visible transcript for this session (UI-only messages included). */
  messages: ChatMessage[]
}

// ─── Errors (single strategy: rejected promises carry ContractError) ─────────

export type ContractErrorCode =
  | 'SESSION_NOT_FOUND'
  /** prompt while running without resolving steer/followUp (kernel default = steer; this is for explicit misuse). */
  | 'SESSION_BUSY'
  /** Malformed / missing fields at the boundary. */
  | 'INVALID_INPUT'
  /** respondPermission for an unknown or already-settled toolCallId. */
  | 'PERMISSION_EXPIRED'
  /** Unknown, killed, or never-created terminalId. */
  | 'TERMINAL_NOT_FOUND'
  /** Too many live PTYs for this session (kernel-enforced cap). */
  | 'TERMINAL_LIMIT'
  /** No installed plugin with the given id. */
  | 'PLUGIN_NOT_FOUND'
  /** installPlugin for a plugin id that is already installed. */
  | 'PLUGIN_ALREADY_INSTALLED'
  /** Plugin manifest missing or fails validation. */
  | 'PLUGIN_MANIFEST_INVALID'
  /** A declared plugin component path is invalid/unreadable. */
  | 'PLUGIN_COMPONENT_INVALID'
  /** Plugin source path does not exist / is not a directory. */
  | 'PLUGIN_PATH_INVALID'
  /** Kernel/PI internal failure not attributable to a single event. */
  | 'KERNEL_INTERNAL'

export class ContractError extends Error {
  readonly code: ContractErrorCode
  readonly details?: unknown

  constructor(code: ContractErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'ContractError'
    this.code = code
    this.details = details
  }
}

// ─── Commands (renderer → kernel) ────────────────────────────────────────────

export interface CreateSessionInput {
  /** Absolute path of the project folder to work in. */
  cwd: string
  title?: string
}

/**
 * How a prompt attaches to an in-flight run (PI: prompt() must choose when streaming).
 * - Kernel behavior when `runState === 'idle'`: mode is ignored; run starts (`disposition: 'started'`).
 * - When `runState === 'running'`:
 *   - omitted or `'steer'` → injected after the current assistant turn (disposition `'steering'`)
 *   - `'followUp'`          → queued until the run would settle (disposition `'queued'`)
 */
export type PromptMode = 'steer' | 'followUp'

export interface PromptInput {
  sessionId: SessionId
  text: string
  mode?: PromptMode
}

export type PromptDisposition = 'started' | 'steering' | 'queued'

export interface PromptAck {
  disposition: PromptDisposition
}

export type PermissionDecision =
  /** Allow this one tool call only. */
  | 'allowOnce'
  /** Allow this tool name for the rest of the session. */
  | 'allowSession'
  | 'deny'

export interface RespondPermissionInput {
  sessionId: SessionId
  toolCallId: ToolCallId
  decision: PermissionDecision
}

export interface TerminalCreateInput {
  sessionId: SessionId
  cols: number
  rows: number
  /** Defaults to the session's cwd when omitted. */
  cwd?: string
  /** Extra env vars merged over process env. */
  env?: Record<string, string>
}

export interface TerminalCreateAck {
  terminalId: TerminalId
}

export interface TerminalInputInput {
  terminalId: TerminalId
  /** Bytes written to the PTY master (keystrokes, pasted clipboard, resize responses). */
  data: string
}

export interface TerminalResizeInput {
  terminalId: TerminalId
  cols: number
  rows: number
}

export interface ApplyFileChangesInput {
  sessionId: SessionId
  /** Full FileChange entries from `file_changes` (patch + path are authoritative). */
  files: FileChange[]
}

export interface ApplyFileChangesResult {
  /** POSIX rel paths newly written under session cwd. */
  applied: string[]
  /** Already on disk with the patch's resulting content (idempotent success). */
  alreadyApplied: string[]
  failed: Array<{ path: string; reason: string }>
}

/** PI thinking levels (session-scoped; clamped to model capability on set). */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Minimal model identity exposed to the UI (no PI types). */
export interface ModelOption {
  provider: string
  id: string
  /** Optional display label (falls back to `id` in UI if absent). */
  label?: string
}

/** Effective model/thinking config for one session. */
export interface ModelConfig {
  /** `null` when the session has no model selected yet. */
  model: ModelOption | null
  thinkingLevel: ThinkingLevel
  /** Levels the current model accepts (PI `getAvailableThinkingLevels`). Omitted when no model. */
  availableThinkingLevels?: ThinkingLevel[]
}

export interface SetModelInput {
  sessionId: SessionId
  provider: string
  /** Model id as listed by `listModels`. */
  id: string
  /** Optional thinking level applied atomically with the model switch. */
  thinkingLevel?: ThinkingLevel
}

export interface SetThinkingLevelInput {
  sessionId: SessionId
  level: ThinkingLevel
}

// ─── Plugins (v1.4) ──────────────────────────────────────────────────────────

/** Stable plugin identity: `${name}@${source}`. */
export type PluginId = string

/** Where an installed plugin came from. */
export type PluginSourceKind = 'bundled' | 'local' | 'marketplace'

/** Component kinds a plugin may bundle. Only `extension`/`skill` run in P1. */
export type PluginComponentKind = 'extension' | 'skill' | 'command' | 'hook' | 'mcp'

export interface PluginSource {
  kind: PluginSourceKind
  /** Display label: 'Bundled', 'Local', or a marketplace name. */
  label: string
}

export interface PluginSummary {
  id: PluginId
  name: string
  version: string
  description?: string
  enabled: boolean
  source: PluginSource
  componentCounts: Partial<Record<PluginComponentKind, number>>
}

export interface PluginComponentInfo {
  kind: PluginComponentKind
  name: string
  description?: string
  /** Path relative to the plugin root, POSIX separators. */
  path?: string
}

export interface PluginUserConfigSpec {
  key: string
  title: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  default?: string | number | boolean
  required?: boolean
  /** Sensitive values are masked and not writable from the UI in P1. */
  sensitive?: boolean
}

export interface PluginDiagnostic {
  code: string
  severity: 'error' | 'warning'
  message: string
  pluginId?: PluginId
}

export interface PluginDetail extends PluginSummary {
  author?: string | { name: string; email?: string; url?: string }
  homepage?: string
  keywords?: string[]
  /** Absolute path of the installed plugin root. */
  rootPath: string
  components: PluginComponentInfo[]
  userConfig?: PluginUserConfigSpec[]
  configuredOptions?: Record<string, string | number | boolean>
  diagnostics?: PluginDiagnostic[]
}

export interface InstallPluginInput {
  /** P1 supports a local directory only. */
  source: { kind: 'directory'; path: string }
}

/**
 * Plugin change notification. Delivered on a dedicated global channel
 * (`IPC.pluginsChanged`), NOT through `KernelEvent`/session `seq`.
 */
export interface PluginChangeEvent {
  plugins: PluginSummary[]
}

// ─── Events (kernel → renderer), one discriminated union ─────────────────────

/** Every event is stamped with session + monotonic per-session sequence. */
export interface EventMeta {
  sessionId: SessionId
  /** Monotonic, gap-free within a session subscription. Gaps ⇒ dropped events. */
  seq: number
  /** Kernel timestamp (ms). */
  ts: number
}

/**
 * PTY note: interactive terminals are real node-pty instances owned by the main
 * process. They are NOT agent-gated — the user drives a full shell with the
 * app process's OS permissions. Agent bash tool calls remain separate
 * (`tool_*` events + permission_request).
 */
export type KernelEvent =
  /** Session run state flipped. Always emitted on transitions only. */
  | (EventMeta & { type: 'run_state'; runState: RunState })
  /** User message entered the transcript (echo for direct prompt / steer / queued followUp when it fires). */
  | (EventMeta & { type: 'user_message'; message: ChatMessage })
  /** Streaming assistant text delta (PI: message_update + text_delta). */
  | (EventMeta & { type: 'text_delta'; delta: string })
  /**
   * A message finalized (PI: message_end). Authoritative content —
   * UI should replace any partial buffer for the same message id when present.
   */
  | (EventMeta & { type: 'message_end'; message: ChatMessage })
  /** Tool call began (PI: tool_execution_start). */
  | (EventMeta & {
      type: 'tool_start'
      toolCallId: ToolCallId
      /** Stable tool name: 'bash' | 'read_file' | 'write_file' | 'edit_file' | ... */
      name: string
      /** Human-readable label for cards (may equal name). */
      label: string
      /** JSON-serializable args, already redacted for display by the kernel. */
      args: Record<string, unknown>
    })
  /** Tool progress / streamed stdout (PI: tool_execution_update). */
  | (EventMeta & {
      type: 'tool_update'
      toolCallId: ToolCallId
      /** Incremental text for this update (append, do not replace). */
      chunk: string
    })
  /** Tool finished (PI: tool_execution_end). */
  | (EventMeta & {
      type: 'tool_end'
      toolCallId: ToolCallId
      isError: boolean
      /** Short single-line outcome for UI cards; not the full tool result payload. */
      summary?: string
    })
  /**
   * Kernel is waiting on `respondPermission` (PI: beforeToolCall blocked).
   * No further tool execution for this toolCallId until answered.
   * Other events (text_delta of later turns) may still arrive only after response.
   */
  | (EventMeta & {
      type: 'permission_request'
      toolCallId: ToolCallId
      name: string
      label: string
      args: Record<string, unknown>
      /** Why the kernel asked (e.g. write outside cwd, first bash use). */
      reason?: string
    })
  /**
   * Aggregated file changes visible to the user for this run so far
   * (kernel derives from edit/patch tool results — PI has no native file_changes event).
   * Full replacement snapshot, not a delta.
   */
  | (EventMeta & { type: 'file_changes'; files: FileChange[] })
  /** Async failure during a run. Run may still settle afterward. */
  | (EventMeta & {
      type: 'error'
      code: ContractErrorCode
      message: string
      toolCallId?: ToolCallId
    })
  /** PTY stdout/stderr chunk (node-pty onData). Append; do not replace. */
  | (EventMeta & { type: 'pty_output'; terminalId: TerminalId; data: string })
  /** PTY process exited. Terminal is dead; further input is invalid. */
  | (EventMeta & { type: 'pty_exit'; terminalId: TerminalId; exitCode: number })

export type KernelEventType = KernelEvent['type']

export interface FileChange {
  /** Path relative to session cwd, POSIX separators. */
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  /** Unified diff body (without file headers is OK; path is authoritative in `path`). */
  patch: string
}

// ─── The swap boundary ───────────────────────────────────────────────────────

/**
 * UI depends only on this interface.
 * - Mock: renderer-only implementation (today).
 * - Real: preload bridge → main → worker (PI `AgentSession`).
 *
 * Event delivery: session-scoped subscription (not per-prompt generators), so
 * steer/permission/abort work mid-run without owning the "request" object.
 */
export interface CodexApi {
  listSessions(): Promise<SessionSummary[]>
  createSession(input: CreateSessionInput): Promise<SessionSummary>
  /** Restore a session (summary + full transcript). Idempotent. */
  openSession(sessionId: SessionId): Promise<SessionDetail>
  /** Remove the session from the registry (persisted). Throws SESSION_NOT_FOUND if missing. */
  deleteSession(sessionId: SessionId): Promise<void>

  /**
   * Submit user text. Resolves when accepted (not when the run finishes).
   * Events arrive via `subscribe`.
   */
  prompt(input: PromptInput): Promise<PromptAck>

  /** Abort the in-flight run for the session (PI: abort()). Idle sessions: no-op. */
  abort(sessionId: SessionId): Promise<void>

  /** Answer a pending `permission_request`. */
  respondPermission(input: RespondPermissionInput): Promise<void>

  /**
   * Subscribe to a session's events (agent + any PTYs created under it).
   * Events are delivered in `seq` order. Returns unsubscribe. Multiple
   * listeners allowed. Emitting `run_state: idle` does not auto-unsubscribe.
   */
  subscribe(sessionId: SessionId, listener: (event: KernelEvent) => void): () => void

  /** Spawn a real PTY (node-pty in main). Resolves when the shell is ready. */
  terminalCreate(input: TerminalCreateInput): Promise<TerminalCreateAck>
  /** Write bytes to the PTY master. */
  terminalInput(input: TerminalInputInput): Promise<void>
  /** SIGWINCH-equivalent resize. */
  terminalResize(input: TerminalResizeInput): Promise<void>
  /** Kill the PTY (SIGHUP/termination). Idempotent for already-dead ids. */
  terminalKill(terminalId: TerminalId): Promise<void>

  /**
   * Apply accepted FileChange patches under the session cwd (Diff Accept).
   * Main-process fs only — does not enter the agent transcript.
   * Reject while `runState === 'running'` with SESSION_BUSY.
   * Per-file failures land in `result.failed` (not a whole-call reject).
   */
  applyFileChanges(input: ApplyFileChangesInput): Promise<ApplyFileChangesResult>

  /** Available models (provider auth OK). Not session-scoped. */
  listModels(): Promise<ModelOption[]>
  /** Current session's effective model + thinking config. */
  getModelConfig(sessionId: SessionId): Promise<ModelConfig>
  /** Switch model for one session (session-only; does not persist PI defaults). */
  setModel(input: SetModelInput): Promise<ModelConfig>
  /** Set thinking level for one session (session-only; clamped to model capability). */
  setThinkingLevel(input: SetThinkingLevelInput): Promise<ModelConfig>
  /** Native directory picker for Choose project. Resolves `null` when cancelled. */
  pickDirectory(): Promise<string | null>

  /** Installed plugins (local + bundled). Not session-scoped. */
  listPlugins(): Promise<PluginSummary[]>
  /** Plugin detail: components + userConfig spec + diagnostics. */
  getPlugin(id: PluginId): Promise<PluginDetail>
  /** Enable/disable a plugin. Idempotent; triggers controlled kernel restart on change. */
  setPluginEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary>
  /** Install from a local directory. Rejects PLUGIN_ALREADY_INSTALLED on id conflict. */
  installPlugin(input: InstallPluginInput): Promise<PluginSummary>
  /** Uninstall (delete dir; bundled plugins get a suppressed marker). */
  uninstallPlugin(id: PluginId): Promise<void>
  /**
   * Subscribe to plugin changes (global, not session-scoped). Delivered on a
   * dedicated channel outside `KernelEvent`/`seq`. Returns unsubscribe.
   */
  subscribePlugins(listener: (event: PluginChangeEvent) => void): () => void
}

// ─── Electron IPC channel names (real transport only) ────────────────────────

/** Channels are additive — never rename existing keys. */
export const IPC = {
  listSessions: 'codex:listSessions',
  createSession: 'codex:createSession',
  openSession: 'codex:openSession',
  deleteSession: 'codex:deleteSession',
  prompt: 'codex:prompt',
  abort: 'codex:abort',
  respondPermission: 'codex:respondPermission',
  terminalCreate: 'codex:terminalCreate',
  terminalInput: 'codex:terminalInput',
  terminalResize: 'codex:terminalResize',
  terminalKill: 'codex:terminalKill',
  applyFileChanges: 'codex:applyFileChanges',
  listModels: 'codex:listModels',
  getModelConfig: 'codex:getModelConfig',
  setModel: 'codex:setModel',
  setThinkingLevel: 'codex:setThinkingLevel',
  pickDirectory: 'codex:pickDirectory',
  listPlugins: 'codex:listPlugins',
  getPlugin: 'codex:getPlugin',
  setPluginEnabled: 'codex:setPluginEnabled',
  installPlugin: 'codex:installPlugin',
  uninstallPlugin: 'codex:uninstallPlugin',
  /** main → renderer push for PluginChangeEvent (global, per webContents). */
  pluginsChanged: 'codex:pluginsChanged',
  /** main → renderer push for KernelEvent (per webContents). */
  kernelEvent: 'codex:kernelEvent'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
