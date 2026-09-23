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
  /** main → renderer push for KernelEvent (per webContents). */
  kernelEvent: 'codex:kernelEvent'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
