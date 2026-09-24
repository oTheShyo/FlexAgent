import type { SVGProps } from 'react'
import type { PluginComponentKind } from '../types'

/** Four-square plugins glyph shared by the sidebar, palette, and plugin pages. */
export function PluginIcon({ className = 'h-4 w-4', ...rest }: SVGProps<SVGSVGElement> & { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  )
}

const KIND_ICON_CLASS = 'h-3.5 w-3.5 shrink-0'

export function ExtensionIcon() {
  return (
    <svg className={KIND_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 4.5H6A1.5 1.5 0 0 0 4.5 6v4M14 4.5h4A1.5 1.5 0 0 1 19.5 6v4M10 19.5H6A1.5 1.5 0 0 1 4.5 18v-4M14 19.5h4a1.5 1.5 0 0 0 1.5-1.5v-4" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  )
}

export function SkillIcon() {
  return (
    <svg className={KIND_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 1 4 16z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 0 20 16z" />
    </svg>
  )
}

export function CommandIcon() {
  return (
    <svg className={KIND_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 8 4 4-4 4" />
      <path d="M12 17h7" />
    </svg>
  )
}

export function HookIcon() {
  return (
    <svg className={KIND_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v10" />
      <path d="M8 11a4 4 0 1 0 8 0" />
      <path d="M12 20a4 4 0 0 1-4-4" />
      <circle cx="12" cy="4" r="1.5" />
    </svg>
  )
}

export function McpIcon() {
  return (
    <svg className={KIND_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 7V5a3 3 0 0 1 6 0v2" />
      <path d="M5.5 7h13a1 1 0 0 1 1 1v4a7.5 7.5 0 0 1-15 0V8a1 1 0 0 1 1-1z" />
      <path d="M12 19.5V21" />
    </svg>
  )
}

const KIND_ICON: Record<PluginComponentKind, () => React.ReactNode> = {
  extension: ExtensionIcon,
  skill: SkillIcon,
  command: CommandIcon,
  hook: HookIcon,
  mcp: McpIcon
}

export function ComponentKindIcon({ kind }: { kind: PluginComponentKind }) {
  const Icon = KIND_ICON[kind]
  return <Icon />
}

