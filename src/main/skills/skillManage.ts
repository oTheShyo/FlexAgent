import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { ContractError } from '../../shared/contract'
import type { SkillPendingWrite } from '../../shared/contract'

/**
 * Agent-managed skill engine (Hermes-aligned, M1/M2).
 *
 * Skills are directories with a SKILL.md under a single user-level home
 * (`~/.flexagent/skills`). The agent owns this tree through the `skill_manage`
 * tool; plugin-bundled and project-local skills live elsewhere and are never
 * written here. With `skills.writeApproval` enabled, writes are staged under
 * `~/.flexagent/pending/skills/` until approved (M2 approval gate).
 */

export const SKILLS_HOME = join(homedir(), '.flexagent', 'skills')
export const PENDING_HOME = join(homedir(), '.flexagent', 'pending', 'skills')
export const SETTINGS_FILE = join(homedir(), '.flexagent', 'settings.json')

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const CATEGORY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** SKILL.md body beyond this size is loaded whole into context on view — warn. */
const OVERSIZED_BODY_CHARS = 24_000
/** More reference files than this suggests the skill is a dumping ground — warn. */
const REFERENCES_SPRAWL_COUNT = 60
/** Dense incident references mean a log crept into a skill — warn. */
const INCIDENT_LOG_MIN_MATCHES = 8
const INCIDENT_LOG_RE = /\b(PR|pull request|issue) #?\d+\b/gi

export type SkillOpAction = 'create' | 'patch' | 'delete' | 'write_file' | 'remove_file' | 'list'

export interface SkillOp {
  action: SkillOpAction
  name?: unknown
  category?: unknown
  content?: unknown
  oldString?: unknown
  newString?: unknown
  filePath?: unknown
  fileContent?: unknown
}

export interface SkillOpResultLine {
  action: SkillOpAction
  skill: string
  message: string
  warning?: string
}

export interface SkillWriteOutcome {
  applied: SkillOpResultLine[]
  /** Present when writeApproval is on and the batch was staged instead of applied. */
  stagedId?: string
}

interface ParsedOp {
  action: SkillOpAction
  name: string
  category?: string
  content?: string
  oldString?: string
  newString?: string
  filePath?: string
  fileContent?: string
}

interface AppliedFile {
  path: string
  /** null = file did not exist before this batch. */
  previousContent: string | null
}

interface AppliedDirs {
  created: string[]
}

interface AppliedOp {
  op: ParsedOp
  skillDir: string
  files: AppliedFile[]
  dirs: AppliedDirs
  removedTree?: string
  /** True when the op deleted files that must come back on rollback. */
  removedFiles: AppliedFile[]
}

interface PendingRecord {
  id: string
  createdAt: number
  ops: SkillOp[]
  summary: string[]
  targetPaths: string[]
}

// ─── Settings ────────────────────────────────────────────────────────────────

export function isSkillWriteApprovalEnabled(): boolean {
  try {
    if (!existsSync(SETTINGS_FILE)) return false
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as {
      skills?: { writeApproval?: unknown }
    }
    return parsed?.skills?.writeApproval === true
  } catch {
    return false
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function asString(value: unknown, field: string, opIndex: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ContractError(
      'INVALID_INPUT',
      `op[${opIndex}] (${field}) must be a string`
    )
  }
  return value
}

function skillDirOf(op: ParsedOp): string {
  const dir = op.category !== undefined ? join(SKILLS_HOME, op.category, op.name) : join(SKILLS_HOME, op.name)
  const resolved = resolve(dir)
  // Hard boundary: everything the agent writes stays under SKILLS_HOME.
  if (resolved !== SKILLS_HOME && !resolved.startsWith(SKILLS_HOME + sep)) {
    throw new ContractError('INVALID_INPUT', `skill path escapes the skills home: ${op.name}`)
  }
  return resolved
}

function skillFileOf(skillDir: string, relPath: string, opIndex: number): string {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    throw new ContractError('INVALID_INPUT', `op[${opIndex}] filePath is required`)
  }
  const target = resolve(skillDir, relPath)
  if (target !== skillDir && !target.startsWith(skillDir + sep)) {
    throw new ContractError('INVALID_INPUT', `op[${opIndex}] filePath escapes the skill directory`)
  }
  return target
}

// ─── Batch validation (atomic rejection, Hermes semantics) ──────────────────

/**
 * Every action owns exactly one text slot. An op carrying another action's
 * slot is a syntax error — reject the WHOLE batch and say where the text
 * belongs, so locally-constrained backends can learn the shape.
 */
function validateSlots(op: SkillOp, opIndex: number): void {
  const action = op.action
  const has = (key: keyof SkillOp): boolean => op[key] !== undefined
  const offenders: string[] = []
  if (action === 'create') {
    if (has('fileContent')) offenders.push('fileContent')
    if (has('newString')) offenders.push('newString')
  } else if (action === 'patch') {
    if (has('fileContent')) offenders.push('fileContent')
  } else if (action === 'write_file') {
    if (has('content')) offenders.push('content')
    if (has('newString')) offenders.push('newString')
  } else if (action === 'remove_file') {
    if (has('content')) offenders.push('content')
    if (has('fileContent')) offenders.push('fileContent')
    if (has('newString')) offenders.push('newString')
  } else if (action === 'delete') {
    if (has('content')) offenders.push('content')
    if (has('fileContent')) offenders.push('fileContent')
    if (has('newString')) offenders.push('newString')
  }
  if (offenders.length > 0) {
    const belongs: Record<string, string> = {
      content: 'create / full rewrite (patch with content)',
      newString: 'patch (with oldString)',
      fileContent: 'write_file'
    }
    throw new ContractError(
      'INVALID_INPUT',
      `op[${opIndex}] (${action}) carries text in "${offenders.join(', ')}" which belongs to ` +
        `${offenders.map((key) => `${key} → ${belongs[key] ?? 'no action'}`).join('; ')}. ` +
        'The whole batch was rejected; move the text to the correct key.'
    )
  }
}

function parseOp(raw: SkillOp, opIndex: number): ParsedOp {
  validateSlots(raw, opIndex)
  const action = raw.action
  const name = asString(raw.name, 'name', opIndex)
  const category = asString(raw.category, 'category', opIndex)
  const content = asString(raw.content, 'content', opIndex)
  const oldString = asString(raw.oldString, 'oldString', opIndex)
  const newString = asString(raw.newString, 'newString', opIndex)
  const filePath = asString(raw.filePath, 'filePath', opIndex)
  const fileContent = asString(raw.fileContent, 'fileContent', opIndex)

  if (action === 'list') {
    return { action, name: '' }
  }
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new ContractError(
      'INVALID_INPUT',
      `op[${opIndex}] name must match ${SKILL_NAME_RE.source}`
    )
  }
  if (category !== undefined && !CATEGORY_RE.test(category)) {
    throw new ContractError('INVALID_INPUT', `op[${opIndex}] category must match ${CATEGORY_RE.source}`)
  }
  const op: ParsedOp = { action, name, ...(category !== undefined ? { category } : {}) }
  if (action === 'create') {
    if (typeof content !== 'string') {
      throw new ContractError('INVALID_INPUT', `op[${opIndex}] create requires content (full SKILL.md)`)
    }
    op.content = content
    return op
  }
  if (action === 'patch') {
    if (typeof content === 'string') {
      op.content = content // full rewrite
      return op
    }
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      throw new ContractError(
        'INVALID_INPUT',
        `op[${opIndex}] patch requires either content (full rewrite) or oldString+newString`
      )
    }
    op.oldString = oldString
    op.newString = newString
    return op
  }
  if (action === 'delete') {
    return op
  }
  if (action === 'write_file') {
    if (typeof filePath !== 'string') {
      throw new ContractError('INVALID_INPUT', `op[${opIndex}] write_file requires filePath`)
    }
    if (typeof fileContent !== 'string') {
      throw new ContractError('INVALID_INPUT', `op[${opIndex}] write_file requires fileContent`)
    }
    op.filePath = filePath
    op.fileContent = fileContent
    return op
  }
  // remove_file
  if (typeof filePath !== 'string') {
    throw new ContractError('INVALID_INPUT', `op[${opIndex}] remove_file requires filePath`)
  }
  op.filePath = filePath
  return op
}

// ─── Advisory linter (warnings never block) ──────────────────────────────────

function lintSkillBody(body: string): string | undefined {
  if (body.length > OVERSIZED_BODY_CHARS) {
    return `oversized-body: SKILL.md body is ${body.length} chars (> ${OVERSIZED_BODY_CHARS}); skill_view loads it whole into context`
  }
  const incidents = body.match(INCIDENT_LOG_RE)
  if (incidents !== null && incidents.length >= INCIDENT_LOG_MIN_MATCHES) {
    return `incident-log-shape: ${incidents.length} PR/issue references in the body — skills should hold generalizable lessons, not incident logs`
  }
  return undefined
}

function lintReferences(skillDir: string): string | undefined {
  const referencesDir = join(skillDir, 'references')
  if (!existsSync(referencesDir)) return undefined
  let count = 0
  const stack = [referencesDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name))
      else if (entry.isFile()) count += 1
      if (count > REFERENCES_SPRAWL_COUNT) {
        return `references-sprawl: more than ${REFERENCES_SPRAWL_COUNT} files under references/ — keep a few topically named files instead`
      }
    }
  }
  return undefined
}

// ─── Apply ───────────────────────────────────────────────────────────────────

function readIfExists(path: string): string | null {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null
}

function writeTracked(files: AppliedFile[], dirs: AppliedDirs, path: string, content: string): void {
  const parent = resolve(path, '..')
  if (!existsSync(parent)) {
    // Track every directory level mkdirSync is about to create so rollback can
    // remove the empty skeleton again.
    let level = parent
    const created: string[] = []
    while (!existsSync(level)) {
      created.push(level)
      const next = resolve(level, '..')
      if (next === level || resolve(SKILLS_HOME) === level) break
      level = next
    }
    dirs.created.push(...created)
    mkdirSync(parent, { recursive: true })
  }
  files.push({ path, previousContent: readIfExists(path) })
  writeFileSync(path, content, 'utf8')
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: '', body: raw }
  return { frontmatter: match[1], body: match[2] }
}

function applyOp(op: ParsedOp, applied: AppliedOp): SkillOpResultLine {
  const skillDir = skillDirOf(op)
  applied.op = op
  applied.skillDir = skillDir
  applied.files = []
  applied.dirs = { created: [] }
  applied.removedFiles = []

  if (op.action === 'create') {
    if (existsSync(skillDir)) {
      throw new ContractError('INVALID_INPUT', `skill already exists: ${op.name}`)
    }
    mkdirSync(skillDir, { recursive: true })
    applied.dirs.created.push(skillDir)
    const skillMd = join(skillDir, 'SKILL.md')
    applied.files.push({ path: skillMd, previousContent: null })
    writeFileSync(skillMd, op.content ?? '', 'utf8')
    const { body } = splitFrontmatter(op.content ?? '')
    return {
      action: 'create',
      skill: op.name,
      message: `created ${op.name}`,
      ...(op.content !== undefined && op.content.length > OVERSIZED_BODY_CHARS
        ? { warning: lintSkillBody(body) }
        : {})
    }
  }

  if (op.action === 'delete') {
    if (!existsSync(skillDir)) {
      throw new ContractError('INVALID_INPUT', `unknown skill: ${op.name}`)
    }
    collectTreeFiles(skillDir, applied.removedFiles)
    applied.removedTree = skillDir
    rmSync(skillDir, { recursive: true, force: true })
    return { action: 'delete', skill: op.name, message: `deleted ${op.name}` }
  }

  if (op.action === 'patch') {
    const skillMd = join(skillDir, 'SKILL.md')
    const current = readIfExists(skillMd)
    if (current === null) {
      throw new ContractError('INVALID_INPUT', `unknown skill (no SKILL.md): ${op.name}`)
    }
    const next =
      op.content !== undefined
        ? op.content
        : replaceOnce(current, op.oldString ?? '', op.newString ?? '', op.name)
    applied.files.push({ path: skillMd, previousContent: current })
    writeFileSync(skillMd, next, 'utf8')
    const { body } = splitFrontmatter(next)
    return {
      action: 'patch',
      skill: op.name,
      message: op.content !== undefined ? `rewrote ${op.name}` : `patched ${op.name}`,
      ...(lintSkillBody(body) !== undefined ? { warning: lintSkillBody(body) } : {})
    }
  }

  if (op.action === 'write_file') {
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      throw new ContractError('INVALID_INPUT', `unknown skill (no SKILL.md): ${op.name}`)
    }
    const target = skillFileOf(skillDir, op.filePath ?? '', -1)
    writeTracked(applied.files, applied.dirs, target, op.fileContent ?? '')
    return {
      action: 'write_file',
      skill: op.name,
      message: `wrote ${op.filePath} in ${op.name}`,
      ...(lintReferences(skillDir) !== undefined ? { warning: lintReferences(skillDir) } : {})
    }
  }

  // remove_file
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    throw new ContractError('INVALID_INPUT', `unknown skill (no SKILL.md): ${op.name}`)
  }
  const target = skillFileOf(skillDir, op.filePath ?? '', -1)
  if (!existsSync(target)) {
    throw new ContractError('INVALID_INPUT', `op file not found: ${op.filePath} in ${op.name}`)
  }
  applied.removedFiles.push({ path: target, previousContent: readIfExists(target) })
  rmSync(target, { force: true })
  return { action: 'remove_file', skill: op.name, message: `removed ${op.filePath} from ${op.name}` }
}

function replaceOnce(haystack: string, needle: string, replacement: string, skill: string): string {
  if (needle.length === 0) {
    throw new ContractError('INVALID_INPUT', `patch of ${skill}: oldString must not be empty`)
  }
  const first = haystack.indexOf(needle)
  if (first < 0) {
    throw new ContractError('INVALID_INPUT', `patch of ${skill}: oldString not found`)
  }
  if (haystack.indexOf(needle, first + 1) >= 0) {
    throw new ContractError(
      'INVALID_INPUT',
      `patch of ${skill}: oldString matches multiple locations; add surrounding context to make it unique`
    )
  }
  return haystack.slice(0, first) + replacement + haystack.slice(first + needle.length)
}

function collectTreeFiles(root: string, out: AppliedFile[]): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) collectTreeFiles(full, out)
    else if (entry.isFile()) out.push({ path: full, previousContent: readIfExists(full) })
  }
}

function rollback(appliedOps: AppliedOp[]): void {
  for (const applied of [...appliedOps].reverse()) {
    for (const file of applied.files) {
      try {
        if (file.previousContent === null) rmSync(file.path, { force: true })
        else writeFileSync(file.path, file.previousContent, 'utf8')
      } catch {
        /* best-effort rollback */
      }
    }
    for (const file of applied.removedFiles) {
      try {
        if (file.previousContent !== null) writeFileSync(file.path, file.previousContent, 'utf8')
      } catch {
        /* best-effort rollback */
      }
    }
    if (applied.removedTree !== undefined) {
      // Recreate the deleted dir skeleton so the tree shape survives a rollback.
      try {
        mkdirSync(applied.removedTree, { recursive: true })
      } catch {
        /* best-effort rollback */
      }
    }
    // Clean up directories this batch created (only when empty — out-of-band
    // files, if any, survive by design).
    for (const dir of [...applied.dirs.created].sort((a, b) => b.length - a.length)) {
      try {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
      } catch {
        /* best-effort rollback */
      }
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

function summarizeOp(op: ParsedOp): string {
  switch (op.action) {
    case 'create':
      return `create skill "${op.name}" (${(op.content ?? '').length} chars)`
    case 'patch':
      return op.content !== undefined
        ? `rewrite skill "${op.name}" (${op.content.length} chars)`
        : `patch skill "${op.name}"`
    case 'delete':
      return `delete skill "${op.name}"`
    case 'write_file':
      return `write ${op.filePath} in "${op.name}"`
    case 'remove_file':
      return `remove ${op.filePath} from "${op.name}"`
    default:
      return op.action
  }
}

/** Entry point for the `skill_manage` tool: a batch (or single op) of writes. */
export function runSkillManage(rawOps: SkillOp[]): SkillWriteOutcome {
  if (rawOps.length === 0) {
    throw new ContractError('INVALID_INPUT', 'no operations given')
  }
  // Parse + validate everything first: one bad slot rejects the whole batch.
  const ops = rawOps.map((op, index) => parseOp(op, index))
  const listOnly = ops.every((op) => op.action === 'list')
  if (listOnly) {
    return {
      applied: listUserSkillDirs().map((skill) => ({
        action: 'list' as const,
        skill: skill.name,
        message: `user: ${skill.dir}${skill.description !== undefined ? ` — ${skill.description}` : ''}`
      }))
    }
  }

  if (isSkillWriteApprovalEnabled()) {
    const record: PendingRecord = {
      id: randomUUID(),
      createdAt: Date.now(),
      ops: rawOps.filter((op) => op.action !== 'list'),
      summary: ops.filter((op) => op.action !== 'list').map(summarizeOp),
      targetPaths: ops
        .filter((op) => op.action !== 'list')
        .map((op) => skillDirOf(op))
    }
    mkdirSync(PENDING_HOME, { recursive: true })
    writeFileSync(join(PENDING_HOME, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8')
    return {
      applied: [
        {
          action: ops[0]!.action,
          skill: ops[0]!.name || '',
          message: `staged for approval (${record.id}); the user reviews it in Skills → Pending writes`
        }
      ]
    }
  }

  const appliedOps: AppliedOp[] = []
  const lines: SkillOpResultLine[] = []
  try {
    for (const op of ops) {
      const applied: AppliedOp = { op, skillDir: '', files: [], dirs: { created: [] }, removedFiles: [] }
      lines.push(applyOp(op, applied))
      appliedOps.push(applied)
    }
  } catch (err) {
    rollback(appliedOps)
    throw err
  }
  return { applied: lines }
}

export function listPendingSkillWrites(): SkillPendingWrite[] {
  if (!existsSync(PENDING_HOME)) return []
  const out: SkillPendingWrite[] = []
  for (const entry of readdirSync(PENDING_HOME, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const record = JSON.parse(
        readFileSync(join(PENDING_HOME, entry.name), 'utf8')
      ) as PendingRecord
      out.push({
        id: record.id,
        skillName: typeof record.ops?.[0]?.name === 'string' ? (record.ops[0].name as string) : '',
        summary: record.summary,
        targetPaths: record.targetPaths,
        createdAt: record.createdAt
      })
    } catch {
      // Unreadable staged record — surface it as an opaque entry so the user
      // can still reject it instead of it rotting forever.
      out.push({
        id: entry.name.replace(/\.json$/, ''),
        skillName: '(unreadable staged write)',
        summary: ['The staged record could not be parsed; reject to discard it.'],
        targetPaths: [],
        createdAt: 0
      })
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

function loadPendingRecord(id: string): PendingRecord {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ContractError('INVALID_INPUT', 'invalid pending write id')
  }
  const file = join(PENDING_HOME, `${id}.json`)
  if (!existsSync(file)) {
    throw new ContractError('INVALID_INPUT', `no pending skill write with id ${id}`)
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PendingRecord
  } catch (err) {
    rmSync(file, { force: true })
    throw new ContractError('INVALID_INPUT', `pending record unreadable and discarded: ${(err as Error).message}`)
  }
}

export function approveSkillWrite(id: string): SkillOpResultLine[] {
  const record = loadPendingRecord(id)
  const ops = record.ops.map((op, index) => parseOp(op, index))
  const appliedOps: AppliedOp[] = []
  const lines: SkillOpResultLine[] = []
  try {
    for (const op of ops) {
      const applied: AppliedOp = { op, skillDir: '', files: [], dirs: { created: [] }, removedFiles: [] }
      lines.push(applyOp(op, applied))
      appliedOps.push(applied)
    }
  } catch (err) {
    rollback(appliedOps)
    throw err
  }
  rmSync(join(PENDING_HOME, `${id}.json`), { force: true })
  return lines
}

export function rejectSkillWrite(id: string): void {
  loadPendingRecord(id)
  rmSync(join(PENDING_HOME, `${id}.json`), { force: true })
}

// ─── Listing (shared by skillService + skill_manage list) ────────────────────

export interface DiscoveredSkill {
  name: string
  description?: string
  /** Absolute skill directory. */
  dir: string
}

function parseFrontmatterMeta(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (kv[1] === 'name' && value.length > 0) out.name = value
    else if (kv[1] === 'description' && value.length > 0) out.description = value
  }
  return out
}

export function readSkillMeta(skillDir: string): DiscoveredSkill {
  let raw = ''
  try {
    raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  } catch {
    raw = ''
  }
  const meta = parseFrontmatterMeta(raw)
  return {
    name: meta.name ?? skillDir.split(/[\\/]/).pop() ?? 'skill',
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    dir: skillDir
  }
}

/** User-level skills: `~/.flexagent/skills/<name>/SKILL.md` (optionally one category level). */
export function listUserSkillDirs(): DiscoveredSkill[] {
  if (!existsSync(SKILLS_HOME)) return []
  const out: DiscoveredSkill[] = []
  if (existsSync(join(SKILLS_HOME, 'SKILL.md'))) {
    out.push(readSkillMeta(SKILLS_HOME))
    return out
  }
  for (const entry of readdirSync(SKILLS_HOME, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(SKILLS_HOME, entry.name)
    if (existsSync(join(dir, 'SKILL.md'))) {
      out.push(readSkillMeta(dir))
      continue
    }
    for (const sub of readdirSync(dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue
      const subDir = join(dir, sub.name)
      if (existsSync(join(subDir, 'SKILL.md'))) out.push(readSkillMeta(subDir))
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export { splitFrontmatter }

/** Used by the tool to guard absolute paths passed as filePath. */
export function isInsideSkillsHome(path: string): boolean {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(SKILLS_HOME, path)
  return resolved === SKILLS_HOME || resolved.startsWith(SKILLS_HOME + sep)
}
