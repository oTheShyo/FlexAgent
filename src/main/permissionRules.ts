/**
 * User-authored permission rules, persisted in `~/.flexagent/permissions.json`.
 *
 * The gate consults these *after* its own built-in heuristics and the
 * credential boundary, but before the classifier: a rule is a human decision
 * and must not be subordinated to a model call. See `permissionGate.ts` for the
 * full chain.
 *
 * Outcomes are collected deny → ask → allow rather than first-hit-wins across
 * the whole list. First-hit-wins was the bug this file existed to work around:
 * a user rule reading "never let the agent touch `.env`" sat behind a built-in
 * `allow *read*` and therefore never ran. Position in the file describes nothing
 * any more except tie-breaking inside one action class.
 *
 * A malformed or unreadable file degrades to the built-ins only — a broken rule
 * file must never be able to wedge the agent behind a prompt that never resolves.
 */
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  ContractError,
  type PermissionRule,
  type PermissionRuleOrigin,
  type PermissionRuleSet,
  type SavePermissionRuleInput
} from '../shared/contract'
import { commandForArgs, pathsForArgs } from './permissionGate'

export const PERMISSIONS_FILE = join(homedir(), '.flexagent', 'permissions.json')

/**
 * Built-ins are reported alongside the user rules so the UI can explain the full
 * picture rather than pretending the file is the whole story. They are marked
 * `origin: 'builtin'` because the settings list only offers a revoke button on
 * rules the user could actually have written.
 */
export const BUILTIN_RULES: readonly PermissionRule[] = [
  { id: 'read-tools', tool: '*read*', action: 'allow', note: 'Read-only tool', origin: 'builtin' },
  { id: 'search-tools', tool: '*search*', action: 'allow', note: 'Search-only tool', origin: 'builtin' },
  // No MCP entry on purpose. The gate handles MCP itself (discovery modes
  // allow, everything else asks) because the old `command: 'mcp'` rule could
  // never match: `command` is matched against a *shell* argument, and the proxy
  // tool has none, so the rule only ever fired on bash lines containing "mcp".
  { id: 'destructive-force', command: 'rm -rf', action: 'deny', note: 'Recursive force delete', origin: 'builtin' },
  { id: 'destructive-push', command: 'git push --force', action: 'deny', note: 'Force push', origin: 'builtin' },
  { id: 'destructive-reset', command: 'git reset --hard', action: 'deny', note: 'Hard reset discards work', origin: 'builtin' },
  { id: 'destructive-clean', command: 'git clean -fd', action: 'deny', note: 'Discards untracked work', origin: 'builtin' },
  { id: 'destructive-chmod', command: 'chmod 777', action: 'deny', note: 'World-writable permissions', origin: 'builtin' },
  { id: 'destructive-sudo', command: 'sudo ', action: 'deny', note: 'Elevated execution', origin: 'builtin' },
  { id: 'destructive-pipe-sh', command: '| sh', action: 'deny', note: 'Piping a remote payload into a shell', origin: 'builtin' },
  { id: 'destructive-curl-sh', command: 'curl', action: 'ask', note: 'Network fetch — classified', origin: 'builtin' }
]

function isRule(value: unknown): value is PermissionRule {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const scope = candidate.scope
  return (
    (candidate.action === 'allow' ||
      candidate.action === 'deny' ||
      candidate.action === 'ask') &&
    (candidate.tool === undefined || typeof candidate.tool === 'string') &&
    (candidate.command === undefined || typeof candidate.command === 'string') &&
    (candidate.path === undefined || typeof candidate.path === 'string') &&
    (scope === undefined || scope === 'global' || scope === 'project') &&
    // A project rule without a project to belong to would silently match
    // everywhere, which is the opposite of what the user asked for.
    (scope !== 'project' || typeof candidate.projectPath === 'string')
  )
}

/**
 * Fill in what the loader owes every rule: a stable `id` to revoke by, an
 * `origin` so the list knows what is removable, and a `createdAt`.
 *
 * Pre-v1.19 files have none of the three, and a rule the user cannot name is a
 * rule they cannot take back — so missing values are synthesised on read rather
 * than waiting for the next write to fix them up. `createdAt: 0` means "unknown"
 * and renders as such; guessing "now" would date a rule to a moment it did not
 * exist.
 */
function normalizeRules(list: readonly PermissionRule[]): PermissionRule[] {
  return list.map((rule, index) => ({
    ...rule,
    id: rule.id ?? `legacy-rule-${index + 1}`,
    createdAt: rule.createdAt ?? 0,
    origin: rule.origin ?? ('user' satisfies PermissionRuleOrigin)
  }))
}

export function defaultRuleSet(): PermissionRuleSet {
  return { sourcePath: PERMISSIONS_FILE, rules: [] }
}

export function loadRuleSet(): PermissionRuleSet {
  try {
    if (!existsSync(PERMISSIONS_FILE)) return defaultRuleSet()
    const parsed: unknown = JSON.parse(readFileSync(PERMISSIONS_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return defaultRuleSet()
    const list = (parsed as { rules?: unknown }).rules
    if (!Array.isArray(list)) return defaultRuleSet()
    return { sourcePath: PERMISSIONS_FILE, rules: normalizeRules(list.filter(isRule)) }
  } catch {
    return defaultRuleSet()
  }
}

/**
 * The write behind every mutation. Staged through a sibling file and renamed so
 * a crash mid-write cannot leave a half-truncated `permissions.json` — the
 * loader swallows that failure and falls back to the built-ins, which would
 * discard every rule the user had written.
 */
function writeRuleFile(rules: readonly PermissionRule[]): PermissionRuleSet {
  const payload: PermissionRuleSet = { sourcePath: PERMISSIONS_FILE, rules: [...rules] }
  mkdirSync(dirname(PERMISSIONS_FILE), { recursive: true })
  const staged = `${PERMISSIONS_FILE}.${randomUUID()}.tmp`
  try {
    writeFileSync(staged, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameSync(staged, PERMISSIONS_FILE)
  } catch (err) {
    // A rule file that will not save is worth failing loudly about: the caller
    // can then tell the truth instead of reporting a rule that is not on disk.
    throw new ContractError(
      'KERNEL_INTERNAL',
      `Failed to write ${PERMISSIONS_FILE}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return payload
}

export function listUserRules(): PermissionRule[] {
  return loadRuleSet().rules
}

function newRuleId(): string {
  return `rule-${randomUUID()}`
}

/**
 * Turn the call the user just answered into the rule they asked for.
 *
 * The matchers are derived from the call itself — a tool name, plus the shell
 * line when the call had one — so "always allow" on `npm test` records
 * `command: 'npm test'`, not `tool: 'bash'`. A tool-name rule would be a
 * blanket pass for every shell command the agent ever runs, which is the exact
 * "allow bash once, then `rm -rf /`" failure mode session memory exists to
 * prevent. `path` is deliberately not recorded: a project rule for a write tool
 * means "in this project", not "this one file", and the UI says so.
 */
function derivedRule(input: PersistedRuleInput): PermissionRule {
  const command = commandForArgs(input.args)
  const rule: PermissionRule = {
    id: newRuleId(),
    tool: input.tool,
    action: input.action,
    createdAt: Date.now(),
    origin: 'user',
    note: input.note ?? (command !== '' ? `${input.action} "${command}"` : `${input.action} ${input.tool}`)
  }
  if (command !== '') rule.command = command
  // Written even when it is `global`: a rule file that only mentions scopes the
  // user never chose for it is a rule file that teaches the reader to wonder.
  rule.scope = input.scope
  if (input.scope === 'project') rule.projectPath = input.cwd
  return rule
}

/** Identity used to keep a second click from stack-duplicating the same rule. */
function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return (
    a.action === b.action &&
    a.tool === b.tool &&
    a.command === b.command &&
    a.scope === b.scope &&
    a.projectPath === b.projectPath
  )
}

/**
 * `sessionId` has already been resolved to a cwd by the IPC layer.
 *
 * A project rule is anchored to a directory on purpose. Recording `cwd: ''` as
 * "no anchor" would degrade it into a global rule, which is the scope the user
 * did not ask for — so an empty anchor is refused rather than silently widened.
 */
export interface PersistedRuleInput extends Omit<SavePermissionRuleInput, 'sessionId'> {
  cwd: string
}

export async function addUserRule(input: PersistedRuleInput): Promise<PermissionRuleSet> {
  if (typeof input.tool !== 'string' || input.tool === '') {
    throw new ContractError('INVALID_INPUT', 'tool is required for a saved rule')
  }
  if (input.scope !== 'global' && input.scope !== 'project') {
    throw new ContractError('INVALID_INPUT', `unknown rule scope: ${String(input.scope)}`)
  }
  if (input.cwd === '') {
    throw new ContractError('INVALID_INPUT', 'a rule needs the cwd it belongs to')
  }
  const rule = derivedRule(input)
  const rules = listUserRules()
  const existing = rules.find((candidate) => sameRule(candidate, rule))
  if (existing !== undefined) {
    // Already on disk, under its original id and timestamp: the second click is
    // a confirmation, not a new rule.
    return { sourcePath: PERMISSIONS_FILE, rules: [...BUILTIN_RULES, ...rules] }
  }
  const next = writeRuleFile([...rules, rule])
  return { sourcePath: PERMISSIONS_FILE, rules: [...BUILTIN_RULES, ...next.rules] }
}

export async function removeUserRule(id: string): Promise<PermissionRuleSet> {
  const rules = listUserRules()
  const next = rules.filter((rule) => rule.id !== id)
  if (next.length === rules.length) {
    throw new ContractError('INVALID_INPUT', `no saved rule with id "${id}"`)
  }
  const payload = writeRuleFile(next)
  return { sourcePath: PERMISSIONS_FILE, rules: [...BUILTIN_RULES, ...payload.rules] }
}

/** Everything the gate consults, built-ins first (they win on ties). */
export function effectiveRuleSet(): PermissionRuleSet {
  const user = loadRuleSet()
  return { sourcePath: PERMISSIONS_FILE, rules: [...BUILTIN_RULES, ...user.rules] }
}
