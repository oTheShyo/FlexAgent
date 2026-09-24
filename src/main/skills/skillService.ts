import type { SkillSummary } from '../../shared/contract'
import type { PluginService } from '../plugins'
import { listUserSkillDirs } from './skillManage'
import { readProvenance } from './skillProvenance'

/**
 * Global skill listing for the Skills page (v1.7).
 *
 * Combines the two sources the UI can enumerate without a session attached:
 * - user-level skills written by the agent (`~/.flexagent/skills`)
 * - skills bundled in enabled plugins (already projected by the plugin system)
 *
 * Project-local skills (`<cwd>/skills`, PI includeDefaults) are intentionally
 * per-session and only appear in the kernel's own skill list.
 */
export function listSkills(plugins: PluginService): SkillSummary[] {
  const out: SkillSummary[] = []
  for (const skill of listUserSkillDirs()) {
    const provenance = readProvenance(skill.dir)
    out.push({
      name: skill.name,
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      source: 'user',
      path: skill.dir,
      ...(provenance !== undefined ? { provenance } : {})
    })
  }
  for (const plugin of plugins.list()) {
    if (!plugin.enabled) continue
    try {
      const detail = plugins.get(plugin.id)
      for (const component of detail.components) {
        if (component.kind !== 'skill') continue
        out.push({
          name: component.name,
          ...(component.description !== undefined ? { description: component.description } : {}),
          source: 'plugin',
          path: component.path ?? '',
          pluginId: plugin.id
        })
      }
    } catch {
      // A broken plugin must not take the whole listing down.
      continue
    }
  }
  return out.sort(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)
  )
}
