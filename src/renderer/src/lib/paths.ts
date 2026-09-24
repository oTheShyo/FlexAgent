/**
 * Minimal path helpers for display only. Paths arrive from the contract as
 * absolute, platform-native strings (`SessionSummary.cwd`), so both separators
 * are accepted and nothing is normalised beyond the basename.
 */

/** Last segment of a path; falls back to the whole string for bare names. */
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/**
 * Comparison key for grouping paths that point at the same directory.
 *
 * `SessionSummary.cwd` comes back as an absolute platform path, but the same
 * directory can be spelled differently (`C:/x/y` vs `C:\x\y` vs a trailing
 * slash) depending on who created the session. Grouping on the raw string
 * would show one directory twice, so separators are unified and Windows paths
 * are lower-cased (its filesystem is case-insensitive; POSIX paths are not).
 */
export function pathKey(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified
}
