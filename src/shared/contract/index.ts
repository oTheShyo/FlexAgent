/**
 * FlexAgent cross-process contract (renderer ↔ main ↔ worker/kernel).
 *
 * Design rules (Alice ch.1 — interface longevity):
 * - This file is the ONLY stable seam. UI depends on CodexApi + KernelEvent.
 * - Add optional fields / new event variants only. Never repurpose existing fields.
 * - Transport (mock / Electron IPC / anything else) is disposable.
 * - PI (@earendil-works) types must NOT leak into this file.
 */
import type { ReasoningEffort } from '../reasoningEffort'

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
  /**
   * Archived sessions stay in the registry but leave the main list.
   * Optional so a pre-`archived` sessions.json still loads; readers treat a
   * missing value as `false` rather than as a third state.
   */
  archived?: boolean
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
  /** Marketplace/plugin source string failed to parse, or a recognized-but-unsupported source kind. */
  | 'PLUGIN_SOURCE_INVALID'
  /** Downloading or verifying a remote plugin/marketplace archive failed (network, HTTP status, sha256). */
  | 'PLUGIN_DOWNLOAD_FAILED'
  /** No user-level MCP server with the given name (~/.flexagent/mcp.json). */
  | 'USER_MCP_NOT_FOUND'
  /** No custom model with the given provider/id (~/.pi/agent/models.json). */
  | 'CUSTOM_MODEL_NOT_FOUND'
  /** No user-level skill with the given name (~/.flexagent/skills). */
  | 'SKILL_NOT_FOUND'
  /** A user-level skill with the same name already exists and overwrite was not set. */
  | 'SKILL_ALREADY_INSTALLED'
  /** Skill hub entry source or local folder failed to parse / validate (no SKILL.md). */
  | 'SKILL_SOURCE_INVALID'
  /** Fetching a skill hub index failed (network, HTTP status, rate limit). */
  | 'SKILL_HUB_UNAVAILABLE'
  /** Kernel/PI internal failure not attributable to a single event. */
  | 'KERNEL_INTERNAL'
  /**
   * A model call failed after the kernel's retries (network unreachable, HTTP
   * error, auth rejection…). The run is over — the transcript is intact and the
   * kernel transport is fine, so this is a chat-level error, not a
   * "connection lost" banner.
   */
  | 'MODEL_ERROR'

/**
 * Runtime mirror of {@link ContractErrorCode} — single source for the IPC
 * error-code allowlists in main/preload/marketplace. `satisfies` pins every
 * entry to the union; `_ContractErrorCodeArrayCoversUnion` fails compilation
 * if a union member is ever missing here.
 */
export const CONTRACT_ERROR_CODES = [
  'SESSION_NOT_FOUND',
  'SESSION_BUSY',
  'INVALID_INPUT',
  'PERMISSION_EXPIRED',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_LIMIT',
  'PLUGIN_NOT_FOUND',
  'PLUGIN_ALREADY_INSTALLED',
  'PLUGIN_MANIFEST_INVALID',
  'PLUGIN_COMPONENT_INVALID',
  'PLUGIN_PATH_INVALID',
  'PLUGIN_SOURCE_INVALID',
  'PLUGIN_DOWNLOAD_FAILED',
  'USER_MCP_NOT_FOUND',
  'CUSTOM_MODEL_NOT_FOUND',
  'SKILL_NOT_FOUND',
  'SKILL_ALREADY_INSTALLED',
  'SKILL_SOURCE_INVALID',
  'SKILL_HUB_UNAVAILABLE',
  'KERNEL_INTERNAL',
  'MODEL_ERROR'
] as const satisfies readonly ContractErrorCode[]

/** Compile-time drift guard: errors if a ContractErrorCode is missing above. */
type AssertTrue<T extends true> = T
export type _ContractErrorCodeArrayCoversUnion = AssertTrue<
  Exclude<ContractErrorCode, (typeof CONTRACT_ERROR_CODES)[number]> extends never ? true : false
>

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
  /**
   * Absolute path of the project folder to work in. Omit it to start in the
   * scratch workspace — a dedicated empty directory for chats that are just a
   * conversation. `scratchCwd()` returns that path, and `setSessionCwd()` binds
   * a real folder later without losing the transcript.
   */
  cwd?: string
  title?: string
}

/** Re-bind a session to a different project folder. */
export interface SetSessionCwdInput {
  sessionId: SessionId
  /** Absolute path of the project folder to work in from now on. */
  cwd: string
}

/**
 * User-set display name, persisted in the registry (not a UI-only overlay, so
 * it survives a restart and a second window). Rejects blank titles — a session
 * must always have something to show.
 */
export interface RenameSessionInput {
  sessionId: SessionId
  title: string
}

/**
 * Archive (or restore). Archived is not deleted: the transcript and the
 * registry record both stay, the session only leaves the main list.
 */
export interface SetSessionArchivedInput {
  sessionId: SessionId
  archived: boolean
}

/**
 * How a prompt attaches to an in-flight run (PI: prompt() must choose when streaming).
 * - Kernel behavior when `runState === 'idle'`: mode is ignored; run starts (`disposition: 'started'`).
 * - When `runState === 'running'`:
 *   - omitted or `'steer'` → injected after the current assistant turn (disposition `'steering'`)
 *   - `'followUp'`          → queued until the run would settle (disposition `'queued'`)
 */
export type PromptMode = 'steer' | 'followUp'

/**
 * Something the user pulled into a prompt — a quoted selection, a file, a
 * session. Ticket 27.
 *
 * Carried as its own field rather than folded into `text` so the two sides
 * agree on what is a reference and what the user actually typed. The kernel
 * still only accepts a string, so these are rendered into the prompt on the
 * worker side; what the field buys is that the rendering happens once, in one
 * place, with the file contents available and the size limits enforced where
 * they cannot be bypassed.
 */
export interface PromptReference {
  /** `selection` carries `text`; `file` carries `path`; `session` carries both. */
  kind: 'selection' | 'file' | 'session'
  /** Shown to the user on the chip, and to the model as the block's heading. */
  label: string
  /** The quoted text. Present for `selection` and `session`. */
  text?: string
  /** Path relative to the session's working directory. Present for `file`. */
  path?: string
}

export interface PromptInput {
  sessionId: SessionId
  text: string
  mode?: PromptMode
  /** Ticket 27. Additive; a caller that omits it behaves exactly as before. */
  references?: PromptReference[]
}

export type PromptDisposition = 'started' | 'steering' | 'queued'

export interface PromptAck {
  disposition: PromptDisposition
  /**
   * Ticket 27 (additive). What could not be attached to this prompt — an
   * unreadable file, a reference over the size limit. Reported rather than
   * dropped because a mention that silently contributes nothing looks exactly
   * like one that worked.
   */
  notices?: string[]
}

export type PermissionDecision =
  /** Allow this one tool call only. */
  | 'allowOnce'
  /** Allow this tool *with the same parameters* for the rest of the session. */
  | 'allowSession'
  | 'deny'

/**
 * Trust level for a run, along a single spectrum from most conservative to least.
 * Each mode is implemented as a decision-chain preset (see `permissionGate.ts`);
 * the mode narrows which layers can answer `allow` without a user prompt.
 *
 * - `plan`         read tools auto-allow, every write is blocked outright.
 * - `default`      heuristic allow for reads, prompt for anything else.
 * - `acceptEdits`  file read/write auto-allow (version-controlled), bash still judged.
 * - `auto`         heuristics + rules decide; only genuinely ambiguous calls prompt.
 * - `bypass`       no prompts at all, except hard-denied destructive patterns.
 */
export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypass'

/** Which layer of the decision chain produced a verdict — the audit trail. */
export type PermissionVia = 'mode' | 'rule' | 'heuristic' | 'classifier' | 'user'

export interface PermissionVerdict {
  outcome: 'allow' | 'deny' | 'ask'
  via: PermissionVia
  /** Machine-readable-ish short tag, stable enough to log and display. */
  reason: string
}

export interface RespondPermissionInput {
  sessionId: SessionId
  toolCallId: ToolCallId
  decision: PermissionDecision
}

export interface SetPermissionModeInput {
  sessionId: SessionId
  mode: PermissionMode
}

/** One selectable answer to an agent question (issue 10). */
export interface QuestionOption {
  id: string
  label: string
  description?: string
}

export interface RespondQuestionInput {
  sessionId: SessionId
  questionId: string
  /** The chosen option's id, or free text when the user typed instead. */
  answer: string
}

/**
 * Stop the countdown for one question, permanently. Sent as soon as the user
 * touches the question at all — hovering counts — because a timer that resumes
 * is a timer that can answer on their behalf (issue 10).
 */
export interface StopQuestionTimerInput {
  sessionId: SessionId
  questionId: string
}

export type PermissionRuleAction = 'allow' | 'deny' | 'ask'

/**
 * How far a rule reaches. `global` is the original meaning of a rule (every
 * workspace); `project` additionally requires the call to happen inside the
 * project recorded in `projectPath`. Absent means `global`, so a rule file
 * written before scopes existed keeps behaving the same way.
 */
export type PermissionRuleScope = 'global' | 'project'

/** Who wrote a rule. Only `user` rules are removable from the settings list. */
export type PermissionRuleOrigin = 'builtin' | 'user'

/**
 * One ordered rule. Matching is first-hit-wins *within one action class*,
 * and the classes are collected deny → ask → allow (see `permissionGate.ts`):
 * the first rule whose `tool` matches (and whose optional `command`/`path`
 * predicates also match) decides the call. Order beats specificity on purpose —
 * numbered priorities are unmaintainable once a few dozen rules exist.
 *
 * Two rules that both match a call but disagree on the outcome never depend on
 * their position in the file: a refusal always wins, and an explicit "ask"
 * outranks an allow. That is what makes a user-written deny able to survive an
 * earlier built-in allow.
 */
export interface PermissionRule {
  /** Stable tag, shown in the read-only rule list; used as the revoke handle. */
  id?: string
  /** Tool-name matcher; `*` matches any tool. Omit to match every tool. */
  tool?: string
  /** Bash-command substring matcher (applies to command-shaped tools). */
  command?: string
  /** Path substring matcher applied to the tool's path-ish args. */
  path?: string
  action: PermissionRuleAction
  /** Why this rule exists — surfaced in the UI and the dialog reason. */
  note?: string
  /** v1.19: reach of the rule. Absent = `global` (pre-existing semantics). */
  scope?: PermissionRuleScope
  /**
   * v1.19: cwd the rule belongs to, recorded for `scope: 'project'` rules so a
   * rule made in one checkout does not follow the user into a sibling clone.
   * Ignored unless `scope` is `'project'`.
   */
  projectPath?: string
  /** v1.19: when the rule was authored, ms epoch. Absent for pre-v1.19 files. */
  createdAt?: number
  /** v1.19: absent on purpose — the loader fills `'user'` for file rules. */
  origin?: PermissionRuleOrigin
}

/**
 * A rule authored from the confirmation dialog: the matchers are derived from
 * the call the user is looking at, so the caller only has to say which call and
 * how far the resulting rule should reach.
 */
export interface SavePermissionRuleInput {
  /** Tool name of the call being approved or refused. */
  tool: string
  /** Raw call arguments — the matchers are derived from them in main. */
  args: Record<string, unknown>
  /**
   * Session the decision belongs to. Main resolves it to the session cwd, which
   * is what a `project` rule anchors to — the renderer is not trusted to know
   * which directory a rule was made in.
   */
  sessionId: SessionId
  scope: PermissionRuleScope
  action: Exclude<PermissionRuleAction, 'ask'>
  /** Why the user chose this; stored verbatim for the settings list. */
  note?: string
}

export interface RemovePermissionRuleInput {
  id: string
}

/** Create-or-update payload for a custom subagent definition (ticket 16). */
export interface CustomAgentDefinitionInput {
  name: string
  description: string
  label?: string
  /** `provider/id`; absent → the role follows the dispatching session's model. */
  model?: string
  /** Explicit tool whitelist; an MCP tool here is its own declaration. */
  tools: string[]
  maxTurns?: number
  enabled: boolean
  persona: string
}

export interface CustomAgentDiagnostic {
  file: string
  code: string
  message: string
  severity: 'error' | 'warning'
}

export interface CustomAgentsSnapshot {
  agents: Array<{
    name: string
    label: string
    description: string
    model?: string
    tools: string[]
    maxTurns?: number
    enabled: boolean
    builtin: boolean
    persona: string
  }>
  diagnostics: CustomAgentDiagnostic[]
}

export interface PermissionRuleSet {
  /** Absolute path of the file the rules were loaded from. */
  sourcePath: string
  rules: PermissionRule[]
}

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'plan',
  'default',
  'acceptEdits',
  'auto',
  'bypass'
]

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'Plan',
  default: 'Default',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  bypass: 'Bypass'
}

export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  plan: 'Read-only planning. Writes are blocked.',
  default: 'Safe operations run; anything else asks.',
  acceptEdits: 'File edits run freely; commands still judged.',
  auto: 'Heuristics and rules decide; you are only asked when genuinely ambiguous.',
  bypass: 'Never interrupts. Destructive patterns are still refused.'
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

/**
 * Reasoning-effort tiers (低/高/最高) and their capability-driven mapping onto
 * thinking levels — implemented in `../reasoningEffort`, re-exported here so
 * every consumer reaches the seam the same way it reaches `ThinkingLevel`.
 */
export * from '../reasoningEffort'

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
  /**
   * Tier (低/高/最高) the current level resolves to on this model — `null`
   * when the level is `off`, no model is selected, or the level sits outside
   * the tier set (raw level picked in the advanced menu).
   */
  effort: ReasoningEffort | null
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

// ─── Custom models (v1.9) ────────────────────────────────────────────────────

/**
 * API dialect the add-model form offers. PI's `api` field accepts more
 * (`google-generative-ai`, `azure-openai-responses`, …); {@link CustomModelEntry.api}
 * therefore echoes whatever the file holds instead of narrowing to this list.
 */
export type CustomModelApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export const CUSTOM_MODEL_APIS: readonly CustomModelApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages'
]

/**
 * One user-defined model as stored in `providers[].models[]` of
 * `~/.pi/agent/models.json` — the file the kernel itself reads, path supplied by
 * the kernel.
 * Credentials never leave the main process — only `apiKeySet` is exposed.
 */
export interface CustomModelEntry {
  /** Provider id; matches `ModelOption.provider` in `listModels()`. */
  provider: string
  /** Model id sent to the API. */
  id: string
  /** Display name (`name` in the file); the UI falls back to `id`. */
  label?: string
  /** Provider-level base URL shared by every model of that provider. */
  baseUrl?: string
  /** Echoed provider/model `api`; absent when PI infers it from a built-in provider. */
  api?: string
  /**
   * True when the model accepts thinking levels (`reasoning: true` in the file).
   * PI reports only `off` for a model without this flag, so the composer's
   * THINKING menu collapses to a single entry until it is set.
   */
  reasoning?: boolean
  /** True when the provider entry carries an API key (literal or `$ENV_VAR`). */
  apiKeySet: boolean
}

/** Identity of a stored custom model. */
export interface CustomModelRef {
  provider: string
  id: string
}

/** Validated write input — one model entry, provider-level fields included. */
export interface CustomModelSaveInput {
  provider: string
  id: string
  label?: string
  baseUrl?: string
  api?: CustomModelApi
  /** Omit to keep the stored key. `$ENV_VAR` references are stored verbatim. */
  apiKey?: string
  /**
   * Mark the model as reasoning-capable (shows thinking levels in the picker).
   * `true` writes the flag, `false` clears it, omit keeps the stored value.
   */
  reasoning?: boolean
  /** Present when editing: the entry is moved, not duplicated. */
  original?: CustomModelRef
}

export interface CustomModelWriteResult {
  /** Full list after the write (same shape as `listCustomModels`). */
  models: CustomModelEntry[]
  /**
   * Set when models.json was written but the kernel did not end up resolving the
   * entry (composition error, unreadable file). The file change stands — the UI
   * shows this instead of pretending the model works.
   */
  error?: string
}

// ─── Model routing (v2.0) ────────────────────────────────────────────────────

/**
 * A named purpose the app spends an LLM call on.
 *
 * Roles exist only where something in this codebase actually calls a model for
 * that purpose — a role with no consumer would be a control that configures
 * nothing. `permission` joins the list when the permission gate lands.
 */
export type ModelRole = 'chat' | 'compaction'

export const MODEL_ROLES: readonly ModelRole[] = ['chat', 'compaction']

export const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
  chat: 'Main conversation',
  compaction: 'Context compaction'
}

export const MODEL_ROLE_HINTS: Record<ModelRole, string> = {
  chat: 'The model a new chat starts on. Left unset, the kernel decides.',
  compaction:
    "Summarises the transcript when the context window fills up. Left unset, the conversation's own model does it — a long-context model here keeps the summary faithful without slowing the conversation down."
}

/**
 * Where a role's effective model came from.
 *
 * - `binding` — the role has its own model
 * - `kernel` — nothing is bound, so the kernel's own rule decides: for `chat`
 *   that is `defaultProvider`/`defaultModel` in its settings, for every other
 *   role it is the model the conversation is already running on
 */
export type ModelRoleSource = 'binding' | 'kernel'

export interface ModelRoleState {
  role: ModelRole
  source: ModelRoleSource
  /** The resolved model, or `null` when nothing resolves at all. */
  model: ModelOption | null
  /**
   * Set when the stored binding could not be resolved by the kernel (unknown
   * model, provider lost its credentials). The binding is kept — the UI shows
   * this instead of silently falling back.
   */
  error?: string
}

/**
 * What a model can do, read from the kernel's own catalogue (article §5: a
 * whitelist entry declares its capabilities so a routing choice can be made on
 * facts rather than on the model's name).
 */
export interface ModelFacts {
  provider: string
  id: string
  label?: string
  /** Context window in tokens — decides how often compaction will trigger. */
  contextWindow?: number
  maxTokens?: number
  /** Model emits a reasoning/thinking channel. */
  reasoning?: boolean
  /** Accepted input modalities, e.g. `['text', 'image']`. */
  input?: string[]
  /** USD per million input tokens, when the catalogue knows it. */
  costIn?: number
  /** USD per million output tokens. */
  costOut?: number
}

export interface RoutingState {
  /** Absolute path of the routing file, for the Settings copy. */
  path: string
  roles: ModelRoleState[]
  facts: ModelFacts[]
}

export interface SetModelRoleInput {
  role: ModelRole
  /** `null` clears the binding so the role inherits `chat` again. */
  model: ModelOption | null
}

// ─── Network (v2.0) ──────────────────────────────────────────────────────────

/** Mirrors PI's own idle-timeout presets; `0` disables the guard. */
export const HTTP_IDLE_TIMEOUT_CHOICES: readonly { label: string; ms: number }[] = [
  { label: '30 sec', ms: 30_000 },
  { label: '1 min', ms: 60_000 },
  { label: '2 min', ms: 120_000 },
  { label: '5 min', ms: 300_000 },
  { label: 'Disabled', ms: 0 }
]

export interface NetworkSettings {
  /** Absolute path of the kernel's `settings.json`, supplied by the kernel. */
  path: string
  proxy: string
  /** Gap between streamed tokens before the request is dropped and retried. */
  idleTimeoutMs: number
  /** Retries for one provider request before the turn fails. */
  maxRetries: number
  /**
   * `HTTP_PROXY`/`HTTPS_PROXY` already present in the environment. PI only fills
   * these in when empty, so a set variable wins over the setting — the UI says so
   * rather than showing a field that does nothing.
   */
  envProxy: string | null
  /**
   * `installed` once this process has installed the kernel's HTTP dispatcher.
   * Without it a proxy cannot work at all: Node's default dispatcher ignores the
   * proxy environment variables.
   */
  dispatcher: 'installed' | 'unavailable'
  /** Why the dispatcher is unavailable, and what to do instead. */
  note?: string
}

export interface SetNetworkInput {
  proxy?: string
  idleTimeoutMs?: number
  maxRetries?: number
}

// ─── Usage attribution (v2.0) ────────────────────────────────────────────────

export interface UsageTotals {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export interface UsageBucket extends UsageTotals {
  /** The purpose, or `provider/model` when grouping by model. */
  key: string
}

export interface UsageReport {
  sessionId: SessionId
  /** Every token the session spent, across all purposes. */
  total: UsageTotals
  /** Split by purpose, so "why was this conversation expensive" has an answer. */
  byPurpose: UsageBucket[]
  byModel: UsageBucket[]
}

/** One row of the app-wide usage report (issue 09). */
export interface GlobalUsageBucket extends UsageBucket {
  /** input + output + cacheRead + cacheWrite — what the user pays for. */
  total: number
  /** Calls that did not succeed (`ok: false`). */
  failed: number
}

/**
 * App-wide usage, aggregated offline from the observability NDJSON (issue 09).
 * Deliberately not a live counter: it is a report over what was recorded, so it
 * cannot disagree with the event log.
 */
export interface GlobalUsageStats {
  generatedAt: number
  /** False when nothing has been recorded yet — the UI shows a guided empty state. */
  hasData: boolean
  totals: GlobalUsageBucket
  byModel: GlobalUsageBucket[]
  /**
   * The axis that answers "what did turning this feature on cost me": chat,
   * compaction, permission_classifier, memory_dedupe, memory_extract, role_task.
   */
  byCallSource: GlobalUsageBucket[]
  /** UTC days, oldest first. */
  byDay: GlobalUsageBucket[]
  toolCalls: number
  toolCallsByTool: { name: string; count: number }[]
  /** Distinct sessions seen in the log. */
  sessions: number
  firstTs?: number
  lastTs?: number
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

/**
 * One slash command contributed by an enabled plugin (`commands/*.md`).
 * Completion source for the composer @/slash popup — static registry data,
 * no worker round-trip.
 */
export interface SlashCommandSummary {
  name: string
  description?: string
  pluginId: PluginId
}

// ─── User-level MCP servers (v1.8) ───────────────────────────────────────────

export type UserMcpTransport = 'stdio' | 'http' | 'sse'

/** User enable/disable flips for plugin-declared MCP servers, keyed by bridge key. */
export type PluginMcpServerOverrides = Record<string, { enabled: boolean }>

/**
 * One entry of the user-level `~/.flexagent/mcp.json` (`mcpServers` map).
 * Same shape family as plugin MCP configs, but standalone — no plugin,
 * no userConfig interpolation.
 */
export interface UserMcpServerConfig {
  type: UserMcpTransport
  /** Disabled servers stay in the file but are not bridged. Default: true. */
  enabled?: boolean
  /** 'proxy' (default): exposed through the single `mcp` tool. 'direct': one tool per MCP tool. */
  expose?: 'proxy' | 'direct'
  /** Tools/call timeout in milliseconds (connect timeout is min(10s, this)). */
  timeoutMs?: number
  /** stdio: spawn command. */
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /** http: streamable endpoint. */
  url?: string
  headers?: Record<string, string>
  /**
   * stdio: hand the whole parent environment to the server instead of the
   * allowlist (PATH / HOME / APPDATA / proxies…). Off by default — MCP servers
   * are not sandboxed, so this is how far the blast radius reaches.
   */
  envInherit?: boolean
}

export interface UserMcpServerSummary {
  name: string
  config: UserMcpServerConfig
}

/** Validated write input — the renderer sends the full config for one server. */
export interface UserMcpSaveInput {
  name: string
  config: UserMcpServerConfig
}

/** Live connectivity/tool-count of one bridged MCP server (worker-reported). */
export interface McpServerStatusEntry {
  /** `user:<name>` or `plugin:<manifestName>:<serverName>`; `warnings` for bridge-level notices. */
  key: string
  source: 'user' | 'plugin'
  type: UserMcpTransport
  connected: boolean
  /**
   * Finer than `connected`: a server can be dialling for several seconds
   * (measured 5.9–6.9 s for an npx-spawned one), and the UI has to be able to
   * say so instead of showing an empty panel.
   */
  status?: 'connecting' | 'connected' | 'error'
  toolCount?: number
  /** Present when the server failed to connect at bridge startup. */
  error?: string
  /** Non-fatal notices (tool-name collisions between servers, …). */
  warnings?: string[]
}

export interface McpServerStatusEvent {
  servers: McpServerStatusEntry[]
}

// ─── Marketplace (v1.5 / P3) ─────────────────────────────────────────────────

/** A marketplace registered in `known_marketplaces.json`. */
export interface MarketplaceInfo {
  /** Marketplace manifest name (stable id, e.g. `community`). */
  id: string
  name: string
  description?: string
  /** Human-readable canonical source (URL / `owner/repo` / local path). */
  source: string
  pluginCount: number
  addedAt: string
  lastUpdated?: string
}

/** One searchable plugin entry projected from a configured marketplace index. */
export interface MarketplaceSearchResult {
  marketplace: string
  name: string
  version?: string
  description?: string
  tags?: string[]
  installed: boolean
  installedVersion?: string
  /** Installed version is older than the entry version (semver-ish compare). */
  updateAvailable?: boolean
}

export interface MarketplaceSearchInput {
  /** Case-insensitive substring match on name/description/tags. Empty = list all. */
  query?: string
  /** Restrict to one configured marketplace id. */
  marketplace?: string
}

export interface AddMarketplaceInput {
  /** Raw source string: HTTPS URL, `owner/repo[#ref]`, git SSH URL, local file/directory path. */
  source: string
}

/**
 * Where to install a plugin from, outside the configured-index flow.
 * - `path`  — local directory or `.zip` file.
 * - `url`   — remote source string (same grammar as AddMarketplaceInput.source):
 *             GitHub repo URL / zip URL / git URL.
 * - `entry` — a plugin entry inside an already-configured marketplace index.
 */
export type MarketplaceInstallSource =
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'entry'; marketplace: string; name: string }

export interface InstallFromMarketplaceInput {
  source: MarketplaceInstallSource
  /** Replace an already-installed plugin (atomic backup/rollback). Default: reject with PLUGIN_ALREADY_INSTALLED. */
  overwrite?: boolean
}

export type MarketplaceProgressPhase =
  | 'resolve'
  | 'download'
  | 'extract'
  | 'install'
  | 'done'
  | 'error'

export interface MarketplaceProgressEvent {
  phase: MarketplaceProgressPhase
  /** Redacted source display string, when known. */
  source?: string
  pluginId?: PluginId
  message?: string
}

/**
 * Marketplace surface. Exposed by the preload bridge as
 * `window.electron.marketplace` — separate from CodexApi so the P1 mock
 * (which implements CodexApi only) keeps typechecking until the frontend
 * track opts in.
 */
export interface MarketplaceApi {
  listMarketplaces(): Promise<MarketplaceInfo[]>
  addMarketplace(input: AddMarketplaceInput): Promise<MarketplaceInfo>
  searchMarketplaces(input: MarketplaceSearchInput): Promise<MarketplaceSearchResult[]>
  installFromMarketplace(input: InstallFromMarketplaceInput): Promise<PluginSummary>
  /** Subscribe to install/refresh progress (global channel, mirror of subscribePlugins). */
  subscribeMarketplaceProgress(listener: (event: MarketplaceProgressEvent) => void): () => void
}

// ─── Frameless window chrome (custom titlebar) ──────────────────────────────

/** Every `web:edit:<kind>` channel, keyed by the operation it runs. */
export const WEB_EDIT_KINDS = ['undo', 'cut', 'copy', 'paste', 'selectAll'] as const

export type WebEditKind = (typeof WEB_EDIT_KINDS)[number]

/**
 * Renderer surface for the frameless window strip (TitleBar), exposed by the
 * preload bridge as `window.electron.windowControls`. Without a main-process
 * bridge (browser mock) the surface is absent and the chrome renders inert.
 */
export interface WindowControlsApi {
  minimize(): Promise<void>
  /** Maximize/restore; resolves with the resulting maximized state. */
  maximizeToggle(): Promise<boolean>
  close(): Promise<void>
  quit(): Promise<void>
  reload(): Promise<void>
  zoomIn(): Promise<void>
  zoomOut(): Promise<void>
  zoomReset(): Promise<void>
  edit(kind: WebEditKind): Promise<void>
  about(): Promise<void>
  /** main → renderer push for the maximized flag (glyph □/❐). Returns unsubscribe. */
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}

// ─── Skills / Memory / History (v1.7, additive) ─────────────────────────────

/** Where a skill comes from. Project-local skills are session-scoped and not listed globally. */
export type SkillSourceKind = 'user' | 'plugin'

export interface SkillSummary {
  name: string
  description?: string
  source: SkillSourceKind
  /** `user`: absolute skill dir; `plugin`: path relative to the plugin root. */
  path: string
  pluginId?: PluginId
  /** Where this skill came from — absent for skills the agent wrote itself. */
  provenance?: SkillProvenance
}

/** How a user-level skill got into `~/.flexagent/skills`. */
export type SkillProvenanceKind = 'hub' | 'source' | 'folder' | 'agent'

/**
 * When a skill was last written (v1.12, additive).
 *
 * A skill nobody has touched since the day it arrived is worth asking about, and
 * most of the time that means nobody runs it. Nothing here can measure reads —
 * the kernel loads skills without reporting which were used — so this is the
 * write side of the same question, which the undo log and the file mtimes do
 * answer. The UI offers; it does not delete.
 */
export interface SkillUsageEntry {
  name: string
  /** Epoch ms of the last recorded write. */
  touchedAt: number
  /** Epoch ms of the earliest recorded write; absent when only mtimes are known. */
  createdAt?: number
  /** `history`: the undo log has an entry. `filesystem`: mtime only, no history. */
  source: SkillUsageSource
}

export type SkillUsageSource = 'history' | 'filesystem'

/**
 * How long a skill may go without a write before the UI offers it for cleanup
 * (v1.12). Shared so the hint and the main-side helper cannot drift apart.
 */
export const SKILL_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Install-side audit record, written as `.flexagent-source.json` inside the
 * skill dir. Answers "who put this here, from which source, at which revision,
 * and has it been edited since?" — without a network call (GitHub's anonymous
 * quota is 60 req/h, so we cannot afford to re-ask later).
 */
export interface SkillProvenance {
  kind: SkillProvenanceKind
  /** Canonical resolvable source string (`github:owner/repo[@ref][/path]` or https .zip). */
  source?: string
  hub?: string
  /** Entry name inside the hub, if installed from one. */
  hubEntry?: string
  /** Absolute folder this was loaded from (`kind: 'folder'`). */
  folderPath?: string
  /** Git ref the source pinned, absent when tracking the default branch. */
  ref?: string
  /** Ref the downloader actually resolved to (e.g. `refs/heads/main`). */
  resolvedRef?: string
  /** sha256 over the installed tree; changes on edit and on upstream drift. */
  contentHash?: string
  installedAt: number
  updatedAt?: number
}

export interface SkillPendingWrite {
  id: string
  /** Skill the write targets (as declared by the op, may not exist yet for create). */
  skillName: string
  /** One human-readable line per op in the batch. */
  summary: string[]
  /** Absolute path(s) the approved write would touch. */
  targetPaths: string[]
  createdAt: number
}

/**
 * A recorded skill mutation (v1.11, additive) — what an "undo" entry is made of.
 * The user, not the agent, is who reverts: a bad evolution that can be rolled
 * back is the reason a user is willing to approve the next one.
 */
export interface SkillUndoEntry {
  id: string
  /** Epoch ms. */
  at: number
  /** One line per op in the batch. */
  summary: string[]
  /** How many files this entry can restore. */
  fileCount: number
}

export type MemoryCardFile = 'MEMORY' | 'USER'

export interface MemoryCard {
  file: MemoryCardFile
  /** 0-based index within the card list of that file; stable for remove(). */
  index: number
  /**
   * Content-derived identity (v1.10, additive). Indexes shift when a card above
   * is removed — across turns that makes "delete what I listed earlier" hit the
   * wrong line. The id survives removals and is what remove() prefers.
   */
  id: string
  text: string
  /**
   * Sidecar timestamps (v1.12, additive). Absent when the card predates the sidecar
   * or the file was broken: the markdown line stays the source of truth for the
   * text, and losing the date loses nothing but the ability to sort by it.
   */
  createdAt?: number
  updatedAt?: number
  /**
   * Working directory this card belongs to (v1.12, additive). Absent means the
   * card applies everywhere; a card is only injected into sessions whose cwd
   * matches when it is set.
   */
  scope?: string
}

/**
 * Acknowledgement for a memory write (v1.10, additive).
 *
 * `warnings` carries advisory lint output the writer should see — the write
 * happened, but something about the card is probably wrong (transient state,
 * describing the agent rather than the user). Rejections surface as errors;
 * warnings are the band where the caller may know better than the linter.
 */
/**
 * Settings for the automatic memory pass (issue 15).
 *
 * Off by default, matching ZCode: the pass costs an extra model call per turn,
 * so it is opt-in rather than a surprise on the user's bill. Flipping it only
 * affects sessions created afterwards — a run already in flight keeps the
 * setting it was created with, because re-deciding mid-run would make the same
 * conversation behave differently halfway through.
 */
export interface MemorySettings {
  autoExtract: boolean
}

export interface SetMemoryAutoExtractInput {
  autoExtract: boolean
}

export interface QuestionSettings {
  /**
   * When the agent asks a question and the user has not answered, continue
   * without an answer once the countdown expires (issue 10).
   */
  autoContinue: boolean
  /** Countdown length in ms for newly created questions. */
  timeoutMs: number
}

export interface SetQuestionAutoContinueInput {
  autoContinue: boolean
}

export interface MemoryWriteReceipt {
  id: string
  warnings: string[]
}

/**
 * What remove() accepts (v1.10, additive): `number` keeps working as the old
 * positional index, `string` targets a card by id. Prefer the id — see above.
 */
export type MemoryCardRef = number | string

export interface SessionSearchHit {
  sessionId: SessionId
  title: string
  /** Match context excerpt (~200 chars). */
  snippet: string
  updatedAt: number
}

/** Ticket 27: what the Composer `@` popup asks for. */
export interface WorkspaceFileQuery {
  sessionId: SessionId
  /** Empty or omitted returns the first few paths, ranked by nothing but order. */
  query?: string
}

// ─── Skill Hub (v1.8, additive) ──────────────────────────────────────────────

/** A browsable skill catalog: the built-in one plus user-registered ones. */
export interface SkillHubInfo {
  id: string
  name: string
  /**
   * Index source. Two shapes:
   * - `github:owner/repo[@ref][/subpath]` — every dir with a SKILL.md is listed.
   * - an https URL ending in `.json` — `{ skills: [{ name, description?, source }] }`.
   */
  url: string
  /** The built-in hub cannot be removed. */
  builtIn: boolean
  /** Entries found by the last browse (0 until browsed this session). */
  skillCount: number
}

/** One installable skill entry inside a hub. */
export interface SkillHubEntry {
  hub: string
  name: string
  /** Repo-relative path when it differs from the frontmatter name (display hint). */
  label?: string
  description?: string
  /** Installable source: `github:owner/repo[@ref][/path]` or an https .zip URL. */
  source: string
  installed: boolean
}

export interface AddSkillHubInput {
  /** Hub id; must be unique among user hubs (`[a-z0-9][a-z0-9._-]*`). */
  name: string
  url: string
}

/** Where an installSkill call pulls from. */
export type InstallSkillSource =
  | { kind: 'hub'; hub: string; name: string }
  | { kind: 'folder'; folderPath: string }
  | { kind: 'source'; source: string }

export interface InstallSkillInput {
  source: InstallSkillSource
  /** Replace an existing user skill of the same name (staged swap). */
  overwrite?: boolean
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
      /**
       * Wall-clock execution time of the tool itself (observability §3.2).
       * Deliberately excludes permission wait — approval latency is the user's
       * time, not the system's, and mixing them poisons performance analysis.
       */
      execMs?: number
      /** Time the kernel spent waiting on the user's permission decision, if any. */
      waitMs?: number
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
      /** Trust level in force when the gate ran — shown on the dialog. */
      mode: PermissionMode
      /**
       * Verdict the chain reached before it decided a human was needed. Lets the
       * dialog explain *why* (e.g. "heuristic: write outside workspace") instead
       * of a generic "approval required".
       */
      verdict?: PermissionVerdict
    })
  /**
   * Aggregated file changes visible to the user for this run so far
   * (kernel derives from edit/patch tool results — PI has no native file_changes event).
   * Full replacement snapshot, not a delta.
   */
  | (EventMeta & { type: 'file_changes'; files: FileChange[] })
  /**
   * The agent is asking the user a question and is blocked on the answer
   * (issue 10). Distinct from `permission_request`: this one has a countdown and
   * can resolve itself, and it asks about intent rather than about permission.
   */
  | (EventMeta & {
      type: 'question_request'
      questionId: string
      /** The question, verbatim from the tool call. */
      prompt: string
      options: QuestionOption[]
      /**
       * Countdown length for *this* question, captured when it was created —
       * changing the setting later must not retime a question already on screen.
       * 0 means no countdown: it waits until answered.
       */
      timeoutMs: number
      autoContinue: boolean
    })
  /**
   * The question is settled: answered, timed out, or discarded (session
   * disposed). The UI shows the outcome in the transcript when nobody answered.
   */
  | (EventMeta & {
      type: 'question_resolved'
      questionId: string
      outcome: 'answered' | 'timeout' | 'cancelled'
      answer?: string
    })
  /** Async failure during a run. Run may still settle afterward. */
  | (EventMeta & {
      type: 'error'
      code: ContractErrorCode
      message: string
      toolCallId?: ToolCallId
    })
  /**
   * The model call failed and the kernel is retrying on its own (PI
   * `auto_retry_start`). The run is NOT over — this is progress, not an error.
   */
  | (EventMeta & {
      type: 'model_retry'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage?: string
    })
  /** The retry cycle above ended: either recovered or gave up (then `error` follows). */
  | (EventMeta & { type: 'model_retry_end'; success: boolean })
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
   * Absolute path of the scratch workspace used when `createSession` omits cwd.
   * The renderer compares it against `SessionSummary.cwd` to decide whether a
   * chat has a project yet, so it must stay stable for the install.
   */
  scratchCwd(): Promise<string>
  /**
   * Point a session at a project folder (idle sessions only — throws
   * SESSION_BUSY while a run is in flight, because tools resolve relative paths
   * against the workspace). The transcript is preserved.
   */
  setSessionCwd(input: SetSessionCwdInput): Promise<SessionSummary>
  /** Persist a user-set title. Throws INVALID_INPUT on a blank title. */
  renameSession(input: RenameSessionInput): Promise<SessionSummary>
  /** Archive or restore a session. Both are persisted, neither deletes. */
  setSessionArchived(input: SetSessionArchivedInput): Promise<SessionSummary>

  /**
   * Submit user text. Resolves when accepted (not when the run finishes).
   * Events arrive via `subscribe`.
   */
  prompt(input: PromptInput): Promise<PromptAck>

  /** Abort the in-flight run for the session (PI: abort()). Idle sessions: no-op. */
  abort(sessionId: SessionId): Promise<void>

  /** Answer a pending `permission_request`. */
  /** Answer a pending `question_request`. Never blocked by a countdown. */
  respondQuestion(input: RespondQuestionInput): Promise<void>
  /** Stop one question's countdown for good (any interaction counts). */
  stopQuestionTimer(input: StopQuestionTimerInput): Promise<void>
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

  /** Trust level in force for one session (falls back to the global default). */
  getPermissionMode(sessionId: SessionId): Promise<PermissionMode>
  /** Override the trust level for one session. Persists to the kernel for restarts. */
  setPermissionMode(input: SetPermissionModeInput): Promise<PermissionMode>
  /** Ordered rule set actually in force (heuristics + user rules), for display. */
  listPermissionRules(): Promise<PermissionRuleSet>
  /**
   * Persist one rule derived from a call the user just answered (v1.19). The
   * rule takes effect on the next evaluation — the gate re-reads the file per
   * call, so nothing has to be pushed to the running session.
   */
  savePermissionRule(input: SavePermissionRuleInput): Promise<PermissionRuleSet>
  /** Drop one previously saved rule. Built-ins have no id to remove. */
  removePermissionRule(input: RemovePermissionRuleInput): Promise<PermissionRuleSet>

  /** Custom subagents (ticket 16): full registry view incl. disabled + diagnostics. */
  listCustomAgents(): Promise<CustomAgentsSnapshot>
  /** Create or update one definition file. Rejects with the validation error. */
  saveCustomAgent(input: CustomAgentDefinitionInput): Promise<CustomAgentsSnapshot>
  /** Delete one definition file. Built-ins are rejected in main. */
  deleteCustomAgent(input: { name: string }): Promise<CustomAgentsSnapshot>
  /** Toggle one definition's enabled flag. Built-ins are rejected in main. */
  setCustomAgentEnabled(input: { name: string; enabled: boolean }): Promise<CustomAgentsSnapshot>

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

  // ── Custom models (v1.9) ──
  /** `providers[].models[]` of the kernel's `models.json`. Never returns keys. */
  listCustomModels(): Promise<CustomModelEntry[]>
  /** Absolute path of models.json, for the Settings copy. */
  customModelsPath(): Promise<string>
  /** Create/update one entry (validated, atomic write, in-place kernel reload). */
  saveCustomModel(input: CustomModelSaveInput): Promise<CustomModelWriteResult>
  /** Remove one entry (and its provider when that was its last model). */
  removeCustomModel(input: CustomModelRef): Promise<CustomModelWriteResult>

  // ── Model routing (v2.0) ──
  /** Which model each purpose resolves to, plus the catalogue's facts for them. */
  listModelRoles(): Promise<RoutingState>
  /** Bind a role to a model (or `null` to inherit `chat`). Resolves again after the write. */
  setModelRole(input: SetModelRoleInput): Promise<RoutingState>
  /** How model requests leave the machine. */
  getNetworkSettings(): Promise<NetworkSettings>
  /** Change it; applied to the running kernel where the kernel allows it. */
  setNetworkSettings(input: SetNetworkInput): Promise<NetworkSettings>
  /** Where one session's tokens went, split by purpose and by model. */
  sessionUsage(sessionId: SessionId): Promise<UsageReport>
  /** Automatic memory pass settings (off by default). */
  getMemorySettings(): Promise<MemorySettings>
  setMemoryAutoExtract(input: SetMemoryAutoExtractInput): Promise<MemorySettings>
  /** App-wide usage, aggregated offline from the observability log (issue 09). */
  getUsageStats(): Promise<GlobalUsageStats>
  /** Question countdown settings (issue 10). */
  getQuestionSettings(): Promise<QuestionSettings>
  setQuestionAutoContinue(input: SetQuestionAutoContinueInput): Promise<QuestionSettings>

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
  /**
   * Slash commands from enabled plugins (composer completion source).
   * Optional so renderer mocks that predate it keep typechecking;
   * the real preload bridge always provides it.
   */
  listSlashCommands?(): Promise<SlashCommandSummary[]>

  // ── User-level MCP servers (v1.8) ──
  /** Entries of `~/.flexagent/mcp.json`. Not session-scoped. */
  listUserMcpServers(): Promise<UserMcpServerSummary[]>
  /** Create/update one server entry (validated; atomic write; kernel reload). Returns the updated list. */
  saveUserMcpServer(input: UserMcpSaveInput): Promise<UserMcpServerSummary[]>
  /** Remove one server entry. Returns the updated list. */
  removeUserMcpServer(name: string): Promise<UserMcpServerSummary[]>
  /** Enable/disable without deleting. Returns the updated list. */
  toggleUserMcpServer(name: string, enabled: boolean): Promise<UserMcpServerSummary[]>
  /** Last known bridge status (tool counts / errors). Empty until the worker first attached. */
  listMcpServerStatus(): Promise<McpServerStatusEntry[]>
  /** User enable/disable flips for plugin-declared MCP servers (issue 23). */
  listPluginMcpServerOverrides(): Promise<PluginMcpServerOverrides>
  /** Flip one plugin MCP server; reloads the bridge. Returns the updated overrides. */
  setPluginMcpServerEnabled(input: { key: string; enabled: boolean }): Promise<PluginMcpServerOverrides>
  /**
   * Subscribe to MCP bridge status updates (global, outside `KernelEvent`/`seq`).
   * Returns unsubscribe.
   */
  subscribeMcpStatus(listener: (event: McpServerStatusEvent) => void): () => void

  // ── Skills / Memory / History (v1.7) ──
  /** User-level (`~/.flexagent/skills`) + enabled-plugin skills. */
  listSkills(): Promise<SkillSummary[]>
  /** Skill writes staged by the agent awaiting approval (skills.writeApproval). */
  listPendingSkillWrites(): Promise<SkillPendingWrite[]>
  /** Apply a staged write and refresh kernel skill discovery. */
  approveSkillWrite(id: string): Promise<void>
  /** Discard a staged write. */
  rejectSkillWrite(id: string): Promise<void>
  /** Reversible skill mutations, newest first (persisted across restarts). */
  listSkillUndo(): Promise<SkillUndoEntry[]>
  /** Restore the files a recorded skill mutation replaced. */
  revertSkillWrite(id: string): Promise<void>
  /** Curated memory cards across sessions (`~/.flexagent/memory/`). */
  listMemoryCards(): Promise<MemoryCard[]>
/** Returns the id so callers can remove precisely later; see v1.10 note above. */
  /**
   * Add a card (v1.12: optional `scope`). `scope` restricts injection to sessions
   * working in that directory; omitting it means the card applies everywhere.
   */
  addMemoryCard(file: MemoryCardFile, text: string, scope?: string): Promise<MemoryWriteReceipt>
  removeMemoryCard(file: MemoryCardFile, ref: MemoryCardRef): Promise<void>
  /** When each skill was last written — the input to pruning. */
  listSkillUsage(): Promise<SkillUsageEntry[]>
  /** Substring search across stored session transcripts (titles + messages). */
  searchSessions(query: string): Promise<SessionSearchHit[]>
  /**
   * Ticket 27: files in the session's working directory matching `query`.
   *
   * Bounded and cached on the worker — this is called while the user types, so
   * it returns at most a popup's worth of paths and never the whole tree.
   */
  listWorkspaceFiles(input: WorkspaceFileQuery): Promise<string[]>

  // ── Skill Hub (v1.8) ──
  /** Built-in hub + user-registered hubs (~/.flexagent/skillhubs.json). */
  listSkillHubs(): Promise<SkillHubInfo[]>
  addSkillHub(input: AddSkillHubInput): Promise<SkillHubInfo>
  removeSkillHub(id: string): Promise<void>
  /** Browse a hub's installable skills (cached ~10 min per hub). Omit for all hubs. */
  browseSkillHub(id?: string): Promise<SkillHubEntry[]>
  /** Install into `~/.flexagent/skills` from a hub entry, direct source, or local folder. */
  installSkill(input: InstallSkillInput): Promise<SkillSummary>
  /** Remove a user-level skill (never plugin skills). */
  uninstallSkill(name: string): Promise<void>
  /** Re-install a skill from its recorded source (`.flexagent-source.json`). */
  reinstallSkill(name: string): Promise<SkillSummary>
}

// ─── Electron IPC channel names (real transport only) ────────────────────────

/** Channels are additive — never rename existing keys. */
export const IPC = {
  listSessions: 'codex:listSessions',
  createSession: 'codex:createSession',
  openSession: 'codex:openSession',
  deleteSession: 'codex:deleteSession',
  scratchCwd: 'codex:scratchCwd',
  setSessionCwd: 'codex:setSessionCwd',
  renameSession: 'codex:renameSession',
  setSessionArchived: 'codex:setSessionArchived',
  prompt: 'codex:prompt',
  abort: 'codex:abort',
  respondPermission: 'codex:respondPermission',
  respondQuestion: 'codex:respondQuestion',
  stopQuestionTimer: 'codex:stopQuestionTimer',
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
  setPermissionMode: 'codex:setPermissionMode',
  getPermissionMode: 'codex:getPermissionMode',
  listPermissionRules: 'codex:listPermissionRules',
  savePermissionRule: 'codex:savePermissionRule',
  removePermissionRule: 'codex:removePermissionRule',
  listCustomAgents: 'codex:listCustomAgents',
  saveCustomAgent: 'codex:saveCustomAgent',
  deleteCustomAgent: 'codex:deleteCustomAgent',
  setCustomAgentEnabled: 'codex:setCustomAgentEnabled',
  listCustomModels: 'codex:listCustomModels',
  customModelsPath: 'codex:customModelsPath',
  saveCustomModel: 'codex:saveCustomModel',
  removeCustomModel: 'codex:removeCustomModel',
  listModelRoles: 'codex:listModelRoles',
  setModelRole: 'codex:setModelRole',
  getNetworkSettings: 'codex:getNetworkSettings',
  setNetworkSettings: 'codex:setNetworkSettings',
  sessionUsage: 'codex:sessionUsage',
  getMemorySettings: 'codex:getMemorySettings',
  setMemoryAutoExtract: 'codex:setMemoryAutoExtract',
  getUsageStats: 'codex:getUsageStats',
  getQuestionSettings: 'codex:getQuestionSettings',
  setQuestionAutoContinue: 'codex:setQuestionAutoContinue',
  listSkillHubs: 'codex:listSkillHubs',
  addSkillHub: 'codex:addSkillHub',
  removeSkillHub: 'codex:removeSkillHub',
  browseSkillHub: 'codex:browseSkillHub',
  installSkill: 'codex:installSkill',
  uninstallSkill: 'codex:uninstallSkill',
  reinstallSkill: 'codex:reinstallSkill',
  listPlugins: 'codex:listPlugins',
  getPlugin: 'codex:getPlugin',
  setPluginEnabled: 'codex:setPluginEnabled',
  installPlugin: 'codex:installPlugin',
  uninstallPlugin: 'codex:uninstallPlugin',
  listSlashCommands: 'codex:listSlashCommands',
  /** main → renderer push for PluginChangeEvent (global, per webContents). */
  pluginsChanged: 'codex:pluginsChanged',
  /** main → renderer push for KernelEvent (per webContents). */
  kernelEvent: 'codex:kernelEvent',
  listMarketplaces: 'codex:listMarketplaces',
  addMarketplace: 'codex:addMarketplace',
  searchMarketplaces: 'codex:searchMarketplaces',
  installFromMarketplace: 'codex:installFromMarketplace',
  /** main → renderer push for MarketplaceProgressEvent (global, per webContents). */
  marketplaceProgress: 'codex:marketplaceProgress',
  listSkills: 'codex:listSkills',
  listPendingSkillWrites: 'codex:listPendingSkillWrites',
  approveSkillWrite: 'codex:approveSkillWrite',
  rejectSkillWrite: 'codex:rejectSkillWrite',
  listSkillUndo: 'codex:listSkillUndo',
  revertSkillWrite: 'codex:revertSkillWrite',
  listMemoryCards: 'codex:listMemoryCards',
  addMemoryCard: 'codex:addMemoryCard',
  removeMemoryCard: 'codex:removeMemoryCard',
  listSkillUsage: 'codex:listSkillUsage',
  searchSessions: 'codex:searchSessions',
  listWorkspaceFiles: 'codex:listWorkspaceFiles',
  listUserMcpServers: 'codex:listUserMcpServers',
  saveUserMcpServer: 'codex:saveUserMcpServer',
  removeUserMcpServer: 'codex:removeUserMcpServer',
  toggleUserMcpServer: 'codex:toggleUserMcpServer',
  listMcpServerStatus: 'codex:listMcpServerStatus',
  /** Plugin MCP server enable/disable overrides (issue 23). */
  listPluginMcpServerOverrides: 'codex:listPluginMcpServerOverrides',
  setPluginMcpServerEnabled: 'codex:setPluginMcpServerEnabled',
  /** main → renderer push for McpServerStatusEvent (global, per webContents). */
  mcpStatusChanged: 'codex:mcpStatusChanged',
  /** Frameless window chrome (TitleBar). */
  windowMinimize: 'window:minimize',
  windowMaximizeToggle: 'window:maximizeToggle',
  windowClose: 'window:close',
  windowQuit: 'window:quit',
  /** main → renderer push for the maximized flag (global, per webContents). */
  windowMaximized: 'window:maximized',
  webReload: 'web:reload',
  webZoomIn: 'web:zoomIn',
  webZoomOut: 'web:zoomOut',
  webZoomReset: 'web:zoomReset',
  webEditUndo: 'web:edit:undo',
  webEditCut: 'web:edit:cut',
  webEditCopy: 'web:edit:copy',
  webEditPaste: 'web:edit:paste',
  webEditSelectAll: 'web:edit:selectAll',
  appAbout: 'app:about'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** `web:edit:<kind>` channel for one {@link WebEditKind}. */
export const WEB_EDIT_CHANNELS: Readonly<Record<WebEditKind, string>> = {
  undo: IPC.webEditUndo,
  cut: IPC.webEditCut,
  copy: IPC.webEditCopy,
  paste: IPC.webEditPaste,
  selectAll: IPC.webEditSelectAll
}
