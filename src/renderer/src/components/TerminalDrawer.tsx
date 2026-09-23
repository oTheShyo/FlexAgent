import { memo, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ContractError } from '../../../shared/contract'
import type { KernelEvent, SessionId, TerminalId } from '../../../shared/contract'
import { codexApi } from '../api'

export interface TerminalDrawerProps {
  open: boolean
  onClose: () => void
  sessionId: SessionId | null
}

type PtyEvent = Extract<KernelEvent, { type: 'pty_output' | 'pty_exit' }>

const RESIZE_DEBOUNCE_MS = 150

/** Magic numbers: measured metrics for font-mono 13px / leading-relaxed (1.625). */
const CHAR_WIDTH_PX = 7.8
const LINE_HEIGHT_PX = 21

function measureTerminal(el: HTMLElement | null): { cols: number; rows: number } {
  if (!el) return { cols: 80, rows: 24 }
  return {
    cols: Math.max(20, Math.floor(el.clientWidth / CHAR_WIDTH_PX)),
    rows: Math.max(4, Math.floor(el.clientHeight / LINE_HEIGHT_PX))
  }
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
  const [buffer, setBuffer] = useState('')
  const [terminalId, setTerminalId] = useState<TerminalId | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open, terminalId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [buffer, exitCode])

  // Subscribe BEFORE create so no pty_* event is missed; kill on cleanup so
  // next open starts from a fresh terminalId.
  useEffect(() => {
    if (!open || sessionId === null) return

    let disposed = false
    let activeId: TerminalId | null = null
    const preAck: PtyEvent[] = []

    setBuffer('')
    setExitCode(null)
    setStatus(null)
    setTerminalId(null)
    setDraft('')
    setCreating(true)

    const { cols, rows } = measureTerminal(scrollRef.current)

    const unsubscribe = codexApi.subscribe(sessionId, event => {
      if (disposed) return
      if (event.type !== 'pty_output' && event.type !== 'pty_exit') return
      if (activeId === null) {
        // terminalCreate has not resolved yet — buffer until we know the id.
        preAck.push(event)
        return
      }
      if (event.terminalId !== activeId) return
      if (event.type === 'pty_output') setBuffer(prev => prev + event.data)
      else setExitCode(event.exitCode)
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
          if (ev.type === 'pty_output') setBuffer(prev => prev + ev.data)
          else setExitCode(ev.exitCode)
        }
        preAck.length = 0
      } catch (err) {
        if (!disposed) setStatus(describeError(err))
      } finally {
        if (!disposed) setCreating(false)
      }
    })()

    return () => {
      disposed = true
      unsubscribe()
      if (activeId !== null) {
        void codexApi.terminalKill(activeId).catch(() => undefined)
      }
    }
  }, [open, sessionId])

  // ResizeObserver's initial notification doubles as the on-open resize
  // (create already carries the first cols/rows).
  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (!el) return

    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (terminalId === null || exitCode !== null) return
        const { cols, rows } = measureTerminal(el)
        void codexApi.terminalResize({ terminalId, cols, rows }).catch((err: unknown) => {
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
  }, [open, terminalId, exitCode])

  const inputDisabled = sessionId === null || terminalId === null || exitCode !== null

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (inputDisabled) return
    // Deliberate no local echo: M6 mock echoes input back via pty_output
    // (contract §4). Local echo would double the line.
    const data = draft + '\n'
    setDraft('')
    void codexApi
      .terminalInput({ terminalId, data })
      .then(() => setStatus(null))
      .catch((err: unknown) => {
        setStatus(describeError(err))
        if (isTerminalGone(err)) setTerminalId(null)
      })
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex h-72 flex-col border-t border-zinc-800 bg-zinc-950 shadow-[0_-8px_24px_rgba(0,0,0,0.45)]"
      data-testid="terminal-drawer"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800/70 bg-zinc-900 px-3">
        <span className="text-xs font-medium tracking-wide text-zinc-400">Terminal</span>
        <button
          type="button"
          aria-label="Close terminal"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
        >
          ✕
        </button>
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto bg-[#0c0c0c] px-3 py-2 font-mono text-[13px] leading-relaxed [&::selection]:bg-emerald-500/25"
      >
        {sessionId === null ? (
          <div className="text-zinc-600">no session selected</div>
        ) : (
          <>
            {creating && buffer.length === 0 && exitCode === null && (
              <div className="text-zinc-600">starting terminal…</div>
            )}
            {buffer.length > 0 && (
              <div className="whitespace-pre-wrap break-words text-zinc-300">{buffer}</div>
            )}
            {exitCode !== null && (
              <div className="text-zinc-500">[process exited with code {exitCode}]</div>
            )}
          </>
        )}
      </div>

      {status !== null && (
        <div
          role="alert"
          className="shrink-0 border-t border-zinc-800/70 bg-zinc-950 px-3 py-1 font-mono text-[12px] text-red-400"
        >
          {status}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="flex shrink-0 items-center gap-2 border-t border-zinc-800/70 bg-[#0c0c0c] px-3 py-2 font-mono text-[13px] leading-relaxed focus-within:ring-1 focus-within:ring-inset focus-within:ring-emerald-500/40"
      >
        <span aria-hidden="true" className="shrink-0 text-emerald-500">
          &gt;
        </span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={inputDisabled}
          placeholder={exitCode !== null ? 'process exited' : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label="Terminal input"
          style={{ width: `${Math.max(draft.length, 1)}ch` }}
          className="min-w-[1ch] shrink-0 bg-transparent text-zinc-200 caret-emerald-500 outline-none [&::selection]:bg-emerald-500/25 disabled:cursor-not-allowed disabled:text-zinc-600"
        />
        {!inputDisabled && (
          <span
            aria-hidden="true"
            className="-ml-2 inline-block h-[1.05em] w-[0.55em] shrink-0 animate-pulse bg-emerald-500/80 align-middle"
          />
        )}
      </form>
    </div>
  )
}

export default memo(TerminalDrawer)
