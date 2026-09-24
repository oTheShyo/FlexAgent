export { PluginIcon } from '../pluginIcons'

export interface IconProps {
  className?: string
}

const DEFAULT_CLASS = 'h-4 w-4 shrink-0'

function baseProps(className?: string) {
  return {
    className: className ?? DEFAULT_CLASS,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const
  }
}

export function NewChatIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </svg>
  )
}

export function PluginsIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  )
}

export function ScheduledIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

export function ChatDotIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M21 11.6a8.4 8.4 0 0 1-8.5 8.4 8.7 8.7 0 0 1-3.8-.9L3 20.5l1.4-4.6A8.4 8.4 0 1 1 21 11.6z" />
    </svg>
  )
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

export function MoreIcon({ className }: IconProps) {
  return (
    <svg
      className={className ?? DEFAULT_CLASS}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  )
}

export function TerminalIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="m4 17 6-5-6-5" />
      <path d="M12 19h8" />
    </svg>
  )
}

export function ReviewIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M10 13h4" />
      <path d="M10 17h4" />
    </svg>
  )
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg
      className={className ?? 'h-3 w-3 shrink-0'}
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />
    </svg>
  )
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export function FolderIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8l1 1.3a1 1 0 0 0 .8.4H19a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="m5 12 5 5L20 7" />
    </svg>
  )
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)} strokeWidth={1.75}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  )
}

export function QueueIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 7h10" />
      <path d="M4 12h10" />
      <path d="M4 17h6" />
      <path d="M17 10v7" />
      <path d="m14 14 3 3 3-3" />
    </svg>
  )
}

export function FileIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

/** Skills: a procedure card with a checklist. */
export function SkillsIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3.5" y="4" width="17" height="16" rx="3" />
      <path d="M7 10l1.8 1.8L12 8.5" />
      <path d="M7 15.5h6" />
      <path d="M15.5 15.5H17" />
    </svg>
  )
}

/** Memory: a durable-records card with an anchor line. */
export function MemoryIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <path d="M8 8h8" />
      <path d="M8 12h8" />
      <path d="M8 16h5" />
    </svg>
  )
}

export function SlashIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m14 7.5-4 9" />
    </svg>
  )
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />
      <path d="M9.5 12.5 11 14l3.5-3.5" />
    </svg>
  )
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 7h16" />
      <path d="M10 4h4" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.29 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.27.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </svg>
  )
}

export function EmptyCloudIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M7 16.5a3.8 3.8 0 0 1 .7-7.5 5.2 5.2 0 0 1 9.7 1.3A3.4 3.4 0 0 1 16.7 16.5z" />
      <path d="m10.3 11.6-1.6 1.6 1.6 1.6" />
      <path d="m13.7 11.6 1.6 1.6-1.6 1.6" />
      <path d="m12.7 10.9-.9 4.6" />
    </svg>
  )
}

/** Filled diamond — a model entry in Settings › Models. */
export function ModelIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
      <path d="M12 8.2 15.8 12 12 15.8 8.2 12z" />
    </svg>
  )
}

export function PencilIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m14.5 5.5 4 4" />
    </svg>
  )
}

/** Appearance / theme — a painter's palette. */
export function PaletteIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 2-.9 2-2 0-.6-.2-1.1-.6-1.5-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h1.7a4 4 0 0 0 4-4c0-3.4-3.8-6.2-8.6-6.2z" />
      <path d="M7.7 10.4h.01" />
      <path d="M11.3 7.7h.01" />
      <path d="M15.7 9.7h.01" />
    </svg>
  )
}

/** Keyboard shortcuts — a key row. */
export function KeyboardIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M9.4 10h.01M12.8 10h.01M16.2 10h.01M18.5 12.6h.01M6 13.4h.01M9.4 13.4h.01M12.8 13.4h.01" />
    </svg>
  )
}

/** About / storage — an information badge. */
export function InfoIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.2v5.3" />
      <path d="M12 7.9h.01" />
    </svg>
  )
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="m6.5 6.5 11 11" />
      <path d="m17.5 6.5-11 11" />
    </svg>
  )
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg
      className={className ?? DEFAULT_CLASS}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path
        d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function RegenerateIcon({ className }: IconProps) {
  return (
    <svg
      className={className ?? DEFAULT_CLASS}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" strokeLinecap="round" />
      <path d="M13.5 2.5V5H11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One request in, several models out — Settings › Routing. */
export function RoutingIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="5" cy="12" r="2" />
      <path d="M7 12h4" />
      <path d="M11 12a5 5 0 0 1 5-5h2.5" />
      <path d="M11 12a5 5 0 0 0 5 5h2.5" />
    </svg>
  )
}

/** Settings › Network. */
export function NetworkIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.4 2.4 3.7 5.3 3.7 8.5s-1.3 6.1-3.7 8.5c-2.4-2.4-3.7-5.3-3.7-8.5S9.6 5.9 12 3.5z" />
    </svg>
  )
}

