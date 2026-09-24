import type {
  ExtensionAPI,
  InlineExtension
} from '@earendil-works/pi-coding-agent'
import {
  SKILLS_HOME,
  listUserSkillDirs,
  runSkillManage,
  type SkillOp
} from './skillManage'
import { addMemoryCard, listMemoryCards, removeMemoryCard } from './memoryStore'
import { MEMORY_HOME } from './memoryStore'

/**
 * Self-evolution extension (Hermes-aligned, M1/M3).
 *
 * Gives the agent two procedural-memory tools and injects curated memory into
 * the system prompt every turn:
 * - `skill_manage`  — create/patch/delete skills under `~/.flexagent/skills`
 *   (batch-atomic, advisory-linted, optionally approval-gated).
 * - `memory_manage` — curated MEMORY.md/USER.md cards.
 *
 * Prompt rules follow Hermes' "lessons, not logs": record a skill when a
 * multi-step workflow proved reusable, a dead end was escaped, or the user
 * corrected the approach — never write incident logs.
 */

const SELF_EVOLUTION_RULES = `
## Persistent memory & self-improvement (FlexAgent)

You own two durable memories and must keep them current:

1. **Skills** (procedural memory) — \`skill_manage\` maintains reusable
   step-by-step recipes in ${SKILLS_HOME.replace(/\\/g, '/')}.
2. **Memory cards** (declarative memory) — \`memory_manage\` maintains small
   persistent facts about the project and the user.

Use \`skill_manage\` when ANY of these happens:
- You found a multi-step workflow worth repeating.
- You hit an error or dead end and then found the working path.
- The user corrected how you did something.

Content rules ("lessons, not logs"):
- Write generalized rules plus one sentence of *why* (the mechanism) — never
  incident narratives, PR/issue numbers, dates, or chat quotes.
- Structure: When to Use → Procedure → Pitfalls → Verification.
- Never restate what is already loaded every turn (system prompt, tool docs).

Use \`memory_manage\` when you learn a durable fact: user preferences, project
conventions, environment paths. Do not store transient state, secrets, or
anything already in AGENTS.md. Periodically check whether your cards are still
true and prune stale ones.
`.trim()

const MEMORY_NUDGE = `
Before finishing a substantial task, ask yourself: "did I just learn something
the next session will need?" If yes, persist it now via skill_manage or
memory_manage — do not wait to be asked.
`.trim()

function buildMemorySection(): string {
  const cards = listMemoryCards()
  const memory = cards.filter((card) => card.file === 'MEMORY')
  const user = cards.filter((card) => card.file === 'USER')
  const render = (title: string, entries: typeof memory, file: string): string => {
    if (entries.length === 0) return ''
    const lines = entries.map((card) => `- ${card.text}`)
    return `\n### ${title} (${file})\n${lines.join('\n')}`
  }
  const body =
    render('Project & environment facts', memory, 'MEMORY.md') +
    render('User profile', user, 'USER.md')
  if (body.length === 0) {
    return `${SELF_EVOLUTION_RULES}\n\n${MEMORY_NUDGE}`
  }
  return (
    `${SELF_EVOLUTION_RULES}\n` +
    `\n## Current memory cards (from ${MEMORY_HOME.replace(/\\/g, '/')})\n` +
    body +
    `\n\n${MEMORY_NUDGE}`
  )
}

const SKILL_MANAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'patch', 'delete', 'write_file', 'remove_file', 'list'],
      description:
        'create: new skill from full SKILL.md content. patch: targeted oldString→newString edit (preferred) or full rewrite via content. delete: remove a skill. write_file/remove_file: manage references/ and other support files. list: list user skills.'
    },
    name: { type: 'string', description: 'Skill slug (lowercase letters, digits, . _ -). Required for everything except list.' },
    category: { type: 'string', description: 'Optional category directory grouping the skill.' },
    content: { type: 'string', description: 'create / full-rewrite slot: the complete SKILL.md (YAML frontmatter with name + description, then body).' },
    oldString: { type: 'string', description: 'patch slot: exact text to replace (must match exactly once).' },
    newString: { type: 'string', description: 'patch slot: replacement text (required together with oldString).' },
    filePath: { type: 'string', description: 'write_file/remove_file: path relative to the skill directory (e.g. references/api.md).' },
    fileContent: { type: 'string', description: 'write_file slot: full file content.' },
    ops: {
      type: 'array',
      description:
        'Batch mode: multiple skill operations applied atomically. Each op is an object with action + that action\'s own fields. One invalid op rejects the whole batch. Use this instead of several sequential calls.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'patch', 'delete', 'write_file', 'remove_file'] },
          name: { type: 'string' },
          category: { type: 'string' },
          content: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' },
          filePath: { type: 'string' },
          fileContent: { type: 'string' }
        },
        required: ['action']
      }
    }
  },
  required: ['action']
}

const MEMORY_MANAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'remove'],
      description: 'list: show all cards. add: append a card. remove: delete a card by index (from list).'
    },
    file: {
      type: 'string',
      enum: ['MEMORY', 'USER'],
      description: 'MEMORY = project/environment facts. USER = who the user is and how they work.'
    },
    text: { type: 'string', description: 'add: one concise fact (single line, ≤2000 chars).' },
    index: { type: 'number', description: 'remove: card index from list (0-based).' }
  },
  required: ['action']
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }>; details: undefined } {
  return { content: [{ type: 'text', text }], details: undefined }
}

export interface SelfEvolutionHooks {
  /**
   * Called after skills actually changed on disk (not staged). The worker
   * clears its cached resource loaders so the next attach sees new skills.
   */
  onSkillsChanged?: () => void
}

export function createSelfEvolutionExtension(hooks: SelfEvolutionHooks = {}): InlineExtension {
  return {
    name: 'flex-self-evolution',
    factory: (pi: ExtensionAPI): void => {
      pi.registerTool({
        name: 'skill_manage',
        label: 'Skill manage',
        description:
          'Create, improve, and remove your own skills (procedural memory) under the user skills home. ' +
          'Prefer patch for small fixes; use batch ops for multi-file changes; skills follow ' +
          '"When to Use / Procedure / Pitfalls / Verification" and hold lessons, not logs.',
        promptSnippet:
          'skill_manage: create/patch/delete skills (procedural memory) — record reusable workflows and fixes',
        promptGuidelines: [
          'After escaping an error or dead end, or when the user corrects your approach, record the working path with skill_manage (lessons, not logs).'
        ],
        parameters: SKILL_MANAGE_SCHEMA,
        execute: async (_toolCallId, rawParams) => {
          const params =
            rawParams !== null && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {}
          const ops: SkillOp[] = Array.isArray(params.ops)
            ? (params.ops as SkillOp[])
            : [{ ...params, action: typeof params.action === 'string' ? params.action : 'list' } as SkillOp]
          try {
            const outcome = runSkillManage(ops)
            if (outcome.stagedId === undefined) hooks.onSkillsChanged?.()
            const lines = outcome.applied.map(
              (line) => `- ${line.action} ${line.skill}: ${line.message}${line.warning !== undefined ? `\n  ⚠ ${line.warning}` : ''}`
            )
            return textResult(lines.join('\n'))
          } catch (err) {
            return textResult(`skill_manage failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      })

      pi.registerTool({
        name: 'memory_manage',
        label: 'Memory manage',
        description:
          'Read and maintain your persistent memory cards (declarative memory): project/environment facts (MEMORY) and the user profile (USER). Cards are injected into your system prompt every turn.',
        promptSnippet:
          'memory_manage: maintain persistent MEMORY/USER fact cards injected into every session',
        parameters: MEMORY_MANAGE_SCHEMA,
        execute: async (_toolCallId, rawParams) => {
          const params =
            rawParams !== null && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {}
          const action = typeof params.action === 'string' ? params.action : 'list'
          const file = params.file === 'USER' ? 'USER' : params.file === 'MEMORY' ? 'MEMORY' : undefined
          try {
            if (action === 'list') {
              const cards = listMemoryCards()
              if (cards.length === 0) return textResult('No memory cards yet.')
              const lines = cards.map((card) => `[${card.file}#${card.index}] ${card.text}`)
              return textResult(lines.join('\n'))
            }
            if (file === undefined) {
              return textResult('memory_manage add/remove requires file = MEMORY or USER')
            }
            if (action === 'add') {
              const text = typeof params.text === 'string' ? params.text : ''
              const card = addMemoryCard(file, text)
              return textResult(card.index >= 0 ? `added ${file}#${card.index}: ${card.text}` : 'identical card already exists — no change')
            }
            // remove
            const index = typeof params.index === 'number' ? params.index : Number(params.index)
            removeMemoryCard(file, Number.isFinite(index) ? index : -1)
            return textResult(`removed ${file}#${index}`)
          } catch (err) {
            return textResult(`memory_manage failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      })

      // Fresh memory every turn without touching the loader cache: the handler
      // sees the current system prompt and appends a stable memory section.
      pi.on('before_agent_start', (event) => {
        return { systemPrompt: `${event.systemPrompt}\n\n${buildMemorySection()}` }
      })
    }
  }
}

export { listUserSkillDirs, SKILLS_HOME }
