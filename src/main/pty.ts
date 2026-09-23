import { randomUUID } from 'crypto'
import type { IPty } from 'node-pty'
import type { SessionId, TerminalCreateInput, TerminalId } from '../shared/contract'
import { ContractError } from '../shared/contract'
import type { KernelHost } from './kernel'
import type { SessionRegistry } from './registry'

const MAX_TERMINALS_PER_SESSION = 4

interface LiveTerminal {
  id: TerminalId
  sessionId: SessionId
  proc: IPty
  dead: boolean
  exitEmitted: boolean
}

/**
 * Real interactive shells in the main process. Deliberately bypasses the
 * agent permission gate (contract §3.3) — user keystrokes run with the
 * app's OS permissions.
 */
export class TerminalManager {
  private byId = new Map<TerminalId, LiveTerminal>()
  private bySession = new Map<SessionId, Set<TerminalId>>()

  constructor(
    private readonly kernel: KernelHost,
    private readonly registry: SessionRegistry
  ) {}

  create(input: TerminalCreateInput): { terminalId: TerminalId } {
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId) {
      throw new ContractError('INVALID_INPUT', 'sessionId is required')
    }
    const { sessionId, cols, rows } = input
    if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 1) {
      throw new ContractError('INVALID_INPUT', 'cols/rows must be positive integers (cols >= 2)')
    }
    const rec = this.registry.require(sessionId)
    const live = this.liveCount(sessionId)
    if (live >= MAX_TERMINALS_PER_SESSION) {
      throw new ContractError(
        'TERMINAL_LIMIT',
        `Session already has ${MAX_TERMINALS_PER_SESSION} live terminals`
      )
    }

    const cwd = input.cwd && input.cwd.trim() ? input.cwd : rec.cwd
    // Lazy load: native module may be missing until electron-rebuild succeeds.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require('node-pty') as typeof import('node-pty')
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
    const args = process.platform === 'win32' ? [] : ['-l']
    const id = randomUUID()

    let proc: IPty
    try {
      proc = pty.spawn(shell, args, {
        name: 'xterm-color',
        cols,
        rows,
        cwd,
        env: { ...(process.env as Record<string, string>), ...(input.env ?? {}) }
      })
    } catch (err) {
      throw new ContractError(
        'KERNEL_INTERNAL',
        err instanceof Error ? err.message : 'Failed to spawn PTY'
      )
    }

    const record: LiveTerminal = { id, sessionId, proc, dead: false, exitEmitted: false }
    this.byId.set(id, record)
    const set = this.bySession.get(sessionId) ?? new Set<TerminalId>()
    set.add(id)
    this.bySession.set(sessionId, set)

    proc.onData((data) => {
      this.kernel.fanOut(sessionId, {
        type: 'pty_output',
        sessionId,
        ts: Date.now(),
        terminalId: id,
        data
      })
    })

    proc.onExit(({ exitCode }) => {
      if (record.exitEmitted) return
      record.exitEmitted = true
      record.dead = true
      this.kernel.fanOut(sessionId, {
        type: 'pty_exit',
        sessionId,
        ts: Date.now(),
        terminalId: id,
        exitCode: typeof exitCode === 'number' ? exitCode : 0
      })
    })

    return { terminalId: id }
  }

  private liveCount(sessionId: SessionId): number {
    const set = this.bySession.get(sessionId)
    if (!set) return 0
    let n = 0
    for (const id of set) {
      const rec = this.byId.get(id)
      if (rec && !rec.dead) n += 1
    }
    return n
  }

  private requireLive(terminalId: TerminalId): LiveTerminal {
    const rec = this.byId.get(terminalId)
    if (!rec || rec.dead) {
      throw new ContractError('TERMINAL_NOT_FOUND', `Unknown or dead terminal: ${terminalId}`)
    }
    return rec
  }

  input(terminalId: TerminalId, data: string): void {
    if (typeof data !== 'string') {
      throw new ContractError('INVALID_INPUT', 'data must be a string')
    }
    this.requireLive(terminalId).proc.write(data)
  }

  resize(terminalId: TerminalId, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 1) {
      throw new ContractError('INVALID_INPUT', 'cols/rows must be positive integers (cols >= 2)')
    }
    const rec = this.requireLive(terminalId)
    try {
      rec.proc.resize(cols, rows)
    } catch (err) {
      throw new ContractError(
        'KERNEL_INTERNAL',
        err instanceof Error ? err.message : 'resize failed'
      )
    }
  }

  /** Idempotent for known-but-exited ids; never-created ids → TERMINAL_NOT_FOUND. */
  kill(terminalId: TerminalId): void {
    const rec = this.byId.get(terminalId)
    if (!rec) {
      throw new ContractError('TERMINAL_NOT_FOUND', `Unknown terminal: ${terminalId}`)
    }
    if (rec.exitEmitted) return
    rec.dead = true
    try {
      rec.proc.kill()
    } catch {
      // Process already gone — if onExit never ran, emit terminal pty_exit once.
      if (!rec.exitEmitted) {
        rec.exitEmitted = true
        this.kernel.fanOut(rec.sessionId, {
          type: 'pty_exit',
          sessionId: rec.sessionId,
          ts: Date.now(),
          terminalId: rec.id,
          exitCode: 0
        })
      }
    }
  }

  disposeSession(sessionId: SessionId): void {
    const set = this.bySession.get(sessionId)
    if (!set) return
    for (const id of set) {
      const rec = this.byId.get(id)
      if (rec && !rec.exitEmitted) {
        rec.dead = true
        try {
          rec.proc.kill()
        } catch {
          // ignore
        }
      }
      this.byId.delete(id)
    }
    this.bySession.delete(sessionId)
  }

  disposeAll(): void {
    for (const rec of this.byId.values()) {
      if (!rec.exitEmitted) {
        rec.dead = true
        try {
          rec.proc.kill()
        } catch {
          // ignore
        }
      }
    }
    this.byId.clear()
    this.bySession.clear()
  }
}
