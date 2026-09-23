/**
 * Mock file list for the Composer `@` mention autocomplete.
 * Renderer-only fixture — intentionally NOT backed by CodexApi / IPC
 * (listFiles is deferred per backend handoff §7.1#2).
 * Paths are repo-relative, POSIX-style.
 */
export const COMPOSER_FILES: readonly string[] = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/main.tsx',
  'src/renderer/src/components/Composer.tsx',
  'src/renderer/src/components/ChatView.tsx',
  'src/renderer/src/components/CommandPalette.tsx',
  'src/renderer/src/components/DiffPanel.tsx',
  'src/renderer/src/components/PermissionDialog.tsx',
  'src/renderer/src/components/Sidebar.tsx',
  'src/renderer/src/components/TerminalDrawer.tsx',
  'src/renderer/src/components/TopBar.tsx',
  'src/renderer/src/components/composerFiles.ts',
  'src/renderer/src/hooks/useChat.ts',
  'src/renderer/src/api/mock.ts',
  'src/renderer/src/api/index.ts',
  'src/renderer/src/types/index.ts',
  'src/renderer/src/env.d.ts',
  'src/renderer/index.html',
  'src/renderer/tailwind.config.js',
  'src/renderer/src/styles.css',
  'src/main/index.ts',
  'src/preload/index.ts',
  'src/shared/contract.ts',
  'package.json',
  'tsconfig.json'
]

export const MENTION_EMPTY_LIMIT = 8

export function filterComposerFiles(query: string): string[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return COMPOSER_FILES.slice(0, MENTION_EMPTY_LIMIT)
  const prefix: string[] = []
  const substring: string[] = []
  for (const path of COMPOSER_FILES) {
    const lower = path.toLowerCase()
    if (lower.startsWith(q)) prefix.push(path)
    else if (lower.includes(q)) substring.push(path)
  }
  return [...prefix, ...substring]
}
