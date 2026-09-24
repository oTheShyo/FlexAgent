export const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g

export class HookInterpolationError extends Error {}

export interface HookTemplatePlugin {
  rootPath: string
  dataPath: string
  id: string
  name: string
}

export interface HookTemplateContext {
  values: Record<string, string | number | boolean>
  sensitiveKeys?: string[]
  plugin?: HookTemplatePlugin
  projectDir?: string
}

export function resolveUserConfigValues(
  decl: Record<string, { default?: string | number | boolean }> | undefined,
  configured: Record<string, string | number | boolean> | undefined
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, entry] of Object.entries(decl ?? {})) {
    const configuredValue = configured?.[key]
    const value = configuredValue !== undefined ? configuredValue : entry.default
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(configured ?? {})) {
    if (out[key] === undefined) out[key] = value
  }
  return out
}

function pluginVariableReplacement(name: string, context: HookTemplateContext): string | undefined {
  const plugin = context.plugin
  switch (name) {
    case 'CLAUDE_PLUGIN_ROOT':
    case 'ZCODE_PLUGIN_ROOT':
    case 'FLEX_PLUGIN_ROOT':
      return plugin?.rootPath
    case 'CLAUDE_PLUGIN_DATA':
    case 'ZCODE_PLUGIN_DATA':
    case 'FLEX_PLUGIN_DATA':
      return plugin?.dataPath
    case 'ZCODE_PLUGIN_ID':
    case 'FLEX_PLUGIN_ID':
      return plugin?.id
    case 'ZCODE_PLUGIN_NAME':
    case 'FLEX_PLUGIN_NAME':
      return plugin?.name
    case 'CLAUDE_PROJECT_DIR':
    case 'ZCODE_PROJECT_DIR':
    case 'FLEX_PROJECT_DIR':
      return context.projectDir
    default:
      return undefined
  }
}

export function interpolateHookTemplate(value: string, context: HookTemplateContext): string {
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => {
    if (name.startsWith('user_config.') || name.startsWith('userConfig.')) {
      const key = name.startsWith('user_config.')
        ? name.slice('user_config.'.length)
        : name.slice('userConfig.'.length)
      if (context.sensitiveKeys?.includes(key) === true) {
        throw new HookInterpolationError(
          `Sensitive plugin user_config value cannot be used in this field: ${key}`
        )
      }
      const configValue = context.values[key]
      if (configValue === undefined) {
        throw new HookInterpolationError(`Missing plugin user_config value: ${key}`)
      }
      return String(configValue)
    }
    if (name === 'CLAUDE_SKILL_DIR' || name === 'ZCODE_SKILL_DIR' || name === 'FLEX_SKILL_DIR') {
      throw new HookInterpolationError(`Hook variable requires a skill context: ${name}`)
    }
    if (
      name === 'CLAUDE_CODE_SESSION_ID' ||
      name === 'CLAUDE_SESSION_ID' ||
      name === 'ZCODE_SESSION_ID' ||
      name === 'FLEX_SESSION_ID'
    ) {
      throw new HookInterpolationError(`Hook variable requires a runtime session context: ${name}`)
    }
    const replacement = pluginVariableReplacement(name, context)
    if (replacement !== undefined) return replacement
    return match
  })
}

export function interpolateHookArgs(
  args: string[],
  context: HookTemplateContext
): string[] {
  return args.map((arg) => interpolateHookTemplate(arg, context))
}
