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
 *      first, then `~/.flexagent/permissions.json`). First hit wins *within one
 *      action class*, and the classes are collected deny → ask → allow, so a
 *      rule a human wrote can never be out-ranked by an earlier allow.
 *   3. heuristics      — tool-shape analysis: read tools, workspace-contained
 *      writes, destructive command patterns. Zero latency, zero model calls.
 *      Its HARD_DENY patterns sit above the rule layer (see `hardDenyFor`).
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
import type { PermissionMode, PermissionRule, PermissionRuleAction, PermissionVerdict } from '../shared/contract'
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

/**
 * The reason a command shape is refused outright, or `undefined`.
 *
 * Deliberately above the rule layer: `rm -rf` on a credential path is a
 * capability limit, and a limit the user can lift by adding a JSON line is a
 * default. The rules below it have no say here; session memory (layer 1) still
 * does, because that is an explicit human approval of this exact call.
 */
export function hardDenyFor(command: string): string | undefined {
  const normalized = normalizeCommand(command)
  if (normalized === '') return undefined
  const lowered = normalized.toLowerCase()
  for (const [pattern, reason] of HARD_DENY) {
    if (pattern.test(lowered)) return reason
  }
  return undefined
}

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
/**
 * Exported so `permissionRules.ts` can derive a rule's matchers from the same
 * call the gate matched on — a rule built from a re-implementation of this
 * would drift the moment a tool gained a new argument name.
 */
export function commandForArgs(args: Record<string, unknown> | undefined): string {
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

/** Exported for the same reason as `commandForArgs`: rule derivation must agree. */
export function pathsForArgs(args: Record<string, unknown> | undefined): string[] {
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

/**
 * The ownership dimension rules were missing before scopes existed.
 *
 * A `project` rule carries the cwd it was authored in, and only ever fires for
 * calls made from inside that tree — so "allow `npm test` in this repo" does not
 * silently become "allow `npm test` everywhere". Absent or `global` matches
 * every cwd, which is what a rule file written before this field existed means.
 */
function ruleMatchesScope(rule: PermissionRule, cwd: string, sessionId?: string): boolean {
  if (rule.scope === 'session') {
    // Ticket 28. A session rule is answerable to the session it came from, so it
    // is *matched* against the current session rather than merely deleted when
    // that session exits. The two are not interchangeable: deletion has to be
    // right every time — on dispose, on delete, on a crash, on a rule file
    // written by a build that never learned to clean up — and one miss leaves a
    // rule that grants a permission forever. Matching has no such failure mode:
    // if the session is gone, or this is a different session, the rule simply
    // never fires. The worst case is a dead line in a JSON file.
    if (rule.sessionId === undefined || sessionId === undefined) return false
    return rule.sessionId === sessionId
  }
  if (rule.scope !== 'project' || rule.projectPath === undefined) return true
  return withinWorkspace(cwd, rule.projectPath)
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

  const hardDeny = hardDenyFor(command)
  if (hardDeny !== undefined) return DENY(`blocked pattern: ${hardDeny}`)

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

const RULE_ORDER: readonly PermissionRuleAction[] = ['deny', 'ask', 'allow']

function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  command: string,
  paths: string[],
  cwd: string,
  sessionId?: string
): boolean {
  return (
    ruleMatchesTool(rule, toolName) &&
    ruleMatchesCommand(rule, command) &&
    ruleMatchesPath(rule, paths) &&
    ruleMatchesScope(rule, cwd, sessionId)
  )
}

/**
 * The first rule that matches, searched one outcome class at a time.
 *
 * `undefined` means no rule matched, and the caller then falls through to the
 * heuristics — exactly what the single-pass loop used to do.
 */
function collectRuleVerdict(
  rules: readonly PermissionRule[],
  toolName: string,
  command: string,
  paths: string[],
  cwd: string,
  sessionId?: string
): PermissionVerdict | undefined {
  for (const action of RULE_ORDER) {
    for (const rule of rules) {
      if (rule.action !== action || !ruleMatches(rule, toolName, command, paths, cwd, sessionId)) continue
      return { outcome: action, via: 'rule', reason: rule.note ?? `rule "${rule.id ?? rule.action}"` }
    }
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
    const paths = pathsForArgs(args)
    const command = commandForArgs(args)

    // The layers below produce a *base verdict*; `applyMode` runs
    // unconditionally at the end as the final reduction. Earlier revisions
    // returned early from memory/rules/credential, which let each of them
    // short-circuit the mode rails — `plan` could be defeated by a prior
    // `allowSession`, and an early `allow` inherited nothing from the mode.
    let base: PermissionVerdict | undefined

    // Layer 1 — session memory (name AND parameters).
    if (memory.has(toolName, fingerprint)) {
      base = { outcome: 'allow', via: 'user', reason: 'allowed earlier this session, same parameters' }
    }

    // Layer 1.5 — credential boundary (before rules, on purpose).
    //
    // Session memory sits above this layer, so a user who explicitly approved
    // this exact call once keeps working without a prompt. Rules sit below it,
    // so `permissions.json` cannot blanket-authorise credential access — the
    // boundary is a capability limit, not a policy default.
    //
    // It also bypasses the mode reduction: `plan`'s "reads pass" exemption is
    // about not starving the planner of workspace context, and must not double
    // as a waiver for secrets entering the model context. The boundary decides
    // on its own.
    const credential = credentialGuardFor(toolName, paths, command)
    if (credential !== undefined) return credential

    // Layer 1.75 — hard-refused command shapes.
    //
    // Above the rule layer on purpose: an "always allow" the user handed us must
    // not be able to re-authorise `rm -rf`. The patterns live with the rest of
    // the bash heuristics (`hardDenyFor`) so there is still one list of them.
    if (base === undefined) {
      const hardDeny = command === '' ? undefined : hardDenyFor(command)
      if (hardDeny !== undefined) base = DENY(`blocked pattern: ${hardDeny} — no rule can allow this`)
    }

    // Layer 2 — ordered rules, collected by outcome.
    //
    // Three passes over the same ordered list rather than one. Under plain
    // first-hit-wins, a user's deny rule was shadowed by any built-in or
    // earlier allow that happened to match first — the rule that best
    // expresses intent lost to whatever was written first. Order still decides
    // ties *inside* a class (the built-ins deliberately come first), but across
    // classes a refusal beats a question, and a question beats an allow.
    if (base === undefined) {
      base = collectRuleVerdict(rules, toolName, command, paths, cwd, options.sessionId)
    }

    // Layer 3 — heuristics (fast path, no model call).
    //
    // Writes are checked before reads on purpose: substring matching for reads
    // would otherwise swallow write tools whose names merely contain a read-ish
    // word (`find_and_replace`, `read_write_config`, ...).
    if (base === undefined) {
      const mcpVerdict = classifyMcpTool(toolName, args)
      if (mcpVerdict) base = mcpVerdict
      else if (command) base = classifyBashCommand(command)
      else if (WRITE_TOOLS.has(toolName) || isFileEditTool(toolName)) base = classifyWrite(toolName, paths, cwd)
      else if (readAllowedByShape(toolName, args)) base = ALLOW('read-only tool')
    }

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

    // Layer 5 — mode rails. The final reduction, run unconditionally: every
    // layer above contributed a base verdict, and the mode has the last word on
    // it. A mode may tighten (plan turns allow into deny) but never loosen an
    // explicit deny.
    return this.applyMode(base, mode, toolName, command, args)
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
    args: Record<string, unknown>
  ): GateResult {
    const fallback = base ?? ASK(`no policy for tool "${toolName}"`)
    const readOnly = readAllowedByShape(toolName, args)

    switch (mode) {
      case 'plan': {
        // Reads pass, writes never do — and this holds no matter which layer
        // said otherwise, which is why it is a reduction and not a step in the
        // chain. Note the article's pitfall: blocking *every* tool here starves
        // the planner of context, so reads are exempt. MCP discovery counts: it
        // is how the planner learns what exists.
        if (readOnly) {
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
        if (readOnly) {
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

/**
 * Whether a tool is read-only *by its shape* — the single definition the mode
 * rails and the heuristics both consult.
 *
 * MCP is the reason this is a function and not a direct `isReadTool` call: a
 * third-party server picks its own tool names, so `mcp__server__read_files`
 * says nothing about what the call does. Only the proxy's discovery modes
 * (which never reach a server) count as reads; any other MCP tool is not a read
 * no matter what its name contains.
 */
function readAllowedByShape(toolName: string, args: Record<string, unknown>): boolean {
  if (isMcpDiscovery(toolName, args)) return true
  if (isMcpToolName(toolName)) return false
  return isReadTool(toolName)
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
