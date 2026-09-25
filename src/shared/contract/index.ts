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
  'KERNEL_INTERNAL'
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

export type UserMcpTransport = 'stdio' | 'http'

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
  /** `user:<name>` or `plugin:<manifestName>:<serverName>`. */
  key: string
  source: 'user' | 'plugin'
  type: UserMcpTransport
  connected: boolean
  toolCount?: number
  /** Present when the server failed to connect at bridge startup. */
  error?: string
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
  listCustomModels: 'codex:listCustomModels',
  customModelsPath: 'codex:customModelsPath',
  saveCustomModel: 'codex:saveCustomModel',
  removeCustomModel: 'codex:removeCustomModel',
  listModelRoles: 'codex:listModelRoles',
  setModelRole: 'codex:setModelRole',
  getNetworkSettings: 'codex:getNetworkSettings',
  setNetworkSettings: 'codex:setNetworkSettings',
  sessionUsage: 'codex:sessionUsage',
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
  listUserMcpServers: 'codex:listUserMcpServers',
  saveUserMcpServer: 'codex:saveUserMcpServer',
  removeUserMcpServer: 'codex:removeUserMcpServer',
  toggleUserMcpServer: 'codex:toggleUserMcpServer',
  listMcpServerStatus: 'codex:listMcpServerStatus',
  /** main → renderer push for McpServerStatusEvent (global, per webContents). */
  mcpStatusChanged: 'codex:mcpStatusChanged'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
