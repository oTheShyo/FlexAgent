import { statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { SKILL_STALE_AFTER_MS, type SkillUsageEntry, type SkillUsageSource } from '../../shared/contract'
import { listSkillHistory } from './skillHistory'
import { SKILLS_HOME, listUserSkillDirs } from './skillManage'

/**
 * When each skill was last written — the input to pruning.
 *
 * "Never used" is the one signal a skill store needs that nothing here can
 * measure directly: the kernel loads skills into the prompt, and it does not
 * report which ones were read. What *is* observable is the other half of the
 * same question — a skill nobody has touched since the day it was installed is
 * very likely a skill nobody runs. That is a heuristic, and it is labelled as
 * one: the UI offers cleanup, it does not delete on the user's behalf.
 *
 * Two sources, unioned:
 * - the undo log, which is the only record of what the agent did, and the only
 *   place the *creation* time of a hand-written skill can come from;
 * - file mtimes, which cover skills installed straight from a hub and never
 *   edited since.
 */

/** A skill untouched for this long is worth looking at. See the contract's copy. */
export const STALE_AFTER_MS = SKILL_STALE_AFTER_MS

/** Reading the whole log is fine: it is capped at a few MB and parsed here. */
const HISTORY_LIMIT = 1000

/**
 * `name` for a mutable skill, and where its SKILL.md lives.
 *
 * Paths recorded by the undo log may sit under a category directory, so the
 * skill name is taken from the deepest directory that holds a SKILL.md rather
 * than from the top-level layout.
 */
function skillNameOf(path: string): string {
  const parent = dirname(path)
  return basename(parent).length > 0 ? basename(parent) : 'SKILL.md'
}

/** Directory holding the SKILL.md for anything the log mentions. */
function ownerOf(path: string): string {
  return path.endsWith('SKILL.md') ? path.slice(0, -'SKILL.md'.length) : path
}

export function listSkillUsage(): SkillUsageEntry[] {
  const byName = new Map<string, { created?: number; touched: number; source: SkillUsageSource }>()

  const record = (name: string, at: number, source: SkillUsageSource): void => {
    const seen = byName.get(name)
    if (seen === undefined) {
      byName.set(name, { created: at, touched: at, source })
      return
    }
    if (seen.created === undefined) seen.created = at
    else seen.created = Math.min(seen.created, at)
    seen.touched = Math.max(seen.touched, at)
    if (source === 'history') seen.source = source
  }

  for (const entry of listSkillHistory(HISTORY_LIMIT)) {
    for (const change of entry.changes) {
      record(skillNameOf(change.path), entry.at, 'history')
    }
  }

  // Only `name` and `dir` are read from the discovery result. Anything else on
  // it belongs to whoever maintains that listing, and depending on a field that
  // is not in HEAD turns this page into a build that only compiles once someone
  // else has landed theirs.
  for (const skill of listUserSkillDirs()) {
    let modified = 0
    try {
      modified = statSync(join(skill.dir, 'SKILL.md')).mtimeMs
    } catch {
      continue
    }
    record(skill.name, modified, 'filesystem')
  }

  const out: SkillUsageEntry[] = []
  for (const [name, info] of byName) {
    out.push({
      name,
      touchedAt: info.touched,
      source: info.source,
      ...(info.created !== undefined ? { createdAt: info.created } : {})
    })
  }
  return out.sort((a, b) => a.touchedAt - b.touchedAt)
}

/** Skills not written for a long time, oldest first. */
export function staleSkills(now = Date.now(), windowMs = STALE_AFTER_MS): SkillUsageEntry[] {
  return listSkillUsage().filter((entry) => now - entry.touchedAt > windowMs)
}

export { SKILLS_HOME }
