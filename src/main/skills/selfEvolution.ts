import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { MemoryCard, MemoryCardFile, SessionSearchHit } from '../../shared/contract'
import { SKILLS_HOME, listUserSkillDirs, runSkillManage, type SkillOp } from './skillManage'
import { MEMORY_HOME, addMemoryCard, cardId, listMemoryCards, removeMemoryCard } from './memoryStore'
import { firstRejection, lintCard } from './memoryLint'
import { candidatesAmong, findLocalDuplicate } from './memoryDedupe'

/**
 * Self-evolution extension (Hermes-aligned, M1/M3; memory hardened in v1.10).
 *
 * Gives the agent two tools over its own durable memory and injects curated
 * memory into the system prompt every turn:
 * - `skill_manage`  — create/patch/delete skills under `~/.flexagent/skills`
 *   (batch-atomic, advisory-linted, optionally approval-gated).
 * - `memory_manage` — curated MEMORY.md/USER.md cards.
 *
 * Prompt rules follow Hermes' "lessons, not logs": record a skill when a
 * multi-step workflow proved reusable, a dead end was escaped, or the user
 * corrected the approach — never write incident logs.
 *
 * Two memory-write properties are enforced here rather than requested in the
 * prompt, because the model cannot reliably hold either one itself:
 *
 * 1. **Writes are deferred to the end of the run.** `before_agent_start` fires
 *    every turn and re-reads the store, so a card written mid-run returns next
 *    turn as an established fact and the model starts citing itself. The tool
 *    queues; `turn_end` commits. State lives in the factory closure, which PI
 *    builds per session — that is what makes "hide what this session wrote"
 *    possible even though the event carries no session identity.
 * 2. **Injection is budgeted.** Every injected card costs context on every
 *    later turn; unbounded injection is how a memory store becomes a tax.
 */

/** Cards injected per turn. Past this, a card is cheaper to fetch on demand. */
const MAX_INJECTED_CARDS = 40

/** Past-session hits injected as short-term context for the current prompt. */
const MAX_RECALL_HITS = 5

/** Shorter than this, a prompt carries too little signal to search history with. */
const RECALL_MIN_PROMPT = 8

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
conventions, environment paths. Cards describe the user and the project — not
your own behaviour, not what the system prompt already says, not run state that
is false tomorrow. Never store secrets: cards are plain text and injected into
every turn. Periodically check whether your cards are still true and prune stale
ones.

Cards are queued and written when the run ends, and nothing you write during a
run is injected back into that same run. That is deliberate — it keeps you from
treating what you just said as an established fact from an earlier session.
`.trim()

const MEMORY_NUDGE = `
Before finishing a substantial task, ask yourself: "did I just learn something
the next session will need?" If yes, persist it now via skill_manage or
memory_manage — do not wait to be asked. Queued cards reach disk automatically
when the run ends; there is nothing to flush by hand.
`.trim()

/** A write accepted during the run but not yet committed to disk. */
interface PendingWrite {
  file: MemoryCardFile
  text: string
  id: string
  warnings: string[]
}

/**
 * Deciding duplicates is the model's job, so the call lives outside this file:
 * given candidates the rules could not settle, return the index of the
 * duplicate, or null for "new". Returning null on trouble is correct — an
 * unavailable judge should cost a duplicate card, never a lost fact.
 */
export type MemoryDuplicateJudge = (
  newText: string,
  candidates: string[],
  signal?: AbortSignal
) => Promise<number | null>

export interface SelfEvolutionHooks {
  /** Called after skills actually changed on disk (not staged). */
  onSkillsChanged?: () => void
  /** Optional semantic duplicate judge; absent ⇒ rule-based dedupe only. */
  judgeDuplicate?: MemoryDuplicateJudge
  /** Short-term memory: past sessions relevant to this turn's prompt. */
  recallHistory?: (prompt: string, limit: number) => Promise<SessionSearchHit[]>
}

/**
 * Every live instance registers its committer. A disposed session never gets a
 * `turn_end`, and quietly losing cards because the user switched chats is
 * exactly how a memory store stops being trusted.
 */
const flushers = new Set<() => void>()

export function flushPendingMemoryWrites(): void {
  for (const flush of [...flushers]) flush()
}

function renderCards(entries: MemoryCard[]): string {
  return entries.map((card) => `- ${card.text}`).join('\n')
}

function buildRecalledSection(hits: SessionSearchHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits.map((hit) => {
    const when = new Date(hit.updatedAt).toISOString().slice(0, 10)
    return `- [${when}] ${hit.title} — ${hit.snippet}`
  })
  return (
    `\n### Previously discussed (earlier sessions, read-only)\n${lines.join('\n')}\n` +
    'These are excerpts from other sessions, not current state — open the session before acting.\n'
  )
}

export function createSelfEvolutionExtension(hooks: SelfEvolutionHooks = {}): InlineExtension {
  return {
    name: 'flex-self-evolution',
    factory: (pi: ExtensionAPI): void => {
      const pending: PendingWrite[] = []
      /** Ids this session produced, flushed or not — invisible to this session. */
      const sessionCardIds = new Set<string>()
      /**
       * Whether this run has read the skill inventory. `skill_manage` refuses
       * mutations until then: a model that skips the read will happily "create"
       * something that already exists, or patch a file it has never opened.
       * Enforced in code because a refusal in the prompt is a suggestion.
       */
      let inventorySeen = false

      /** Commit the queue; returns how many actually landed on disk. */
      const flush = (): number => {
        if (pending.length === 0) return 0
        const batch = pending.splice(0, pending.length)
        let written = 0
        for (const item of batch) {
          try {
            const result = addMemoryCard(item.file, item.text)
            sessionCardIds.add(result.id)
            written += 1
          } catch (err) {
            // Already checked when queued, so this is the "disk changed under
            // us" path. Drop it rather than throwing inside a lifecycle hook.
            console.warn(
              `[self-evolution] queued card failed to commit: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
        return written
      }
      flushers.add(flush)

      const buildMemorySection = async (prompt: string): Promise<string> => {
        const cards = listMemoryCards()
        // Cut the self-reinforcement loop: whatever this session produced stays
        // invisible to it, for as many turns as the run takes.
        const foreign = cards.filter((card) => !sessionCardIds.has(card.id))
        const memory = foreign.filter((card) => card.file === 'MEMORY')
        const user = foreign.filter((card) => card.file === 'USER')

        let body = ''
        // USER.md is small and always relevant: it shapes tone, not just facts.
        if (user.length > 0) {
          body += `\n### User profile (USER.md)\n${renderCards(user.slice(-MAX_INJECTED_CARDS))}`
        }
        if (memory.length > 0) {
          // Newest within budget — the store is append-only, and recent cards
          // describe the project as it is now.
          const shown = memory.slice(-MAX_INJECTED_CARDS)
          const hidden = memory.length - shown.length
          body += `\n### Project & environment facts (MEMORY.md)\n${renderCards(shown)}`
          if (hidden > 0) {
            body += `\n(${hidden} older card${hidden === 1 ? '' : 's'} omitted — memory_manage list shows all)`
          }
        }
        if (foreign.length > 0) body += '\n'

        let recalled = ''
        if (prompt.trim().length >= RECALL_MIN_PROMPT && hooks.recallHistory !== undefined) {
          try {
            recalled = buildRecalledSection(await hooks.recallHistory(prompt, MAX_RECALL_HITS))
          } catch {
            // Short-term recall is a bonus; failure must not cost the turn.
            recalled = ''
          }
        }

        const header =
          foreign.length > 0 ? `\n## Current memory cards (from ${MEMORY_HOME.replace(/\\/g, '/')})` : ''
        return `${SELF_EVOLUTION_RULES}\n${header}${body}${recalled}\n${MEMORY_NUDGE}`
      }

      const queueCard = async (file: MemoryCardFile, rawText: string): Promise<string> => {
        const text = rawText.trim().replace(/\s*\r?\n\s*/g, ' ')
        if (text.length === 0) throw new Error('card text must be a non-empty string')
        if (text.length > 2000) throw new Error('card text is too long (max 2000 chars)')

        // Reject here, not at commit time — the model is still around to rephrase.
        const lint = lintCard(text)
        const rejection = firstRejection(lint)
        if (rejection !== undefined) {
          throw new Error(`card rejected (${rejection.rule}): ${rejection.message}`)
        }
        const warnings = lint.warnings.map((w) => `${w.rule}: ${w.message}`)

        const id = cardId(text)
        if (sessionCardIds.has(id) || pending.some((item) => item.id === id)) {
          return 'identical card already queued this session — no change'
        }
        const onDisk = listMemoryCards().filter((card) => card.file === file)
        if (onDisk.some((card) => card.id === id)) {
          return 'identical card already exists — no change'
        }

        const existingTexts = [
          ...onDisk.map((card) => card.text),
          ...pending.map((item) => item.text)
        ]
        const localDuplicate = findLocalDuplicate(text, existingTexts)
        if (localDuplicate !== undefined) {
          return `not written — this restates an existing card: "${existingTexts[localDuplicate]}"`
        }

        // Rules could not settle it. Only now is a model worth its cost, and it
        // sees a handful of candidates rather than the whole store.
        const candidateHits = candidatesAmong(text, existingTexts)
        if (candidateHits.length > 0 && hooks.judgeDuplicate !== undefined) {
          const candidates = candidateHits.map((hit) => existingTexts[hit.index]!)
          const verdict = await hooks.judgeDuplicate(text, candidates)
          if (verdict !== null && verdict >= 0 && verdict < candidates.length) {
            return `not written — this says the same as an existing card: "${candidates[verdict]}"`
          }
        }

        pending.push({ file, text, id, warnings })
        const problems = warnings.length > 0 ? `\n⚠ ${warnings.join('\n⚠ ')}` : ''
        const note = pending.length === 1 ? '1 card' : `${pending.length} cards`
        return `queued for ${file} (${note} pending, written when this run ends): ${text}${problems}`
      }

      pi.registerTool({
        name: 'skill_manage',
        label: 'Skill manage',
        description:
          'Create, improve, and remove your own skills (procedural memory) under the user skills home. ' +
          'Call action=list FIRST in every run: the tool refuses any write until you have read what already exists. ' +
          'Prefer patch for small fixes; use batch ops for multi-file changes; skills follow ' +
          '"When to Use / Procedure / Pitfalls / Verification" and hold lessons, not logs. ' +
          'Every change is recorded in a persistent undo log the user can revert.',
        promptSnippet:
          'skill_manage: create/patch/delete skills (procedural memory) — record reusable workflows and fixes',
        promptGuidelines: [
          'After escaping an error or dead end, or when the user corrects your approach, record the working path with skill_manage (lessons, not logs).',
          'Start each run with skill_manage {action: "list"} so you know what already exists — writes are refused without it, and duplicate skills are the usual result of skipping it.'
        ],
        parameters: SKILL_MANAGE_SCHEMA,
        execute: async (_toolCallId, rawParams) => {
          const params =
            rawParams !== null && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {}
          const ops: SkillOp[] = Array.isArray(params.ops)
            ? (params.ops as SkillOp[])
            : [{ ...params, action: typeof params.action === 'string' ? params.action : 'list' } as SkillOp]
          try {
            const outcome = runSkillManage(ops, { stateReady: () => inventorySeen })
            if (outcome.applied.some((line) => line.action === 'list')) inventorySeen = true
            if (outcome.stagedId === undefined) hooks.onSkillsChanged?.()
            const lines = outcome.applied.map(
              (line) =>
                `- ${line.action} ${line.skill}: ${line.message}${line.warning !== undefined ? `\n  ⚠ ${line.warning}` : ''}`
            )
            if (outcome.undoId !== undefined) {
              lines.push(`\nrecorded in the undo log (${outcome.undoId}) — the user can revert this after a restart`)
            }
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
          'Read and maintain your persistent memory cards (declarative memory): project/environment facts (MEMORY) and the user profile (USER). ' +
          'Writes are queued and committed when the run ends; cards you write never come back into the same run.',
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
              const lines = cards.map((card) => `[${card.file}#${card.index} id=${card.id}] ${card.text}`)
              const queued = pending.map((item) => `[queued ${item.file}] ${item.text}`)
              if (lines.length === 0 && queued.length === 0) return textResult('No memory cards yet.')
              return textResult(
                [...lines, ...(queued.length > 0 ? ['', '— pending this run —', ...queued] : [])].join('\n')
              )
            }
            if (file === undefined) {
              return textResult('memory_manage add/remove requires file = MEMORY or USER')
            }
            if (action === 'add') {
              const text = typeof params.text === 'string' ? params.text : ''
              return textResult(await queueCard(file, text))
            }
            if (action === 'remove') {
              const id = typeof params.id === 'string' && params.id.length > 0 ? params.id : undefined
              if (id !== undefined) {
                const hit = pending.findIndex((item) => item.id === id)
                if (hit >= 0) {
                  pending.splice(hit, 1)
                  return textResult(`dropped queued card ${id} (never reached disk)`)
                }
              }
              const asIndex = Number(params.index)
              const ref = id ?? (Number.isFinite(asIndex) ? asIndex : -1)
              if (typeof ref === 'number' && ref < 0) {
                return textResult('memory_manage remove requires id (preferred) or index')
              }
              removeMemoryCard(file, ref)
              if (typeof ref === 'string') sessionCardIds.delete(ref)
              return textResult(`removed ${file} card ${ref}`)
            }
            if (action === 'flush') {
              const written = flush()
              return textResult(written === 0 ? 'nothing queued' : `committed ${written} card(s) to disk`)
            }
            return textResult(`unknown memory_manage action: ${action}`)
          } catch (err) {
            return textResult(`memory_manage failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      })

      pi.on('before_agent_start', async (event) => {
        return { systemPrompt: `${event.systemPrompt}\n\n${await buildMemorySection(event.prompt)}` }
      })

      // Commit once the turn is finished. Mid-turn writes would be read back as
      // history on every later turn; a finished turn has earned that.
      pi.on('turn_end', () => {
        flush()
        return undefined
      })

      pi.on('session_shutdown', () => {
        flush()
        flushers.delete(flush)
        return undefined
      })
    }
  }
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }>; details: undefined } {
  return { content: [{ type: 'text', text }], details: undefined }
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
      enum: ['list', 'add', 'remove', 'flush'],
      description:
        'list: show all cards (stored + queued). add: queue a card, committed when the run ends. remove: delete by id (preferred, from list) or index. flush: commit queued cards now.'
    },
    file: {
      type: 'string',
      enum: ['MEMORY', 'USER'],
      description: 'MEMORY = project/environment facts. USER = who the user is and how they work.'
    },
    text: { type: 'string', description: 'add: one concise fact (single line, ≤2000 chars).' },
    id: { type: 'string', description: 'remove: stable card id shown by list. Survives other removals; prefer it over index.' },
    index: { type: 'number', description: 'remove: fallback 0-based position from list.' }
  },
  required: ['action']
}

export { DUPLICATE_THRESHOLD } from './memoryDedupe'
export { listUserSkillDirs, SKILLS_HOME }
