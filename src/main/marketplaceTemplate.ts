const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g

export class PluginVariableError extends Error {}

export interface PluginTemplateUserConfigEntry {
  default?: string | number | boolean
  sensitive?: boolean
}

export interface PluginTemplateContext {
  dataPath: string
  env: Record<string, string | undefined>
  rootPath: string
  options: Record<string, string | number | boolean>
  userConfig: Record<string, PluginTemplateUserConfigEntry> | undefined
  workingDirectory: string
}

export function getUserConfigDefaults(
  userConfig: Record<string, PluginTemplateUserConfigEntry> | undefined
): Record<string, string | number | boolean> {
  const defaults: Record<string, string | number | boolean> = {}
  for (const [key, option] of Object.entries(userConfig ?? {})) {
    if (
      typeof option.default === 'string' ||
      typeof option.default === 'number' ||
      typeof option.default === 'boolean'
    ) {
      defaults[key] = option.default
    }
  }
  return defaults
}

export function resolveTemplate(
  value: string,
  context: PluginTemplateContext,
  options: { allowSensitive: boolean }
): string {
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => {
    switch (name) {
      case 'CLAUDE_PLUGIN_ROOT':
      case 'ZCODE_PLUGIN_ROOT':
      case 'FLEX_PLUGIN_ROOT':
        return context.rootPath
      case 'CLAUDE_PLUGIN_DATA':
      case 'ZCODE_PLUGIN_DATA':
      case 'FLEX_PLUGIN_DATA':
        return context.dataPath
      case 'CLAUDE_PROJECT_DIR':
      case 'ZCODE_PROJECT_DIR':
      case 'FLEX_PROJECT_DIR':
        return context.workingDirectory
      case 'CLAUDE_CODE_SESSION_ID':
      case 'CLAUDE_SESSION_ID':
      case 'ZCODE_SESSION_ID':
        throw new PluginVariableError(
          `Plugin variable requires a runtime session context: ${name}`
        )
      case 'CLAUDE_SKILL_DIR':
      case 'ZCODE_SKILL_DIR':
        throw new PluginVariableError(`Plugin variable requires a skill context: ${name}`)
      default:
        break
    }

    if (name.startsWith('user_config.')) {
      const key = name.slice('user_config.'.length)
      if (context.userConfig?.[key]?.sensitive === true && !options.allowSensitive) {
        throw new PluginVariableError(
          `Sensitive plugin user_config value cannot be used in this field: ${key}`
        )
      }
      const defaults = getUserConfigDefaults(context.userConfig)
      const configValue = context.options[key] ?? defaults[key]
      if (configValue === undefined) {
        throw new PluginVariableError(`Missing plugin user_config value: ${key}`)
      }
      return String(configValue)
    }
    if (name.startsWith('ZCODE_') || name.startsWith('FLEX_')) {
      const envValue = context.env[name]
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`)
      return envValue
    }

    return match
  })
}
