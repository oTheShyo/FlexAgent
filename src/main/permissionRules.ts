/**
 * User-authored permission rules, persisted in `~/.flexagent/permissions.json`.
 *
 * The gate in `permissionGate.ts` evaluates its *own* built-in heuristics before
 * consulting these; the file exists for the cases the built-ins cannot express
 * ("allow git commit anywhere in this workspace", "never let the agent touch
 * `.env`"). Rules are first-hit-wins, exactly like the evaluator.
 *
 * A malformed or unreadable file degrades to the built-ins only — a broken rule
 * file must never be able to wedge the agent behind a prompt that never resolves.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { PermissionRule, PermissionRuleSet } from '../shared/contract'

export const PERMISSIONS_FILE = join(homedir(), '.flexagent', 'permissions.json')

/**
 * Built-ins are reported alongside the user rules so the UI can explain the full
 * picture rather than pretending the file is the whole story.
 */
export const BUILTIN_RULES: readonly PermissionRule[] = [
  { id: 'read-tools', tool: '*read*', action: 'allow', note: 'Read-only tool' },
  { id: 'search-tools', tool: '*search*', action: 'allow', note: 'Search-only tool' },
  // No MCP entry on purpose. The gate handles MCP itself (discovery modes
  // allow, everything else asks) because the old `command: 'mcp'` rule could
  // never match: `command` is matched against a *shell* argument, and the proxy
  // tool has none, so the rule only ever fired on bash lines containing "mcp".
  { id: 'destructive-force', command: 'rm -rf', action: 'deny', note: 'Recursive force delete' },
  { id: 'destructive-push', command: 'git push --force', action: 'deny', note: 'Force push' },
  { id: 'destructive-reset', command: 'git reset --hard', action: 'deny', note: 'Hard reset discards work' },
  { id: 'destructive-clean', command: 'git clean -fd', action: 'deny', note: 'Discards untracked work' },
  { id: 'destructive-chmod', command: 'chmod 777', action: 'deny', note: 'World-writable permissions' },
  { id: 'destructive-sudo', command: 'sudo ', action: 'deny', note: 'Elevated execution' },
  { id: 'destructive-pipe-sh', command: '| sh', action: 'deny', note: 'Piping a remote payload into a shell' },
  { id: 'destructive-curl-sh', command: 'curl', action: 'ask', note: 'Network fetch — classified' }
]

function isRule(value: unknown): value is PermissionRule {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    (candidate.action === 'allow' ||
      candidate.action === 'deny' ||
      candidate.action === 'ask') &&
    (candidate.tool === undefined || typeof candidate.tool === 'string') &&
    (candidate.command === undefined || typeof candidate.command === 'string') &&
    (candidate.path === undefined || typeof candidate.path === 'string')
  )
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
    return { sourcePath: PERMISSIONS_FILE, rules: list.filter(isRule) }
  } catch {
    return defaultRuleSet()
  }
}

export function saveRuleSet(rules: readonly PermissionRule[]): PermissionRuleSet {
  const payload: PermissionRuleSet = { sourcePath: PERMISSIONS_FILE, rules: [...rules] }
  try {
    mkdirSync(dirname(PERMISSIONS_FILE), { recursive: true })
    writeFileSync(PERMISSIONS_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  } catch {
    // Persistence is best-effort: the in-memory set still governs this run.
    // Surfacing this would need a new error code; a rule file that will not
    // save is not worth breaking the agent over.
  }
  return payload
}

/** Everything the gate consults, built-ins first (they win on ties). */
export function effectiveRuleSet(): PermissionRuleSet {
  const user = loadRuleSet()
  return { sourcePath: PERMISSIONS_FILE, rules: [...BUILTIN_RULES, ...user.rules] }
}
