import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { IPC, type KernelEvent, type RunState, type SessionId } from '../shared/contract'
import type { WorkerKernelEvent, WorkerRequest, WorkerRequestInput, WorkerResponse } from '../shared/kernel-protocol'

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

const KERNEL_INTERNAL = {
  code: 'KERNEL_INTERNAL' as const,
  message: 'Kernel worker unavailable'
}

export class KernelHost {
  private worker: Worker | null = null
  private pending = new Map<string, Pending>()
  private seq = new Map<SessionId, number>()
  private runStates = new Map<SessionId, RunState>()
  private onRunState: ((sessionId: SessionId, runState: RunState) => void) | null = null
  private lastStartAt = 0
  private rapidRestarts = 0

  setRunStateListener(fn: (sessionId: SessionId, runState: RunState) => void): void {
    this.onRunState = fn
  }

  start(): void {
    if (this.worker) return
    this.lastStartAt = Date.now()
    const worker = new Worker(join(__dirname, 'worker.js'))
    this.worker = worker
    worker.on('message', (msg: WorkerResponse) => {
      if (this.worker === worker) this.onMessage(msg)
    })
    worker.on('error', (err) => this.failAll(err))
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      this.worker = null
      this.recoverFromWorkerLoss(`Kernel worker exited with code ${code}`)
    })
  }

  // §7.2.2: worker death must not leave subscribers half-dead — push error+idle, seq gap, auto-restart.
  private recoverFromWorkerLoss(reason: string): void {
    this.failAll(new Error(reason))

    const known = new Set<SessionId>([...this.runStates.keys(), ...this.seq.keys()])
    for (const sessionId of known) {
      if (this.runStates.get(sessionId) === 'running') {
        this.fanOut(sessionId, {
          type: 'run_state',
          runState: 'idle',
          sessionId,
          ts: Date.now()
        })
      }
      this.fanOut(sessionId, {
        type: 'error',
        sessionId,
        ts: Date.now(),
        code: 'KERNEL_INTERNAL',
        message: reason
      })
    }

    this.seq.clear()
    this.runStates.clear()

    const now = Date.now()
    if (now - this.lastStartAt < 2000) this.rapidRestarts += 1
    else this.rapidRestarts = 0
    if (this.rapidRestarts < 5) this.start()
  }

  private failAll(err: unknown): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'event') {
      this.fanOut(msg.sessionId, msg.event)
      return
    }
    const p = this.pending.get(msg.requestId)
    if (!p) return
    this.pending.delete(msg.requestId)
    if (msg.type === 'ok') {
      p.resolve(msg.result)
    } else {
      p.reject({ code: msg.code, message: msg.message, details: msg.details })
    }
  }

  request(req: WorkerRequestInput): Promise<unknown> {
    if (!this.worker) return Promise.reject({ ...KERNEL_INTERNAL })
    const requestId = randomUUID()
    const full = { ...req, requestId } as WorkerRequest
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.worker?.postMessage(full)
    })
  }

  /** Stamp `seq` (and normalize `ts`) then push to all windows. */
  fanOut(sessionId: SessionId, partial: WorkerKernelEvent | Omit<KernelEvent, 'seq'>): KernelEvent {
    const next = this.seq.get(sessionId) ?? 0
    this.seq.set(sessionId, next + 1)
    const full = { ...partial, sessionId, seq: next, ts: partial.ts || Date.now() } as KernelEvent
    const payload = JSON.parse(JSON.stringify(full)) as KernelEvent
    if (payload.type === 'run_state') {
      this.runStates.set(sessionId, payload.runState)
      this.onRunState?.(sessionId, payload.runState)
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.kernelEvent, payload)
    }
    return payload
  }

  async shutdown(): Promise<void> {
    const w = this.worker
    if (!w) return
    this.worker = null
    try {
      const requestId = randomUUID()
      const promise = new Promise<unknown>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject })
      })
      w.postMessage({ requestId, type: 'shutdown' } satisfies WorkerRequest)
      await promise
    } catch {
      // worker may exit before the ack
    }
    await w.terminate()
    this.pending.clear()
    this.seq.clear()
    this.runStates.clear()
  }

  async restartForPlugins(): Promise<void> {
    const w = this.worker
    if (!w) {
      this.start()
      return
    }
    this.worker = null
    await w.terminate()
    this.failAll(new Error('Kernel restarting for plugin change'))
    for (const sessionId of [...this.runStates.keys()]) {
      if (this.runStates.get(sessionId) === 'running') {
        this.fanOut(sessionId, {
          type: 'run_state',
          runState: 'idle',
          sessionId,
          ts: Date.now()
        })
      }
    }
    this.seq.clear()
    this.runStates.clear()
    this.start()
  }

  /**
   * §7.3 test-only: terminate without nulling `this.worker` first so the
   * `exit` handler still owns recovery (error+idle fanOut, seq clear, restart).
   * Not a CodexApi method — exposed only via `electron.diag` for accept-disconnect.
   */
  async killWorkerForTest(): Promise<{ killed: boolean }> {
    const w = this.worker
    if (!w) return { killed: false }
    await w.terminate()
    return { killed: true }
  }
}
