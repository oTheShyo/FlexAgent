import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ContractError } from '../../../shared/contract'
import type { KernelEvent, SessionId, TerminalId } from '../../../shared/contract'
import { codexApi } from '../api'
import { IconButton } from './ui'

export interface TerminalDrawerProps {
  open: boolean
  onClose: () => void
  sessionId: SessionId | null
}

type PtyEvent = Extract<KernelEvent, { type: 'pty_output' | 'pty_exit' }>

const RESIZE_DEBOUNCE_MS = 150

// Reads a design token from index.css at call time (mirrors --surface, --text,
// --success, etc. on documentElement, so light and dark schemes are honored).
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Expands #rgb/#rrggbb token values and applies alpha; returns the input
// unchanged when it is not a hex color (e.g. already rgb()/rgba()).
function withAlpha(color: string, alpha: number): string {
  const hex = color.startsWith('#') ? color.slice(1) : ''
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map(ch => ch + ch)
          .join('')
      : hex.length === 6
        ? hex
        : null
  if (full === null) return color
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function describeError(err: unknown): string {
  if (err instanceof ContractError) {
    if (err.code === 'TERMINAL_NOT_FOUND') return 'terminal not found'
    if (err.code === 'SESSION_NOT_FOUND') return 'session not found'
    return err.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}

function isTerminalGone(err: unknown): boolean {
  return err instanceof ContractError && err.code === 'TERMINAL_NOT_FOUND'
}

function TerminalDrawer({ open, onClose, sessionId }: TerminalDrawerProps) {
  const [terminalId, setTerminalId] = useState<TerminalId | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // Create/dispose xterm with the drawer; kill the PTY on cleanup so the next
  // open starts fresh. StrictMode double-mount: first cleanup disposes, second mount recreates.
  useEffect(() => {
    if (!open || sessionId === null || sessionId === '') return
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let activeId: TerminalId | null = null
    const preAck: PtyEvent[] = []

    setExitCode(null)
    setStatus(null)
    setTerminalId(null)
    setCreating(true)

    // Theme resolved once at mount from CSS design tokens (mirrors index.css
    // --surface/--text/--success pairs). Limitation: xterm takes a static theme,
    // so switching the OS color scheme while this terminal stays mounted does
    // not re-theme it until the drawer is reopened.
    const surface = cssVar('--surface')
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      // Raw PTY stream (ConPTY already emits \r\n); do not rewrite line endings.
      convertEol: false,
      scrollback: 5000,
      theme: {
        background: surface,
        foreground: cssVar('--text'),
        cursor: cssVar('--success'),
        cursorAccent: surface,
        selectionBackground: withAlpha(cssVar('--success'), 0.25)
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      // host may have zero size on first paint; ResizeObserver will re-fit
    }

    const cols = term.cols
    const rows = term.rows

    const dataDisposable = term.onData(data => {
      if (disposed || activeId === null) return
      void codexApi
        .terminalInput({ terminalId: activeId, data })
        .then(() => {
          if (!disposed) setStatus(null)
        })
        .catch((err: unknown) => {
          if (disposed) return
          setStatus(describeError(err))
          if (isTerminalGone(err)) {
            activeId = null
            setTerminalId(null)
          }
        })
    })

    // Subscribe BEFORE create so no pty_* event is missed.
    const unsubscribe = codexApi.subscribe(sessionId, event => {
      if (disposed) return
      if (event.type !== 'pty_output' && event.type !== 'pty_exit') return
      if (activeId === null) {
        preAck.push(event)
        return
      }
      if (event.terminalId !== activeId) return
      if (event.type === 'pty_output') {
        term.write(event.data)
      } else {
        setExitCode(event.exitCode)
        term.write(`\r\n[process exited with code ${event.exitCode}]\r\n`)
      }
    })

    void (async () => {
      try {
        const ack = await codexApi.terminalCreate({ sessionId, cols, rows })
        if (disposed) {
          void codexApi.terminalKill(ack.terminalId).catch(() => undefined)
          return
        }
        activeId = ack.terminalId
        setTerminalId(ack.terminalId)
        for (const ev of preAck) {
          if (ev.terminalId !== ack.terminalId) continue
          if (ev.type === 'pty_output') term.write(ev.data)
          else {
            setExitCode(ev.exitCode)
            term.write(`\r\n[process exited with code ${ev.exitCode}]\r\n`)
          }
        }
        preAck.length = 0
        term.focus()
      } catch (err) {
        if (!disposed) setStatus(describeError(err))
      } finally {
        if (!disposed) setCreating(false)
      }
    })()

    return () => {
      disposed = true
      unsubscribe()
      dataDisposable.dispose()
      if (activeId !== null) {
        void codexApi.terminalKill(activeId).catch(() => undefined)
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [open, sessionId])

  useEffect(() => {
    if (!open || sessionId === null || sessionId === '') return
    const el = hostRef.current
    if (!el) return

    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const term = termRef.current
        const fit = fitRef.current
        if (!term || !fit || terminalId === null || exitCode !== null) return
        try {
          fit.fit()
        } catch {
          return
        }
        void codexApi
          .terminalResize({ terminalId, cols: term.cols, rows: term.rows })
          .catch((err: unknown) => {
            setStatus(describeError(err))
            if (isTerminalGone(err)) setTerminalId(null)
          })
      }, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(el)

    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [open, sessionId, terminalId, exitCode])

  if (!open) return null

  const noSession = sessionId === null || sessionId === ''

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex h-72 flex-col overflow-hidden rounded-t-xl border-t border-[var(--border)] bg-[var(--surface)] shadow-[0_-8px_24px_rgba(0,0,0,0.45)]"
      data-testid="terminal-drawer"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface-sunken)] px-3">
        <span className="text-xs font-medium tracking-wide text-[var(--text-secondary)]">
          Terminal
        </span>
        <IconButton variant="ghost" label="Close terminal" onClick={onClose}>
          ✕
        </IconButton>
      </div>

      <div className="relative min-h-0 flex-1 bg-[var(--surface)]">
        {noSession ? (
          <div className="px-3 py-2 font-mono text-[13px] text-[var(--text-muted)]">
            no session selected
          </div>
        ) : (
          <>
            <div
              ref={hostRef}
              aria-label="Terminal"
              className="absolute inset-0 overflow-hidden p-2"
            />
            {creating && (
              <div className="pointer-events-none absolute inset-0 flex items-start p-3 font-mono text-[13px] text-[var(--text-muted)]">
                starting terminal…
              </div>
            )}
          </>
        )}
      </div>

      {status !== null && (
        <div
          role="alert"
          className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-1 font-mono text-[12px] text-[var(--danger-text)]"
        >
          {status}
        </div>
      )}
    </div>
  )
}

export default memo(TerminalDrawer)
