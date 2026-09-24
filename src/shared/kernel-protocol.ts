import type {
  ContractErrorCode,
  KernelEvent,
  PromptDisposition,
  SessionId,
  SessionSearchHit,
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

/**
 * Resolved MCP server from a plugin's `.mcp.json` / `manifest.mcpServers`.
 * stdio servers are spawned by the worker; http servers connect via
 * StreamableHTTP. Tool exposure defaults to the single `mcp` proxy tool;
 * `expose: 'direct'` keeps legacy per-tool registration.
 */
export interface PluginMcpServerConfigBase {
  /** How the server's tools are exposed to the model. Default: 'proxy'. */
  expose?: 'proxy' | 'direct'
  /** Tools/call + connect timeout in milliseconds (connect is min(10s, this)). */
  timeoutMs?: number
}

export interface PluginMcpStdioConfig extends PluginMcpServerConfigBase {
  type: 'stdio'
  /** Spawn command (${user_config.*} + ${CLAUDE_/ZCODE_/FLEX_...} templates resolved; sensitive values blocked). */
  command: string
  args?: string[]
  /** Base plugin env overlay (hook convention) + server.env + authoritative FLEX_PLUGIN_ID. */
  env: Record<string, string>
  /** Spawn cwd (server-declared, resolved). Defaults to the plugin root. */
  cwd?: string
}

export interface PluginMcpHttpConfig extends PluginMcpServerConfigBase {
  type: 'http'
  /** Streamable HTTP endpoint URL (${user_config.*} templates resolved). */
  url: string
  /** Request headers (${user_config.*} templates resolved; sensitive values allowed, e.g. Bearer tokens). */
  headers?: Record<string, string>
  /** Base plugin env overlay (hook convention) + server.env + authoritative FLEX_PLUGIN_ID (available to header templates). */
  env: Record<string, string>
}

export type PluginMcpServerConfig = PluginMcpStdioConfig | PluginMcpHttpConfig

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
  /** Absolute MCP config paths of enabled plugins (informational; resolved servers live in `mcpServers`). */
  mcp: string[]
  /** Resolved stdio MCP servers keyed `plugin:<manifestName>:<serverName>` (P2.5 — worker spawns + registers tools). */
  mcpServers?: Record<string, PluginMcpServerConfig>
  /** Per-server context keyed by the namespaced server name (same shape as `hookContexts`). */
  mcpContexts?: Record<string, PluginHookContext>
  /** Plugin storage root (worker cwd varies per session). */
  pluginStorageRoot: string
}

export type WorkerRequest =
  | { requestId: string; type: 'listSessions' }
  | { requestId: string; type: 'createSession'; sessionId: SessionId; cwd: string; title?: string }
  | { requestId: string; type: 'openSession'; sessionId: SessionId; cwd: string; piSessionFile?: string }
  | { requestId: string; type: 'setSessionCwd'; sessionId: SessionId; cwd: string }
  | {
      requestId: string
      type: 'prompt'
      sessionId: SessionId
      text: string
      disposition: PromptDisposition
      /**
       * Short-term memory for this turn (v1.10, additive): hits from *other*
       * sessions, computed in main because that is where the registry lives.
       * The worker cannot reach it, and `before_agent_start` carries only the
       * prompt text — so this ships alongside rather than being fetched.
       */
      recall?: SessionSearchHit[]
    }
  | { requestId: string; type: 'abort'; sessionId: SessionId }
  | { requestId: string; type: 'respondPermission'; sessionId: SessionId; toolCallId: ToolCallId; decision: 'allowOnce' | 'allowSession' | 'deny' }
  | { requestId: string; type: 'disposeSession'; sessionId: SessionId }
  | { requestId: string; type: 'listModels' }
  | { requestId: string; type: 'warmup'; cwd?: string }
  | { requestId: string; type: 'getModelConfig'; sessionId: SessionId }
  | { requestId: string; type: 'setModel'; sessionId: SessionId; provider: string; id: string; thinkingLevel?: ThinkingLevel }
  | { requestId: string; type: 'setThinkingLevel'; sessionId: SessionId; level: ThinkingLevel }
  | { requestId: string; type: 'reloadPlugins'; resourceSpec: PluginResourceSpec }
  /** Drop cached resource loaders so re-attach picks up new user-level skills (v1.7). */
  | { requestId: string; type: 'reloadResources' }
  /**
   * The models file changed on disk (Settings › Models). `providers` limits the
   * recompose to what actually changed; `verify` asserts the write landed in the
   * kernel's model list instead of assuming it did.
   */
  | {
      requestId: string
      type: 'reloadModels'
      providers: string[]
      verify: { provider: string; id: string; present: boolean }
    }
  /**
   * Where the kernel reads custom models from. The path is PI's own
   * (`getAgentDir()/models.json`, i.e. `~/.pi/agent/models.json` by default and
   * `$PI_CODING_AGENT_DIR/models.json` when that is set) — never re-derived in
   * main, which is how a settings panel ends up editing a file nobody reads.
   */
  | { requestId: string; type: 'modelsPath' }
  /** PI's own `settings.json` — `httpProxy` / `httpIdleTimeoutMs` / `retry` live there. */
  | { requestId: string; type: 'settingsPath' }
  /**
   * Resolve every routing role against the live ModelRuntime, plus the facts the
   * catalogue knows about each available model. Re-read from disk each time, so a
   * cleared binding cannot linger.
   */
  | { requestId: string; type: 'resolveModelRoles' }
  /** Whether this process installed the kernel's HTTP dispatcher, and what env says. */
  | { requestId: string; type: 'networkStatus' }
  /** Make the stored network settings true in this process, and report the outcome. */
  | { requestId: string; type: 'applyNetwork'; proxy: string; idleTimeoutMs: number }
  /** One session's tokens, attributed to the purpose that spent them. */
  | { requestId: string; type: 'sessionUsage'; sessionId: SessionId }
  | { requestId: string; type: 'shutdown' }

export type WorkerRequestInput = StripRequestId<WorkerRequest>

/**
 * What the worker can say about the machine's HTTP path. The renderer-facing
 * `NetworkSettings` inlines this, so the wire type lives next to the request
 * that produces it rather than being re-derived in main.
 */
export interface NetworkStatus {
  /** `installed` once the worker has the kernel's dispatcher in hand. */
  dispatcher: 'installed' | 'unavailable'
  /** `HTTP_PROXY`/`HTTPS_PROXY` as they were before this process set anything. */
  envProxy: string | null
  /** Why the dispatcher is missing, or what the kernel said when it refused. */
  note?: string
}

export type WorkerResponse =
  | { requestId: string; type: 'ok'; result?: unknown }
  | { requestId: string; type: 'fail'; code: ContractErrorCode; message: string; details?: unknown }
  | { type: 'event'; sessionId: SessionId; event: WorkerKernelEvent }

export type MainToWorker = WorkerRequest
export type WorkerToMain = WorkerResponse
