/**
 * User theme preference (light / dark / system) under `codex.theme.v1`.
 * Storage guard pattern mirrors lib/sessionMeta.ts (hasStorage + try/catch).
 * The `data-theme` attribute on <html> drives index.css token selection;
 * `system` is resolved purely in CSS via prefers-color-scheme so OS changes
 * never require a React re-render.
 */
export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'codex.theme.v1'

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function applyTheme(pref: ThemePreference): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', pref)
}

const listeners = new Set<() => void>()

/**
 * Notifies when the resolved palette may have changed. Two sources matter:
 * an explicit `writeTheme`, and an OS scheme flip while the preference is
 * `system` (index.css resolves that case through a media query, so no React
 * render is involved and nothing else would observe it).
 *
 * Consumers re-read their colours from the CSS custom properties. Module-level
 * app-lifetime binding — the matchMedia listener is never removed.
 */
export function subscribeThemeChange(listener: () => void): () => void {
  listeners.add(listener)
  bindMediaListener()
  return () => {
    listeners.delete(listener)
  }
}

let mediaBound = false

function bindMediaListener(): void {
  if (mediaBound) return
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  mediaBound = true
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', () => {
    notifyThemeChange()
  })
}

function notifyThemeChange(): void {
  listeners.forEach((listener) => listener())
}

export function readTheme(): ThemePreference {
  if (!hasStorage()) return 'system'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return 'system'
    const parsed: unknown = JSON.parse(raw)
    return isThemePreference(parsed) ? parsed : 'system'
  } catch {
    return 'system'
  }
}

export function writeTheme(next: ThemePreference): void {
  if (hasStorage()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
    }
  }
  applyTheme(next)
  notifyThemeChange()
}

export function initTheme(): ThemePreference {
  const pref = readTheme()
  applyTheme(pref)
  return pref
}
