/**
 * Fixture file list for the Composer `@` mention autocomplete.
 * Renderer-only — intentionally NOT backed by CodexApi / IPC (`listFiles` is
 * deferred per backend handoff §7.1#2). Paths mirror the real repo layout so
 * a picked mention stays valid; replace with `listFiles({ sessionId, query })`
 * once the backend ships it.
 */
export const COMPOSER_FILES: readonly string[] = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/main.tsx',
  'src/renderer/src/env.d.ts',
  'src/renderer/src/index.css',
  'src/renderer/src/api/index.ts',
  'src/renderer/src/api/mock.ts',
  'src/renderer/src/api/mockMarketplace.ts',
  'src/renderer/src/components/ChatView.tsx',
  'src/renderer/src/components/CommandPalette.tsx',
  'src/renderer/src/components/Composer.tsx',
  'src/renderer/src/components/composerFiles.ts',
  'src/renderer/src/components/ConnectionBanner.tsx',
  'src/renderer/src/components/DiffPanel.tsx',
  'src/renderer/src/components/EmptyState.tsx',
  'src/renderer/src/components/ErrorBoundary.tsx',
  'src/renderer/src/components/LoadingIndicator.tsx',
  'src/renderer/src/components/Markdown.tsx',
  'src/renderer/src/components/MarketplacePanel.tsx',
  'src/renderer/src/components/PermissionDialog.tsx',
  'src/renderer/src/components/PluginDetailPanel.tsx',
  'src/renderer/src/components/pluginIcons.tsx',
  'src/renderer/src/components/PluginsPage.tsx',
  'src/renderer/src/components/Sidebar.tsx',
  'src/renderer/src/components/Skeleton.tsx',
  'src/renderer/src/components/TerminalDrawer.tsx',
  'src/renderer/src/components/TopBar.tsx',
  'src/renderer/src/components/icons/index.tsx',
  'src/renderer/src/components/ui/Button.tsx',
  'src/renderer/src/components/ui/Chip.tsx',
  'src/renderer/src/components/ui/IconButton.tsx',
  'src/renderer/src/components/ui/Menu.tsx',
  'src/renderer/src/hooks/useChat.ts',
  'src/renderer/src/hooks/useMarketplace.ts',
  'src/renderer/src/hooks/usePlugins.ts',
  'src/renderer/src/lib/formatWhen.ts',
  'src/renderer/src/lib/shapes.ts',
  'src/renderer/src/lib/shortcuts.ts',
  'src/renderer/src/lib/theme.ts',
  'src/renderer/index.html',
  'src/main/index.ts',
  'src/main/ipc.ts',
  'src/preload/index.ts',
  'src/shared/contract/index.ts',
  'tailwind.config.js',
  'electron.vite.config.ts',
  'package.json',
  'tsconfig.json'
]

export const MENTION_EMPTY_LIMIT = 8

export function filterComposerFiles(
  query: string,
  files: readonly string[] = COMPOSER_FILES
): string[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return files.slice(0, MENTION_EMPTY_LIMIT)
  const prefix: string[] = []
  const substring: string[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    if (lower.startsWith(q)) prefix.push(path)
    else if (lower.includes(q)) substring.push(path)
  }
  return [...prefix, ...substring]
}

/**
 * Caching wrapper over the filter above.
 *
 * The list is a static fixture today, so the cache costs nothing and proves
 * nothing yet — it is the seam the real source plugs into. When `listFiles`
 * lands (see `## Blocked by (new)` in the ticket) the scan goes from "filter
 * 53 strings" to "walk a repo", and this is the one place that has to change.
 * The cached array is returned by identity so a repeated query cannot produce a
 * fresh list and re-render the popup for no reason.
 */
export interface ComposerFileIndex {
  query(rawQuery: string): string[]
}

export function createComposerFileIndex(files: readonly string[] = COMPOSER_FILES): ComposerFileIndex {
  const cache = new Map<string, string[]>()
  return {
    query(rawQuery: string): string[] {
      const key = rawQuery.trim().toLowerCase()
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const result = filterComposerFiles(key, files)
      cache.set(key, result)
      return result
    }
  }
}
