import { useEffect, useRef, useState } from 'react'
import { Button } from './ui'
import { MenuItem, MenuPanel } from './ui/Menu'
import { PERMISSION_MODE_HINTS, PERMISSION_MODE_LABELS, type PermissionMode } from '../types'

const MODE_COLOR: Record<PermissionMode, string> = {
  plan: 'var(--text-subtle)',
  default: 'var(--text-secondary)',
  acceptEdits: 'var(--text-secondary)',
  auto: 'var(--text)',
  bypass: 'var(--danger, var(--warning-text))'
}

export interface ModeSwitcherProps {
  mode: PermissionMode
  pending?: boolean
  availableModes: readonly PermissionMode[]
  onChange?: (mode: PermissionMode) => void
  /**
   * Which way the menu opens. This is not a style preference: a menu that opens
   * upward from the top bar renders entirely above the viewport, which reads as
   * a dead button — measured, not hypothetical.
   */
  direction?: 'up' | 'down'
  /** Smaller chrome for embedding next to the composer input. */
  compact?: boolean
}

/**
 * The trust-level control. Shows the current mode and opens the five-mode menu.
 */
export function ModeSwitcher({
  mode,
  pending = false,
  availableModes,
  onChange,
  direction = 'down',
  compact = false
}: ModeSwitcherProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const positionClass = direction === 'up' ? 'bottom-full left-0 mb-1.5' : 'top-full left-0 mt-1.5'

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        type="button"
        variant={compact ? 'ghost' : 'secondary'}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        data-testid="permission-mode"
        data-mode={mode}
        title={PERMISSION_MODE_HINTS[mode]}
        className={`flex items-center gap-1.5${
          compact ? ' !rounded-lg !px-2 !text-[var(--text-muted)] hover:!text-[var(--text)]' : ''
        }`}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: MODE_COLOR[mode] }}
        />
        <span>{PERMISSION_MODE_LABELS[mode]}</span>
      </Button>
      {open && (
        <MenuPanel className={`${positionClass} w-64`} role="menu" aria-label="Permission mode">
          {availableModes.map((candidate) => (
            <MenuItem
              key={candidate}
              role="menuitemradio"
              aria-checked={candidate === mode}
              onClick={() => {
                setOpen(false)
                onChange?.(candidate)
              }}
              className={
                candidate === mode
                  ? '!text-[var(--text)] !bg-[var(--hover)]'
                  : undefined
              }
            >
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: MODE_COLOR[candidate] }}
                  />
                  {PERMISSION_MODE_LABELS[candidate]}
                </span>
                <span className="text-[11px] font-normal leading-4 text-[var(--text-muted)]">
                  {PERMISSION_MODE_HINTS[candidate]}
                </span>
              </span>
            </MenuItem>
          ))}
        </MenuPanel>
      )}
    </div>
  )
}
