import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { MemoryCard, MemoryCardFile, MemoryCardRef, SessionSearchHit } from '../../shared/contract'
import { SKILLS_HOME, listUserSkillDirs, runSkillManage, type SkillOp } from './skillManage'
import {
  MEMORY_HOME,
  applyMemoryWrites,
  cardId,
  listMemoryCards,
  type MemoryWrite,
  type MemoryWriteResult
} from './memoryStore'
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

To correct a card, use update with its id: one write, applied atomically. Prefer
it over remove then add, which can lose the fact if nothing else happens in
between.

Scope a card to a project only when the fact is true of that directory and not
of anywhere else ("this repo pins CMake 3.24"). Unscoped cards are injected
everywhere, so a fact that is not always true costs context and misleads.
`.trim()

const MEMORY_NUDGE = `
Before finishing a substantial task, ask yourself: "did I just learn something
the next session will need?" If yes, persist it now via skill_manage or
memory_manage — do not wait to be asked. Queued cards reach disk automatically
when the run ends; there is nothing to flush by hand.
`.trim()

/**
 * A write accepted during the run but not yet committed to disk.
 *
 * Every kind — add, update, remove — goes through the queue. A mixed batch is
 * the case that breaks if deletes land immediately and edits wait: the run that
 * "corrects" a card would show the user its old text until the turn ended.
 */
interface QueuedWrite {
  write: MemoryWrite
  /**
   * Card ids that must stay invisible to this run. For an update the old id
   * matters: the file still holds the previous text until the batch commits,
   * and showing the agent its own pre-correction version is the self-reference
   * loop this design exists to avoid.
   */
  hides: string[]
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
  /**
   * Working directory of the session being started. Cards scoped to a different
   * one are left out of this run — seeing another project's setup facts is how a
   * memory store becomes noise.
   */
  cwd?: string
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
      const sessionCwd = hooks.cwd ?? ''
      const pending: QueuedWrite[] = []
      /** Ids this session produced, flushed or not — invisible to this session. */
      const sessionCardIds = new Set<string>()
      /**
       * Whether this run has read the skill inventory. `skill_manage` refuses
       * mutations until then: a model that skips the read will happily "create"
       * something that already exists, or patch a file it has never opened.
       * Enforced in code because a refusal in the prompt is a suggestion.
       */
      let inventorySeen = false

      /**
       * Commit the queue; returns how many writes actually landed on disk.
       *
       * Grouping by file here, rather than handing the whole batch to
       * `applyMemoryWrites`, is what keeps `result[i]` aligned with the queued
       * write that produced it — one file is one transaction, and the caller
       * still needs to know which of its own writes took effect.
       */
      const flush = (): number => {
        if (pending.length === 0) return 0
        const batch = pending.splice(0, pending.length)
        let written = 0
        const byFile = new Map<MemoryCardFile, QueuedWrite[]>()
        for (const item of batch) {
          const bucket = byFile.get(item.write.file)
          if (bucket !== undefined) bucket.push(item)
          else byFile.set(item.write.file, [item])
        }
        for (const items of byFile.values()) {
          const outcomes: MemoryWriteResult[] = []
          try {
            outcomes.push(...applyMemoryWrites(items.map((item) => item.write)))
          } catch (err) {
            // Should not happen: the same rules were applied when queued. Treat
            // it as "nothing landed" rather than throwing inside a lifecycle hook.
            console.warn(
              `[self-evolution] memory batch failed to commit: ${err instanceof Error ? err.message : String(err)}`
            )
            continue
          }
          items.forEach((item, i) => {
            if (!outcomes[i]?.changed) return
            written += 1
            for (const id of item.hides) sessionCardIds.add(id)
          })
        }
        return written
      }
      flushers.add(flush)

      const buildMemorySection = async (prompt: string): Promise<string> => {
        const cards = listMemoryCards().filter((card) => card.scope === undefined || card.scope === sessionCwd)
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

      const queuedText = (item: QueuedWrite): string => item.write.text ?? ''

      /** What `prepareWrite` decided about a write the model asked for. */
      type Prepared =
        | { verdict: 'queue'; item: QueuedWrite }
        | { verdict: 'unchanged'; message: string }

      /**
       * Validate a write. The checks run here rather than at commit time because
       * the model is still able to react to them; by `turn_end` there is nobody
       * left to rephrase.
       */
      const prepareWrite = async (write: MemoryWrite): Promise<Prepared> => {
        const onDisk = listMemoryCards().filter((card) => card.file === write.file)

        // A removal has no text to lint or compare, and it is allowed to queue
        // even when the target is already gone: that is how "add X, then change
        // your mind" cancels itself instead of writing X.
        if (write.kind === 'remove') {
          if (write.ref === undefined) {
            throw new Error('remove requires a card reference (id or index)')
          }
          const target =
            typeof write.ref === 'string'
              ? onDisk.find((card) => card.id === write.ref)
              : onDisk[write.ref]
          return {
            verdict: 'queue',
            item: {
              write,
              hides: target !== undefined ? [target.id] : [String(write.ref)],
              warnings: []
            }
          }
        }

        const text = (write.text ?? '').trim().replace(/\s*\r?\n\s*/g, ' ')
        if (text.length === 0) throw new Error('card text must be a non-empty string')
        if (text.length > 2000) throw new Error('card text is too long (max 2000 chars)')

        const lint = lintCard(text)
        const rejection = firstRejection(lint)
        if (rejection !== undefined) {
          throw new Error(`card rejected (${rejection.rule}): ${rejection.message}`)
        }
        const warnings = lint.warnings.map((w) => `${w.rule}: ${w.message}`)
        const id = cardId(text)
        const kept = (): QueuedWrite => ({
          write: { ...write, text },
          hides: [id],
          warnings
        })

        // A duplicate of something the run already has: nothing to queue, and
        // queueing it would be a write that silently changes nothing.
        const alreadyKnown =
          sessionCardIds.has(id) ||
          pending.some((item) => cardId(queuedText(item)) === id) ||
          listMemoryCards().some((card) => card.file === write.file && card.id === id)
        if (alreadyKnown) {
          return {
            verdict: 'unchanged',
            message: `no change — an identical card already exists in ${write.file}: ${text}`
          }
        }

        // An update with no target is a bug in the caller, not something to work
        // around: writing it as a new card would leave the card the model thought
        // it was correcting exactly where it was, plus a second copy of the fact.
        let replaced: string | undefined
        if (write.kind === 'update' && write.ref !== undefined) {
          const target =
            typeof write.ref === 'string'
              ? onDisk.find((card) => card.id === write.ref)
              : onDisk[write.ref]
          if (target === undefined) {
            throw new Error(
              `no card matches ${String(write.ref)} in ${write.file} — use add to create a new card`
            )
          }
          replaced = target.id
        }

        // The card being edited is excluded itself. An edit is by definition
        // near-identical to what it replaces, so leaving it in is a rule that
        // rejects every correction: fixing "MSVC" to "Ninja" would be refused as
        // a duplicate of "MSVC", which is the exact opposite of the intent.
        const existingTexts = [
          ...onDisk.filter((card) => card.id !== replaced).map((card) => card.text),
          ...pending
            .filter(
              (item) =>
                !(item.write.kind === 'update' && item.write.ref === write.ref) &&
                !(item.write.kind === 'remove' && item.write.ref === write.ref)
            )
            .map((item) => queuedText(item))
        ]
        const localDuplicate = findLocalDuplicate(text, existingTexts)
        if (localDuplicate !== undefined) {
          throw new Error(`not written — this restates an existing card: "${existingTexts[localDuplicate]}"`)
        }

        // Rules could not settle it. Only now is a model worth its cost, and it
        // sees a handful of candidates rather than the whole store.
        const candidateHits = candidatesAmong(text, existingTexts)
        if (candidateHits.length > 0 && hooks.judgeDuplicate !== undefined) {
          const candidates = candidateHits.map((hit) => existingTexts[hit.index]!)
          const verdict = await hooks.judgeDuplicate(text, candidates)
          if (verdict !== null && verdict >= 0 && verdict < candidates.length) {
            throw new Error(
              `not written — this says the same as an existing card: "${candidates[verdict]}"`
            )
          }
        }

        const item = kept()
        // Both ids: the file still holds the pre-correction text until the batch
        // commits, so the old one has to be hidden too or this run reads its own
        // previous claim back as a fact it already knew.
        if (replaced !== undefined) item.hides.push(replaced)
        return { verdict: 'queue', item }
      }

      const queueWrite = async (write: MemoryWrite): Promise<string> => {
        const prepared = await prepareWrite(write)
        if (prepared.verdict === 'unchanged') {
          return prepared.message
        }
        const { write: accepted, warnings } = prepared.item
        pending.push(prepared.item)
        const what = accepted.kind === 'add' ? 'card' : accepted.kind
        const shown = accepted.text ?? ''
        const problems = warnings.length > 0 ? `\n⚠ ${warnings.join('\n⚠ ')}` : ''
        const note = pending.length === 1 ? '1 write' : `${pending.length} writes`
        const tail = shown.length > 0 ? `: ${shown}${problems}` : problems
        return `queued ${what} for ${accepted.file} (${note} pending, written when this run ends)${tail}`
      }

      pi.registerTool({
        name: 'skill_manage',
        label: 'Skill manage',
        description:
          'Create, improve, and remove your own skills (procedural memory) under the user skills home. ' +
          'Call action=list FIRST in every run: the tool refuses any write until you have read what already exists. ' +
          'Prefer patch for small fixes; use batch ops for multi-file changes; skills follow ' +
          '"When to Use / Procedure / Pitfalls / Verification" and hold lessons, not logs. ' +
          'Every change is recorded in a persistent undo log the user can revert. ' +
          'Skip it when the knowledge is one-off or session-only, when an existing skill already covers it, ' +
          'or when the user wants the fix applied now rather than something reusable afterwards.',
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
          'add/update/remove are queued and committed when the run ends; cards you write never come back into the same run. ' +
          'update rewrites a card in one atomic write — use it instead of remove+add. ' +
          'Skip it for session-only details and for anything that expires (a current version, an open bug, ' +
          'today\'s numbers): a card is re-injected into every future run, so a stale one outlives the fact it described.',
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
              const queued = pending.map((item) => `[queued ${item.write.kind} ${item.write.file}] ${item.write.text ?? ''}`)
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
              return textResult(await queueWrite({ kind: 'add', file, text, scope: scopeOf(params) }))
            }
            if (action === 'update') {
              const text = typeof params.text === 'string' ? params.text : ''
              const ref = cardRef(params)
              if (ref === undefined) {
                return textResult('memory_manage update requires id (preferred) or index')
              }
              if (text.length === 0) {
                return textResult('memory_manage update requires text')
              }
              return textResult(
                await queueWrite({ kind: 'update', file, text, ref, scope: scopeOf(params) })
              )
            }
            if (action === 'remove') {
              const ref = cardRef(params)
              if (ref === undefined) {
                return textResult('memory_manage remove requires id (preferred) or index')
              }
              // A queued write against the same card is cancelled rather than
              // queued on top: remove wins, and the pending edit never lands.
              const hit = pending.findIndex(
                (item) =>
                  (item.write.kind === 'remove' || item.write.kind === 'update') &&
                  item.write.ref === ref
              )
              if (hit >= 0) {
                const dropped = pending[hit]!
                pending.splice(hit, 1)
                return textResult(
                  `dropped the queued ${dropped.write.kind} against ${String(ref)} — removed instead, never reached disk`
                )
              }
              return textResult(await queueWrite({ kind: 'remove', file, ref }))
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

/** Optional scope from a tool call; absent means "applies to any working directory". */
function scopeOf(params: Record<string, unknown>): string | undefined {
  return typeof params.scope === 'string' && params.scope.length > 0 ? params.scope : undefined
}

/** Card reference from a tool call: `id` when present, otherwise `index`. */
function cardRef(params: Record<string, unknown>): MemoryCardRef | undefined {
  const id = typeof params.id === 'string' && params.id.length > 0 ? params.id : undefined
  if (id !== undefined) return id
  const index = Number(params.index)
  return params.index === undefined || !Number.isFinite(index) ? undefined : index
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
      enum: ['list', 'add', 'update', 'remove', 'flush'],
      description:
        'list: show all cards (stored + queued). add: queue a card, committed when the run ends. update: correct an existing card in one atomic write — prefer this over remove+add, which can lose the fact if the run dies between them. remove: delete by id (preferred, from list) or index. flush: commit queued writes now.'
    },
    file: {
      type: 'string',
      enum: ['MEMORY', 'USER'],
      description: 'MEMORY = project/environment facts. USER = who the user is and how they work.'
    },
    text: { type: 'string', description: 'add/update: one concise fact (single line, ≤2000 chars).' },
    scope: {
      type: 'string',
      description:
        'add/update: only inject this card in sessions whose working directory is this path. Omit for a fact that holds everywhere — a wrong scope is a fact the next session can never see.'
    },
    id: { type: 'string', description: 'update/remove: stable card id shown by list. Survives other removals; prefer it over index.' },
    index: { type: 'number', description: 'update/remove: fallback 0-based position from list.' }
  },
  required: ['action']
}

export { DUPLICATE_THRESHOLD } from './memoryDedupe'
export { listUserSkillDirs, SKILLS_HOME }
