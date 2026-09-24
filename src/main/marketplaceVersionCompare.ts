export type PluginUpdateStatus = 'none' | 'update-available' | 'version-changed'

interface CoerceResult {
  major: number
  minor: number
  patch: number
}

function coerceVersion(version: string): CoerceResult | null {
  const match = /(?:^|[^0-9])(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0
  }
}

function compareCoerced(a: CoerceResult, b: CoerceResult): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return 0
}

export function comparePluginVersions(input: {
  installed: string | undefined
  latest: string | undefined
}): PluginUpdateStatus {
  const { installed, latest } = input
  if (!installed || !latest) return 'none'
  const installedCoerced = coerceVersion(installed)
  const latestCoerced = coerceVersion(latest)
  if (installedCoerced && latestCoerced) {
    return compareCoerced(latestCoerced, installedCoerced) > 0 ? 'update-available' : 'none'
  }
  return installed === latest ? 'none' : 'version-changed'
}

export function comparePluginUpdate(input: {
  installedVersion: string | undefined
  installedSha: string | undefined
  latestVersion: string | undefined
  latestSha: string | undefined
}): PluginUpdateStatus {
  const { installedVersion, installedSha, latestVersion, latestSha } = input
  if (latestVersion) {
    return comparePluginVersions({ installed: installedVersion, latest: latestVersion })
  }
  if (latestSha) {
    if (!installedSha) return 'version-changed'
    return installedSha === latestSha ? 'none' : 'update-available'
  }
  return 'none'
}
