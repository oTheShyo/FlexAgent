/**
 * Agent role system (multi-agent collaboration, chapter "Agent 角色系统").
 *
 * Every role gets:
 * 1. Its own persona (independent system prompt) — never the host agent's
 *    persona. Mixing them dilutes both: role consistency breaks, professional
 *    constraints blur, and the host's identity leaks into tool-output prose.
 * 2. A restricted tool whitelist. A child's toolset is always a subset of the
 *    host's; a whitelist (not a blacklist) is what makes "subset" hold.
 * 3. A concurrency declaration: `readOnly` seeds the parallel-safety default,
 *    `parallelWith` names the roles it may run alongside. The declaration must
 *    be symmetric — the scheduler checks both directions and falls back to
 *    serial when either side withholds consent.
 */

export interface AgentRole {
  /** Slug used in tool parameters. */
  name: string
  label: string
  /**
   * Independent persona plus the shared output contract, prepended to the
   * child's first user message. See `withContract` for why the contract sits
   * inside this field instead of being added where the persona is used.
   */
  persona: string
  /** Read-only roles are parallel-safe by default. */
  readOnly: boolean
  /**
   * Builtin tool whitelist for child sessions. Deliberately excludes `task`
   * (no recursive spawning) and every extension-registered tool — children
   * load a resource loader built with noExtensions/noSkills, so extension
   * tools (skill_manage, memory_manage, MCP) never exist for them.
   */
  tools: string[]
  /** Roles this one may run in parallel with; '*' means any. */
  parallelWith: string[] | '*'
  /** Output artifact type, used for conflict detection in prompts. */
  output: string
}

const READ_TOOLS = ['read', 'grep', 'find', 'ls']
const WRITE_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

const COMMON_TAIL = `
Rules:
- Stay inside your role. Do not start tasks outside your expertise boundary.
- Your final message is the deliverable returned to the requesting agent —
  make it self-contained: findings, decisions, and their evidence (file paths,
  line numbers, measured numbers). No meta commentary about being a subagent.
- If you cannot complete the task, say exactly what is missing instead of
  guessing silently`.trim()

/**
 * Append the shared output contract to a persona.
 *
 * The contract lives inside the field rather than being concatenated at the one
 * place that sends the persona to the child, because forgetting to do that is
 * silent and one-sided: a child without it still works, it just keeps exploring
 * past its task, or reports a guess as a finding and lets the parent treat that
 * as an answer. Six of the seven personas below describe who they are and say
 * nothing about what they owe the agent that asked them.
 */
function withContract(persona: string): string {
  return `${persona}\n\n${COMMON_TAIL}`
}

export const ROLES: Record<string, AgentRole> = {
  researcher: {
    name: 'researcher',
    label: 'Researcher',
    persona: withContract(`You are Salt, a research agent: precise, curious, allergic to unsourced claims.
You collect information and read code. Every conclusion you report carries its
evidence (path:line, command output, or a quoted passage). You get visibly
excited about a clean mechanism, but you never dress a guess up as a finding.
You are read-only: you cannot and will not modify anything.`),
    readOnly: true,
    tools: READ_TOOLS,
    parallelWith: '*',
    output: 'research notes / findings report'
  },
  writer: {
    name: 'writer',
    label: 'Writer',
    persona: withContract(`You are Reed, a writing agent with a journalist's economy: short sentences,
concrete nouns, zero filler. You care about how a text reads out loud —
rhythm, paragraph breaks, where a reader's attention sags. You write and edit
documents; you do not run programs or restructure code.`),
    readOnly: false,
    tools: WRITE_TOOLS,
    parallelWith: ['researcher', 'translator'],
    output: 'documents / markdown files'
  },
  translator: {
    name: 'translator',
    label: 'Translator',
    persona: withContract(`You are Echo, a translation agent: faithful to meaning, natural in the target
language. You translate and review translations; you do not reinterpret the
content, and you flag source passages that are ambiguous instead of silently
picking a reading. You never write to files outside the translation output.`),
    readOnly: true,
    tools: READ_TOOLS,
    parallelWith: '*',
    output: 'translations'
  },
  developer: {
    name: 'developer',
    label: 'Developer',
    persona: withContract(`You are Gauge, a development agent: blunt, test-driven, allergic to
speculative abstraction. You implement code changes and verify them by running
builds and tests before claiming success. You state plainly what you did not
verify. You touch code files and leave documents to writers.`),
    readOnly: false,
    tools: WRITE_TOOLS,
    parallelWith: ['designer'],
    output: 'code changes / test results'
  },
  analyst: {
    name: 'analyst',
    label: 'Analyst',
    persona: withContract(`You are Scalar, an analysis agent: numbers first, narrative second. You run
scripts and measurements to turn raw data into answers, and you always state
the uncertainty along with the result. You never present an estimated number
as a measured one.`),
    readOnly: false,
    tools: WRITE_TOOLS,
    parallelWith: ['researcher'],
    output: 'analysis results / metrics'
  },
  designer: {
    name: 'designer',
    label: 'Designer',
    persona: withContract(`You are Fade, a design agent: you think in hierarchy, spacing, and contrast.
You write and adjust UI code and styles, judging results by how they will feel
to a user, not by how elegant the CSS is. You leave logic to developers.`),
    readOnly: false,
    tools: WRITE_TOOLS,
    parallelWith: ['developer'],
    output: 'UI / styling changes'
  },
  /**
   * Swarm peer. Concurrency safety comes from the task queue's atomic claim,
   * not from read-write separation — that is why it declares '*' despite
   * having write tools.
   */
  peer: {
    name: 'peer',
    label: 'Swarm peer',
    persona: withContract(`You are a Swarm peer worker. You pull one task at a time from a shared
queue, complete it, record the result, and pull the next — until the queue is
drained. You never invent tasks, never touch tasks assigned to others, and
your completion summary is what downstream tasks will rely on, so record
outcomes, not narration.`),
    readOnly: false,
    tools: WRITE_TOOLS,
    parallelWith: '*',
    output: 'queue task results'
  }
}

export function getRole(name: string): AgentRole | undefined {
  return ROLES[name]
}

export function listRoleNames(): string[] {
  return Object.keys(ROLES)
}

/**
 * Symmetric parallel-compatibility check. If either side withholds consent,
 * the pair is not parallel-safe — the scheduler takes the conservative side,
 * exactly as the design doc requires.
 */
export function canRunInParallel(a: AgentRole, b: AgentRole): boolean {
  if (a.readOnly && b.readOnly) return true
  const aOk = a.parallelWith === '*' || a.parallelWith.includes(b.name)
  const bOk = b.parallelWith === '*' || b.parallelWith.includes(a.name)
  return aOk && bOk
}

/** Fail-fast symmetry audit; returns human-readable problems (empty = clean). */
export function auditSymmetry(): string[] {
  const problems: string[] = []
  const roles = Object.values(ROLES)
  for (const role of roles) {
    if (role.parallelWith === '*') continue
    for (const other of role.parallelWith) {
      const counterpart = ROLES[other]
      if (counterpart === undefined) {
        problems.push(`${role.name} declares unknown parallel partner "${other}"`)
        continue
      }
      const ok =
        counterpart.parallelWith === '*' || counterpart.parallelWith.includes(role.name)
      if (!ok) {
        problems.push(
          `${role.name} ↔ ${other} asymmetric: ${other} does not list ${role.name}`
        )
      }
    }
  }
  return problems
}

/**
 * Phrases every persona must contain. They come from COMMON_TAIL above, so
 * rewording that tail means rewording this list — that coupling is what keeps
 * an audit like this one from passing simply because nobody wrapped the new
 * persona in `withContract`.
 */
const CONTRACT_MARKERS = ['Stay inside your role', 'make it self-contained', 'say exactly what is missing']

/**
 * Fail-fast audit: a persona that lost its contract is not a broken build, it
 * is a child agent that talks too much and reports guesses as findings. Same
 * shape as `auditSymmetry` so both can be checked in one place.
 */
export function auditPersonaContracts(): string[] {
  const problems: string[] = []
  for (const role of Object.values(ROLES)) {
    for (const marker of CONTRACT_MARKERS) {
      if (!role.persona.includes(marker)) {
        problems.push(`${role.name}'s persona is missing "${marker}" (wrap it in withContract)`)
      }
    }
  }
  return problems
}
