/**
 * Permission decision chain.
 *
 * Layers, evaluated in order, first meaningful hit wins:
 *
 *   0. credential paths — a write to a credential store is refused outright,
 *      before session memory and before user rules, because "the agent edited
 *      my private key" is not a thing a one-click allowance should have
 *      authorised earlier in the session. Reads of those paths are asked about,
 *      not refused: sharing a project `.env` deliberately is legitimate work.
 *   1. session memory  — a previous "allow session" for the *same tool with the
 *      *same parameters*. Name-only matching was the classic bug: allowing
 *      `bash` once silently authorised `rm -rf /`. See `PermissionMemory`.
 *   2. rules           — the ordered list in `permissionRules.ts` (built-ins
 *      first, then `~/.flexagent/permissions.json`). First hit wins.
 *   3. heuristics      — tool-shape analysis: read tools, workspace-contained
 *      writes, destructive command patterns. Zero latency, zero model calls.
 *   4. bash classifier — one lightweight model call for genuinely ambiguous
 *      commands, cached per command string. Never the first line of defence.
 *   5. mode rails      — `plan` hard-blocks anything non-read; `bypass` ends
 *      the chain in `allow` rather than interrupting the user.
 *
 * Cost asymmetry (the reason the chain is ordered this way): a false positive
 * costs one extra click, a false negative can cost irreversible data. So the
 * chain prefers `deny`/`ask` over `allow` whenever in doubt, and the classifier,
 * which is the least reliable layer, sits second-to-last.
 */
import { homedir } from 'os'
import { isAbsolute, resolve, sep } from 'path'
import type { PermissionMode, PermissionRule, PermissionVerdict } from '../shared/contract'
import { commandTouchesSensitivePath, firstSensitivePath, type SensitiveTarget } from './security/sensitivePaths'

/** Injected by the worker, which owns the ModelRuntime. Optional by design. */
export type BashClassifier = (command: string, cwd: string) => Promise<PermissionVerdict | undefined>

export type GateOutcome = 'allow' | 'deny' | 'ask'

export interface GateRequest {
  toolName: string
  args: Record<string, unknown>
}

export interface GateResult {
  outcome: GateOutcome
  verdict: PermissionVerdict
}

const FLEX_HOME = resolve(homedir(), '.flexagent')

/** Tools that never mutate anything — safe in every mode except `plan`. */
const READ_TOOLS = new Set([
  'read',
  'read_file',
  'readFile',
  'grep',
  'find',
  'glob',
  'ls',
  'list',
  'list_directory',
  'listDirectory',
  'search',
  'search_files',
  'searchFiles',
  'directory_tree',
  'directoryTree',
  'get_file_info',
  'stat',
  'head',
  'webfetch',
  'web_search',
  'websearch'
])

/** Tools that mutate the workspace. In `plan` mode these are blocked outright. */
const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'writeFile',
  'edit',
  'edit_file',
  'editFile',
  'create_file',
  'patch',
  'apply_patch',
  'applyPatch',
  'multi_edit',
  'move',
  'rename',
  'copy',
  'delete',
  'remove',
  'trash',
  'notebook_edit',
  'terminal',
  'bash',
  'shell'
])

const PATH_ARG_KEYS = [
  'path',
  'file',
  'file_path',
  'filePath',
  'absolute_path',
  'absolutePath',
  'target',
  'target_file',
  'old_path',
  'new_path',
  'dir',
  'directory',
  'cwd',
  'glob',
  'pattern',
  'root'
]

/**
 * Command prefixes that are unambiguously read-only or universally benign.
 * Kept deliberately short: anything not here falls through to the classifier
 * or a prompt, which is the correct default.
 */
const BASH_ALLOW_PREFIXES: readonly string[] = [
  'ls ',
  'cat ',
  'head ',
  'tail ',
  'pwd',
  'which ',
  'echo ',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git remote -v',
  'grep ',
  'rg ',
  'find ',
  'tree ',
  'node --version',
  'npm --version',
  'npm ls',
  'npm run typecheck',
  'npm run lint',
  'npm test',
  'pnpm run typecheck',
  'pnpm test',
  'yarn test'
]

/**
 * Patterns refused regardless of mode, even under `bypass`. These have no
 * reversible outcome, so no trust level may authorise them.
 */
const HARD_DENY: readonly [RegExp, string][] = [
  [/^rm\s+(-[a-z]*f[a-z]*r[a-z]*|-rf|--force)\b/, 'recursive force delete'],
  [/git\s+push\s+.*--force/, 'force push'],
  [/git\s+reset\s+--hard/, 'hard reset discards work'],
  [/git\s+clean\s+-[a-z]*f/, 'discards untracked work'],
  [/chmod\s+(-R\s+)?777/, 'world-writable permissions'],
  [/^\bsudo\b/, 'elevated execution'],
  [/\|?\s*(curl|wget)\b[^|]*\|\s*(ba)?sh\b/, 'piping a fetched payload into a shell'],
  [/^\b(rmdir|del)\s+/i, 'directory deletion'],
  [/>\s*\/dev\/(sda|nvme|disk)/, 'writing to a block device'],
  // `dd if=/dev/zero of=/dev/sda` is the same wipe as the redirect above but
  // arrives through `of=`, not `>`. Found by running the classifier against a
  // live model: it was the one case that reached layer 4 while being able to
  // erase a whole disk, and nothing local had an opinion on it.
  [/\bdd\b[^|]*\bof=\/dev\//, 'writing to a block device with dd']
]

const ALLOW = (reason: string): PermissionVerdict => ({ outcome: 'allow', via: 'heuristic', reason })
const DENY = (reason: string): PermissionVerdict => ({ outcome: 'deny', via: 'heuristic', reason })
const ASK = (reason: string): PermissionVerdict => ({ outcome: 'ask', via: 'heuristic', reason })

/**
 * Session memory that matches tool name **and** parameters.
 *
 * The name-only variant was a real hazard: "allow session" on `bash` then
 * authorised every future shell command, including destructive ones. Here the
 * key is a fingerprint of the normalised arguments, so `rm -rf /` never inherits
 * an allowance granted to `npm test`.
 */
export interface PermissionMemoryEntry {
  tool: string
  fingerprint: string
  createdAt: number
}

export class PermissionMemory {
  private entries = new Map<string, PermissionMemoryEntry>()

  constructor(sessionId: string) {
    this.keyPrefix = `s:${sessionId}`
  }

  private readonly keyPrefix: string

  private key(tool: string, fingerprint: string): string {
    return `${this.keyPrefix}|${tool}|${fingerprint}`
  }

  static fingerprintArgs(args: Record<string, unknown> | undefined): string {
    if (!args || Object.keys(args).length === 0) return '{}'
    const parts: string[] = []
    for (const [rawKey, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue
      parts.push(`${rawKey}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    }
    return parts.sort().join('&')
  }

  has(tool: string, fingerprint: string): boolean {
    return this.entries.has(this.key(tool, fingerprint))
  }

  record(tool: string, fingerprint: string): void {
    this.entries.set(this.key(tool, fingerprint), { tool, fingerprint, createdAt: Date.now() })
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Normalise whitespace so cache keys and classifier lookups agree. */
export function normalizeCommand(command: unknown): string {
  if (typeof command !== 'string') return ''
  return command.trim().replace(/\s+/g, ' ')
}

/**
 * The command string a tool call carries, for tools that have one at all.
 *
 * Anything else gets '', deliberately. This used to fall back to
 * `JSON.stringify(args)`, which fed the *serialised arguments* of ordinary tools
 * into the shell heuristics — so an MCP call whose payload happened to contain
 * `rm -rf` was judged as a destructive command, and a file path was parsed as
 * if it were a shell line. Paths have their own matcher (`ruleMatchesPath`).
 */
function argsForCommand(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  for (const key of ['command', 'cmd', 'script', 'code', 'input']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

const MCP_PROXY_TOOL = 'mcp'
const MCP_DIRECT_PREFIX = 'mcp__'
/** Proxy operations that only read the tool catalogue — no server is invoked. */
const MCP_DISCOVERY_MODES = new Set(['search', 'describe', 'status'])

function isMcpDiscovery(toolName: string, args: Record<string, unknown>): boolean {
  return toolName === MCP_PROXY_TOOL && MCP_DISCOVERY_MODES.has(typeof args.mode === 'string' ? args.mode : '')
}

/**
 * MCP is the one tool family where the gate knows nothing about what will
 * happen: the server is a third-party process with no sandbox and no auditable
 * capability declaration. So the default is the article's conservative one —
 * assume side effects, ask a human — with one carve-out: the proxy's own
 * discovery modes never touch a server, and blocking them would starve the
 * model of the only way it can learn what the server offers.
 */
function classifyMcpTool(toolName: string, args: Record<string, unknown>): PermissionVerdict | undefined {
  if (toolName === MCP_PROXY_TOOL) {
    const mode = typeof args.mode === 'string' ? args.mode : 'unknown'
    if (MCP_DISCOVERY_MODES.has(mode)) {
      return ALLOW(`MCP ${mode} only reads the tool catalogue`)
    }
    return ASK(
      `MCP call (${mode}) reaches a third-party server — trust it in ~/.flexagent/permissions.json to stop being asked`
    )
  }
  if (toolName.startsWith(MCP_DIRECT_PREFIX)) {
    const server = toolName.slice(MCP_DIRECT_PREFIX.length).split('__')[0]
    return ASK(
      `MCP tool from "${server}" — external server, not sandboxed; add a rule with tool "*${server}*" to allow it`
    )
  }
  return undefined
}

function extractPaths(args: Record<string, unknown> | undefined): string[] {
  if (!args) return []
  const out: string[] = []
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) out.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim()) out.push(item)
    }
  }
  return out
}

/**
 * MCP tool names are governed only by rules that name MCP explicitly.
 *
 * Without this, the generic `*read*` built-in quietly allowed every
 * `mcp__<server>__read_*` tool — and "read" here is a string in a name chosen
 * by a third party, not a capability we can verify. MCP has no sandbox and no
 * honest capability declaration, so a name must never be enough to auto-allow.
 */
function isMcpToolName(toolName: string): boolean {
  return toolName === MCP_PROXY_TOOL || toolName.startsWith(MCP_DIRECT_PREFIX)
}

function ruleMatchesTool(rule: PermissionRule, toolName: string): boolean {
  if (!rule.tool) return true
  if (rule.tool === '*') return true
  if (isMcpToolName(toolName) && !rule.tool.toLowerCase().includes('mcp')) return false
  if (rule.tool === toolName) return true
  const wildcard = rule.tool.startsWith('*') && rule.tool.endsWith('*')
  if (wildcard) return toolName.toLowerCase().includes(rule.tool.slice(1, -1).toLowerCase())
  return false
}

function ruleMatchesCommand(rule: PermissionRule, command: string): boolean {
  if (!rule.command) return true
  return command.toLowerCase().includes(rule.command.toLowerCase())
}

function ruleMatchesPath(rule: PermissionRule, paths: string[]): boolean {
  if (!rule.path) return true
  return paths.some((value) => value.replace(/\\/gu, '/').includes(rule.path!.replace(/\\/gu, '/')))
}

function withinWorkspace(target: string, cwd: string): boolean {
  try {
    const resolved = isAbsolute(target) ? resolve(target) : resolve(cwd, target)
    return resolved === cwd || resolved.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)
  } catch {
    return false
  }
}

/** True for writes aimed at FlexAgent's own state — "changing itself" is safe. */
function withinFlexHome(target: string): boolean {
  try {
    const resolved = isAbsolute(target) ? resolve(target) : FLEX_HOME
    return resolved === FLEX_HOME || resolved.startsWith(FLEX_HOME.endsWith(sep) ? FLEX_HOME : FLEX_HOME + sep)
  } catch {
    return false
  }
}

function classifyBashCommand(command: string): PermissionVerdict | undefined {
  const normalized = normalizeCommand(command)
  if (!normalized) return undefined
  const lowered = normalized.toLowerCase()

  for (const [pattern, reason] of HARD_DENY) {
    if (pattern.test(lowered)) return DENY(`blocked pattern: ${reason}`)
  }

  // Redirects and pipes rewrite something. `echo x > note.md` starts with a
  // harmless verb but does not stay harmless, so it must not reach the allow list.
  if (/[>]|\|\S|\|\s/.test(normalized)) {
    return ASK(`command redirects or pipes: ${normalized.slice(0, 48)}`)
  }

  for (const prefix of BASH_ALLOW_PREFIXES) {
    if (lowered === prefix.trim() || lowered.startsWith(prefix)) {
      return ALLOW(`command read-only: ${normalized.slice(0, 48)}`)
    }
  }

  // Destructive-looking verbs surface as a question rather than a silent pass,
  // even with no full pattern match.
  if (/^\b(rm|del|rmdir|mv|kill|killall|chmod|chown|dd|shutdown|reboot|mkfs|format)\b/.test(lowered)) {
    return ASK(`command mutates state: ${normalized.slice(0, 48)}`)
  }

  return undefined
}

export interface GateOptions {
  mode: PermissionMode
  /** Session working directory; writes outside it are surfaced, not silently allowed. */
  cwd: string
  rules: readonly PermissionRule[]
  memory: PermissionMemory
  sessionId: string
  /** Called only when every local layer said "ask" for a command-shaped tool. */
  classifyBash?: BashClassifier
}

/**
 * Empty classifier result must not be cached — an unparseable reply would
 * otherwise pin a tool to "ask" for the rest of the run.
 */
class ClassifierCache {
  private map = new Map<string, PermissionVerdict>()

  get(command: string): PermissionVerdict | undefined {
    return this.map.get(command)
  }

  set(command: string, verdict: PermissionVerdict): void {
    if (this.map.size > 500) this.map.clear()
    this.map.set(command, verdict)
  }
}

export class PermissionGate {
  private cache = new ClassifierCache()
  private consecutiveDenies = 0

  async evaluate(request: GateRequest, options: GateOptions): Promise<GateResult> {
    const { mode, cwd, rules, memory } = options
    const toolName = request.toolName
    const args = request.args ?? {}
    const fingerprint = PermissionMemory.fingerprintArgs(args)
    const paths = extractPaths(args)
    const command = argsForCommand(args)

    // Layer 1 — session memory (name AND parameters).
    if (memory.has(toolName, fingerprint)) {
      return { outcome: 'allow', verdict: { outcome: 'allow', via: 'user', reason: 'allowed earlier this session, same parameters' } }
    }

    // Layer 1.5 — credential boundary (before rules, on purpose).
    //
    // Session memory sits above this layer, so a user who explicitly approved
    // this exact call once keeps working without a prompt. Rules sit below it,
    // so `permissions.json` cannot blanket-authorise credential access — the
    // boundary is a capability limit, not a policy default.
    const credential = credentialGuardFor(toolName, paths, command)
    if (credential !== undefined) return credential

    // Layer 2 — ordered rules.
    for (const rule of rules) {
      if (!ruleMatchesTool(rule, toolName)) continue
      if (!ruleMatchesCommand(rule, command)) continue
      if (!ruleMatchesPath(rule, paths)) continue
      const verdict: PermissionVerdict = {
        outcome: rule.action,
        via: 'rule',
        reason: rule.note ?? `rule "${rule.id ?? rule.action}"`
      }
      const outcome: GateOutcome = rule.action
      if (outcome !== 'ask') return { outcome, verdict }
      break // an explicit "ask" rule stops the chain here and prompts.
    }

    // Layer 3 — heuristics (fast path, no model call).
    let base: PermissionVerdict | undefined

    // Writes are checked before reads on purpose: substring matching for reads
    // would otherwise swallow write tools whose names merely contain a read-ish
    // word (`find_and_replace`, `read_write_config`, ...).
    const mcpVerdict = classifyMcpTool(toolName, args)
    if (mcpVerdict) base = mcpVerdict
    else if (command) base = classifyBashCommand(command)
    else if (WRITE_TOOLS.has(toolName) || isFileEditTool(toolName)) base = classifyWrite(toolName, paths, cwd)
    else if (READ_TOOLS.has(toolName) || matchesReadSubstring(toolName)) base = ALLOW('read-only tool')

    // Layer 4 — classifier, but only where the heuristics drew a blank.
    //
    // Two conditions, both learned by measuring against a live provider:
    //
    //  1. `base === undefined` counts as unresolved. `classifyBashCommand` returns
    //     `undefined` for anything it has no opinion on (`python`, `node`, `ffmpeg`,
    //     `make`, ...), which is exactly the ambiguous middle the classifier is
    //     for. Gating on an explicit "ask" instead made this layer dead code.
    //  2. An explicit heuristic ASK stays human-gated. That verdict means the
    //     local layer already recognised a mutating verb (`rm`, `kill`, `chmod`,
    //     ...); letting a small model overrule it trades a cheap prompt for a
    //     chance of auto-running a destructive command — the wrong side of the
    //     FN/FP asymmetry the whole design rests on.
    const unresolved = base === undefined
    if (unresolved && toolName === 'bash' && command && options.classifyBash) {
      const normalized = normalizeCommand(command)
      const cached = this.cache.get(normalized)
      if (cached) {
        base = cached
      } else if (this.shouldDegrade()) {
        // Layer 4b — the classifier keeps refusing; that reads as a blind spot
        // in the classifier rather than a dangerous command, so stop guessing
        // and hand the decision back to a human.
        base = ASK('classifier returned inconclusive three times — asking you instead')
      } else {
        const verdict = await options.classifyBash(normalized, cwd)
        if (verdict) {
          this.cache.set(normalized, verdict)
          base = verdict
          if (verdict.outcome === 'deny') this.consecutiveDenies += 1
          else this.consecutiveDenies = 0
        } else {
          base = ASK('classifier unreachable — defaulting to ask')
        }
      }
    }

    // Layer 5 — mode rails. Most conservative reading of the base verdict.
    return this.applyMode(base, mode, toolName, command, isMcpDiscovery(toolName, args))
  }

  noteAllowance(): void {
    this.consecutiveDenies = 0
  }

  /** After N classifier refusals, hand the decision back to a human. */
  shouldDegrade(): boolean {
    return this.consecutiveDenies >= 3
  }

  private applyMode(
    base: PermissionVerdict | undefined,
    mode: PermissionMode,
    toolName: string,
    command: string,
    /** Read-only by argument, not by name (MCP discovery modes). */
    readOnly = false
  ): GateResult {
    const fallback = base ?? ASK(`no policy for tool "${toolName}"`)

    switch (mode) {
      case 'plan': {
        // Reads pass, writes never do. Note the article's pitfall: blocking
        // *every* tool here starves the planner of context, so reads are exempt.
        // MCP discovery counts: it is how the planner learns what exists.
        if (readOnly || isReadTool(toolName)) {
          return { outcome: 'allow', verdict: { outcome: 'allow', via: 'mode', reason: 'plan mode: read allowed' } }
        }
        return { outcome: 'deny', verdict: { outcome: 'deny', via: 'mode', reason: 'plan mode blocks writes' } }
      }
      case 'bypass': {
        // Nothing interrupts the user; destructive patterns still refuse.
        if (fallback.outcome === 'deny') return { outcome: 'deny', verdict: fallback }
        if (toolName === 'bash' && classifyBashCommand(command)?.outcome === 'deny') {
          return { outcome: 'deny', verdict: { outcome: 'deny', via: 'heuristic', reason: 'destructive command refused in bypass mode' } }
        }
        return { outcome: 'allow', verdict: { outcome: 'allow', via: 'mode', reason: 'bypass mode' } }
      }
      case 'acceptEdits': {
        // Version-controlled workspace edits are trusted; shell commands are not.
        if (readOnly || isReadTool(toolName)) {
          return { outcome: 'allow', verdict: { outcome: 'allow', via: 'mode', reason: 'accept-edits mode' } }
        }
        return { outcome: fallback.outcome, verdict: fallback }
      }
      case 'auto':
      case 'default':
      default: {
        return { outcome: fallback.outcome, verdict: fallback }
      }
    }
  }
}

function matchesReadSubstring(toolName: string): boolean {
  const lowered = toolName.toLowerCase()
  return (
    lowered.includes('read') ||
    lowered.includes('search') ||
    lowered.includes('list') ||
    lowered.includes('grep') ||
    lowered.includes('stat') ||
    lowered.includes('fetch') ||
    lowered.includes('inspect')
  )
}

function isReadTool(toolName: string): boolean {
  return (
    !WRITE_TOOLS.has(toolName) &&
    !isFileEditTool(toolName) &&
    (READ_TOOLS.has(toolName) || matchesReadSubstring(toolName))
  )
}

/** Write-shaped by name. Deliberately broad: under-blocking beats over-blocking. */
function isFileEditTool(toolName: string): boolean {
  const lowered = toolName.toLowerCase()
  return (
    WRITE_TOOLS.has(toolName) ||
    lowered.includes('write') ||
    lowered.includes('edit') ||
    lowered.includes('patch') ||
    lowered.includes('create') ||
    lowered.includes('replace') ||
    lowered.includes('append') ||
    lowered.includes('delete') ||
    lowered.includes('remove')
  )
}

function classifyWrite(toolName: string, paths: string[], cwd: string): PermissionVerdict {
  if (paths.length === 0) return ASK(`write tool "${toolName}" without a resolvable target`)
  for (const target of paths) {
    if (withinFlexHome(target)) return ALLOW('FlexAgent owns this directory — changing itself needs no approval')
    if (!withinWorkspace(target, cwd)) {
      return ASK(`target is outside the workspace: ${target}`)
    }
  }
  return ALLOW(`writes inside ${cwd}`)
}

/** Shell verbs that destroy the target rather than read it. */
const DESTRUCTIVE_PATH_VERB = /^\s*(rm|del|rmdir|shred|truncate|mv|rename)\b/iu

/**
 * The credential boundary.
 *
 * Two asymmetries are deliberate:
 *
 * - **Write is refused, read is asked.** Creating or overwriting a private key
 *   has no legitimate agent workflow behind it and no undo; reading one does
 *   (a user can be debugging their own deployment), so the human decides.
 * - **A shell command that would delete a credential is refused**, not asked:
 *   `rm ~/.ssh/id_rsa` is exactly the irreversible case, and it arrives as a
 *   string rather than as a path argument, so it needs its own verb test.
 *
 * This runs before the rule list, which means `permissions.json` cannot widen
 * access to these locations. That is the point: the article's channel model
 * restricts capability rather than trying to infer intent, and a boundary the
 * user can silently disable by editing a JSON file is a default, not a
 * boundary. An explicit one-off "allow session" still works, because session
 * memory is consulted first.
 */
function credentialGuardFor(
  toolName: string,
  paths: string[],
  command: string
): GateResult | undefined {
  const target: SensitiveTarget | undefined =
    firstSensitivePath(paths) ?? commandTouchesSensitivePath(command)
  if (target === undefined) return undefined

  const where = `credential location (${target.kind}): ${target.target}`

  if (command !== '') {
    if (DESTRUCTIVE_PATH_VERB.test(command)) {
      return {
        outcome: 'deny',
        verdict: DENY(`${where} — commands that delete credentials are refused`)
      }
    }
    return {
      outcome: 'ask',
      verdict: ASK(`${where} — confirm before it is read into the model context`)
    }
  }

  const mutating = WRITE_TOOLS.has(toolName) || isFileEditTool(toolName)
  if (mutating) {
    return {
      outcome: 'deny',
      verdict: DENY(`${where} — writes to credential stores are refused`)
    }
  }
  return {
    outcome: 'ask',
    verdict: ASK(`${where} — confirm before its contents enter the model context`)
  }
}

/**
 * Render this run's refusals as a system-prompt note the agent can act on.
 * Without it the agent simply retries the same refused call next turn.
 */
export function describeDenials(denials: Iterable<{ name: string; reason?: string }>): string | undefined {
  const lines = [...denials].map((entry) => `- ${entry.name}${entry.reason ? `: ${entry.reason}` : ''}`)
  if (lines.length === 0) return undefined
  return [`Refused in this session — do not repeat these, choose another approach:`, ...lines].join('\n')
}

/**
 * Rejection tracking lives on the refusal message itself (see `worker.ts`): the
 * blocked-call reason carries this summary into the transcript, so the model can
 * see what was already refused.
 *
 * A cleaner home would be a per-session `before_agent_start` hook appending to
 * the system prompt, but PI's extension factories are cached per resource loader
 * (i.e. per cwd, shared by every session on that cwd) and the event carries no
 * session identity — so there is no correct per-session hook to attach to.
 */

/** Standalone helper so the renderer and tests can reuse the classification. */
export { classifyBashCommand, FLEX_HOME }
