/**
 * Custom subagent definitions (ticket 16): Markdown files with YAML-ish
 * frontmatter, one role per file, living in AGENTS_HOME.
 *
 * Contract:
 *  - A file missing `name` or `description` is *ignored*, never half-loaded,
 *    and always leaves an AgentDiagnostic behind — a silently dropped role is
 *    indistinguishable from a broken one at dispatch time ("unknown role"),
 *    so the diagnostic is part of the acceptance criteria, not a nicety.
 *  - Built-in roles own their names: a definition colliding with one is an
 *    error, and built-ins are never deleted or modified through this module.
 *  - The loader is read-only with respect to dispatch until
 *    `loadAgentRegistry()` is called again; multiAgent snapshots the registry
 *    per extension build, which is what makes "changes apply to new sessions"
 *    true rather than aspirational.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ContractError } from '../../shared/contract'
import { READ_TOOLS, ROLES, WRITE_TOOLS, withContract, type AgentRole } from './roles'

export const AGENTS_HOME =
  process.env.FLEXAGENT_AGENTS_HOME ?? join(homedir(), '.flexagent', 'agents')

export type AgentDiagnosticCode =
  | 'missing_frontmatter'
  | 'invalid_frontmatter'
  | 'missing_name'
  | 'invalid_name'
  | 'missing_description'
  | 'name_conflict'
  | 'duplicate_name'
  | 'invalid_model'
  | 'invalid_max_turns'
  | 'invalid_tools'
  | 'task_not_grantable'
  | 'empty_body'
  | 'unreadable'

export interface AgentDiagnostic {
  /** File the diagnostic points at (absolute path when known, else file name). */
  file: string
  code: AgentDiagnosticCode
  message: string
  /** error → the file was ignored; warning → loaded with the field corrected. */
  severity: 'error' | 'warning'
}

export interface AgentRegistry {
  /** Dispatchable roles: built-ins plus enabled definitions. */
  roles: Record<string, AgentRole>
  /** Everything known, including disabled definitions (settings page view). */
  all: AgentRole[]
  diagnostics: AgentDiagnostic[]
}

export interface CustomAgentInput {
  name: string
  description: string
  label?: string
  model?: string
  tools: string[]
  maxTurns?: number
  enabled: boolean
  persona: string
  parallelWith?: string[] | '*'
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^/\s]+$/
const TOOL_RE = /^[A-Za-z0-9_*][A-Za-z0-9_.*-]*$/
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function err(
  file: string,
  code: AgentDiagnosticCode,
  message: string
): AgentDiagnostic {
  return { file, code, message, severity: 'error' }
}

function warn(
  file: string,
  code: AgentDiagnosticCode,
  message: string
): AgentDiagnostic {
  return { file, code, message, severity: 'warning' }
}

function stripScalar(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  return value.replace(/\s+#.*$/, '')
}

interface Frontmatter {
  data: Record<string, string | string[]>
  errors: string[]
}

function parseFrontmatterBlock(block: string): Frontmatter {
  const data: Record<string, string | string[]> = {}
  const errors: string[] = []
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) {
      errors.push(`unparseable line: ${line.trim()}`)
      continue
    }
    const key = match[1]!
    const rest = match[2]!.trim()
    if (rest === '') {
      const items: string[] = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!
        const item = /^\s+-\s+(.*)$/.exec(next)
        if (item === null) break
        items.push(stripScalar(item[1]!))
        i += 1
      }
      data[key] = items
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = rest
        .slice(1, -1)
        .split(',')
        .map((item) => stripScalar(item))
        .filter((item) => item !== '')
      continue
    }
    data[key] = stripScalar(rest)
  }
  return { data, errors }
}

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asStringList(value: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item) => item.trim() !== '')
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }
  return undefined
}

function readOnlyFor(tools: string[]): boolean {
  const read = new Set(READ_TOOLS)
  return tools.every((tool) => read.has(tool))
}

/**
 * Parse one definition file. Returns `role: undefined` with error diagnostics
 * when the file must be ignored, or a loaded role plus any field-level
 * warnings that were corrected on the way in.
 */
export function parseCustomAgentDefinition(
  file: string,
  raw: string,
  options: { reservedNames?: ReadonlySet<string> } = {}
): { role?: AgentRole; diagnostics: AgentDiagnostic[] } {
  const diagnostics: AgentDiagnostic[] = []
  const match = FRONTMATTER_RE.exec(raw)
  if (match === null) {
    diagnostics.push(
      err(file, 'missing_frontmatter', 'no `---` frontmatter block; file ignored')
    )
    return { diagnostics }
  }
  const frontmatter = parseFrontmatterBlock(match[1]!)
  if (frontmatter.errors.length > 0) {
    diagnostics.push(
      err(file, 'invalid_frontmatter', frontmatter.errors.join('; '))
    )
    return { diagnostics }
  }
  const body = (match[2] ?? '').trim()
  const data = frontmatter.data

  const name = asString(data.name)
  if (name === undefined) {
    diagnostics.push(err(file, 'missing_name', 'frontmatter has no `name`; file ignored'))
    return { diagnostics }
  }
  if (!NAME_RE.test(name)) {
    diagnostics.push(
      err(
        file,
        'invalid_name',
        `name "${name}" must be a lowercase slug (letters, digits, "-", "_")`
      )
    )
    return { diagnostics }
  }
  const reserved = options.reservedNames ?? new Set(Object.keys(ROLES))
  if (reserved.has(name)) {
    diagnostics.push(
      err(file, 'name_conflict', `name "${name}" collides with a built-in role; file ignored`)
    )
    return { diagnostics }
  }

  const description = asString(data.description)
  if (description === undefined) {
    diagnostics.push(
      err(file, 'missing_description', 'frontmatter has no `description`; file ignored')
    )
    return { diagnostics }
  }

  let model = asString(data.model)
  if (model !== undefined && !MODEL_RE.test(model)) {
    diagnostics.push(
      warn(
        file,
        'invalid_model',
        `model "${model}" is not "provider/id"; the subagent will follow the session model`
      )
    )
    model = undefined
  }

  let maxTurns: number | undefined
  const maxTurnsRaw = asString(data.maxTurns)
  if (maxTurnsRaw !== undefined) {
    const parsed = Number(maxTurnsRaw)
    if (!Number.isInteger(parsed) || parsed < 1) {
      diagnostics.push(
        warn(file, 'invalid_max_turns', `maxTurns "${maxTurnsRaw}" is not a positive integer; ignored`)
      )
    } else {
      maxTurns = parsed
    }
  }

  let enabled = true
  const enabledRaw = asString(data.enabled)
  if (enabledRaw !== undefined) {
    if (/^(true|false)$/i.test(enabledRaw)) {
      enabled = enabledRaw.toLowerCase() === 'true'
    } else {
      diagnostics.push(
        warn(file, 'invalid_tools', `enabled "${enabledRaw}" is not true/false; treated as true`)
      )
    }
  }

  let tools: string[]
  if (data.tools === undefined) {
    tools = [...WRITE_TOOLS]
  } else {
    const list = asStringList(data.tools)
    if (list === undefined) {
      diagnostics.push(err(file, 'invalid_tools', '`tools` has no entries; file ignored'))
      return { diagnostics }
    }
    const bad = list.filter((tool) => !TOOL_RE.test(tool))
    if (bad.length > 0) {
      diagnostics.push(
        err(file, 'invalid_tools', `invalid tool name(s): ${bad.join(', ')}; file ignored`)
      )
      return { diagnostics }
    }
    if (list.includes('task')) {
      diagnostics.push(
        warn(
          file,
          'task_not_grantable',
          '`task` cannot be granted to a subagent (nesting is capped at one level); removed'
        )
      )
    }
    tools = list.filter((tool) => tool !== 'task')
  }

  let parallelWith: string[] | '*'
  const parallelRaw = asString(data.parallelWith)
  if (parallelRaw === '*' || parallelRaw === undefined) {
    parallelWith = parallelRaw === '*' || readOnlyFor(tools) ? '*' : []
  } else {
    const list = asStringList(data.parallelWith) ?? []
    parallelWith = list.length > 0 && !list.includes('*') ? list : []
  }

  if (body === '') {
    diagnostics.push(
      warn(file, 'empty_body', 'no system-prompt body; the description is used as the persona')
    )
  }

  const persona = withContract(body !== '' ? body : `${name}: ${description}`)
  const role: AgentRole = {
    name,
    label: asString(data.label) ?? name,
    description,
    persona,
    readOnly: readOnlyFor(tools),
    tools,
    parallelWith,
    output: 'custom subagent output',
    builtin: false,
    enabled,
    sourceFile: file,
    ...(model === undefined ? {} : { model }),
    ...(maxTurns === undefined ? {} : { maxTurns })
  }
  return { role, diagnostics }
}

function definitionFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => join(dir, entry))
}

function readRoleFile(
  file: string,
  reservedNames: ReadonlySet<string>
): { role?: AgentRole; diagnostics: AgentDiagnostic[] } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { diagnostics: [err(file, 'unreadable', `cannot read file: ${message}`)] }
  }
  return parseCustomAgentDefinition(file, raw, { reservedNames })
}

/** Every definition file, valid or not. Disabled roles included. */
export function listCustomAgents(
  dir: string = AGENTS_HOME
): { roles: AgentRole[]; diagnostics: AgentDiagnostic[] } {
  const reserved = new Set(Object.keys(ROLES))
  const diagnostics: AgentDiagnostic[] = []
  const roles: AgentRole[] = []
  const seen = new Set<string>()
  for (const file of definitionFiles(dir)) {
    const { role, diagnostics: fileDiagnostics } = readRoleFile(file, reserved)
    diagnostics.push(...fileDiagnostics)
    if (role === undefined) continue
    if (seen.has(role.name)) {
      diagnostics.push(
        err(file, 'duplicate_name', `name "${role.name}" already defined by another file; file ignored`)
      )
      continue
    }
    seen.add(role.name)
    roles.push(role)
  }
  return { roles, diagnostics }
}

/**
 * Built-in roles plus definitions, snapshotted from disk. Dispatch-visible
 * `roles` excludes disabled definitions; `all` keeps them for the settings
 * page. `getRole`/`listRoleNames` in roles.ts stay built-in-only on purpose —
 * the multi-agent extension consumes this registry instead.
 */
export function loadAgentRegistry(dir: string = AGENTS_HOME): AgentRegistry {
  const roles: Record<string, AgentRole> = {}
  for (const [name, role] of Object.entries(ROLES)) {
    roles[name] = { ...role, builtin: true, enabled: true }
  }
  const all: AgentRole[] = Object.values(roles)
  const { roles: customs, diagnostics } = listCustomAgents(dir)
  for (const role of customs) {
    all.push(role)
    if (role.enabled !== false) roles[role.name] = role
  }
  return { roles, all, diagnostics }
}

export function isBuiltinName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLES, name)
}

/**
 * Security: the name is joined into a path, so it must be validated as the
 * raw string — never as the comment-stripped scalar `stripScalar` produces
 * during parsing, or `slug #/../../x` passes validation and writes outside
 * AGENTS_HOME.
 */
export function assertSafeAgentName(raw: string): void {
  if (typeof raw !== 'string' || !NAME_RE.test(raw) || raw.includes('..')) {
    throw new ContractError(
      'INVALID_INPUT',
      `invalid subagent name ${JSON.stringify(raw)}: expected a lowercase slug (letters, digits, "-", "_")`
    )
  }
}

// ---------------------------------------------------------------------------
// Settings-page CRUD (main process only; never called from the worker)
// ---------------------------------------------------------------------------

export function renderCustomAgentMarkdown(def: CustomAgentInput): string {
  const lines = ['---', `name: ${def.name}`]
  lines.push(`description: ${JSON.stringify(def.description.replace(/\s+/g, ' ').trim())}`)
  if (def.label !== undefined && def.label.trim() !== '' && def.label !== def.name) {
    lines.push(`label: ${JSON.stringify(def.label.trim())}`)
  }
  if (def.model !== undefined && def.model.trim() !== '') {
    lines.push(`model: ${def.model.trim()}`)
  }
  lines.push(`tools: [${def.tools.join(', ')}]`)
  if (def.maxTurns !== undefined) lines.push(`maxTurns: ${def.maxTurns}`)
  lines.push(`enabled: ${def.enabled ? 'true' : 'false'}`)
  if (Array.isArray(def.parallelWith)) lines.push(`parallelWith: [${def.parallelWith.join(', ')}]`)
  else if (def.parallelWith === '*') lines.push('parallelWith: "*"')
  lines.push('---')
  const body = def.persona.trim()
  return `${lines.join('\n')}\n\n${body}\n`
}

function inputToRole(
  file: string,
  def: CustomAgentInput,
  reserved: ReadonlySet<string>
): { role?: AgentRole; diagnostics: AgentDiagnostic[] } {
  const raw = renderCustomAgentMarkdown(def)
  return parseCustomAgentDefinition(file, raw, { reservedNames: reserved })
}

/** Create or update a definition. Throws when the content fails validation. */
export function saveCustomAgent(
  def: CustomAgentInput,
  dir: string = AGENTS_HOME
): { role: AgentRole; diagnostics: AgentDiagnostic[] } {
  assertSafeAgentName(def.name)
  const file = join(dir, `${def.name}.md`)
  const reserved = new Set(Object.keys(ROLES))
  const existing = definitionFiles(dir).filter(
    (path) => path.toLowerCase() !== file.toLowerCase()
  )
  for (const path of existing) {
    const { role } = readRoleFile(path, reserved)
    if (role !== undefined) reserved.add(role.name)
  }
  const { role, diagnostics } = inputToRole(file, def, reserved)
  if (role === undefined) {
    const first = diagnostics.find((item) => item.severity === 'error')
    throw new Error(first?.message ?? 'invalid subagent definition')
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, renderCustomAgentMarkdown(def), 'utf8')
  return { role: { ...role, sourceFile: file }, diagnostics }
}

export function deleteCustomAgent(name: string, dir: string = AGENTS_HOME): void {
  assertSafeAgentName(name)
  if (isBuiltinName(name)) {
    throw new ContractError('INVALID_INPUT', `built-in role "${name}" cannot be deleted`)
  }
  const file = join(dir, `${name}.md`)
  if (!existsSync(file)) throw new Error(`no subagent definition named "${name}"`)
  rmSync(file)
}

export function setCustomAgentEnabled(
  name: string,
  enabled: boolean,
  dir: string = AGENTS_HOME
): AgentRole {
  assertSafeAgentName(name)
  if (isBuiltinName(name)) {
    throw new ContractError('INVALID_INPUT', `built-in role "${name}" cannot be modified`)
  }
  const file = join(dir, `${name}.md`)
  if (!existsSync(file)) throw new Error(`no subagent definition named "${name}"`)
  const { role } = readRoleFile(file, new Set(Object.keys(ROLES)))
  if (role === undefined) throw new Error(`definition file for "${name}" is invalid`)
  const next: CustomAgentInput = {
    name: role.name,
    description: role.description,
    label: role.label,
    tools: role.tools,
    enabled,
    persona: stripContract(role.persona),
    ...(role.model === undefined ? {} : { model: role.model }),
    ...(role.maxTurns === undefined ? {} : { maxTurns: role.maxTurns }),
    ...(role.parallelWith === '*' ? { parallelWith: '*' as const } : { parallelWith: [...role.parallelWith] })
  }
  writeFileSync(file, renderCustomAgentMarkdown(next), 'utf8')
  return { ...role, enabled }
}

/**
 * The shared output contract is appended at parse time (`withContract`), so a
 * round-trip through setCustomAgentEnabled must strip the old copy first or
 * every toggle stacks another one onto the persona.
 */
function stripContract(persona: string): string {
  const marker = '\n\nRules:\n- Stay inside your role.'
  const at = persona.lastIndexOf(marker)
  return at === -1 ? persona : persona.slice(0, at)
}
