import { useEffect, useRef } from 'react'

export type ShortcutId =
  | 'togglePalette'
  | 'togglePaletteAlias'
  | 'toggleTerminal'
  | 'newChat'
  | 'closeTop'
  | 'submit'

export interface ShortcutInfo {
  keys: string
  description: string
}

export const SHORTCUTS: Record<ShortcutId, ShortcutInfo> = {
  togglePalette: { keys: 'Ctrl+K', description: 'Toggle command palette' },
  togglePaletteAlias: { keys: 'Ctrl+Shift+P', description: 'Toggle command palette' },
  toggleTerminal: { keys: 'Ctrl+T', description: 'Toggle terminal drawer' },
  newChat: { keys: 'Ctrl+Shift+O', description: 'Start a new chat' },
  closeTop: { keys: 'Esc', description: 'Close topmost overlay' },
  submit: { keys: 'Ctrl+Enter', description: 'Send message' }
}

export interface ShortcutBinding {
  id: ShortcutId
  key: string
  ctrlOrMeta: boolean
  shift?: boolean
  preventDefault?: boolean
  allowInEditable?: boolean
  when?: () => boolean
  disabled?: boolean
  handler: (event: KeyboardEvent) => void
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

function matchesBinding(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false
  const primary = event.ctrlKey || event.metaKey
  if (primary !== binding.ctrlOrMeta) return false
  if ((binding.shift ?? false) !== event.shiftKey) return false
  if (event.altKey) return false
  return true
}

export function useShortcuts(bindings: ShortcutBinding[]): void {
  const bindingsRef = useRef(bindings)

  useEffect(() => {
    bindingsRef.current = bindings
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const editable = isEditableTarget(event.target)
      for (const binding of bindingsRef.current) {
        if (binding.disabled === true) continue
        if (binding.when !== undefined && !binding.when()) continue
        if (!matchesBinding(event, binding)) continue
        const hasModifier = binding.ctrlOrMeta || binding.shift === true
        if (editable && !hasModifier && binding.allowInEditable !== true) continue
        if (binding.preventDefault === true) event.preventDefault()
        binding.handler(event)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
