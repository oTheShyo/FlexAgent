import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { Worker } from 'worker_threads'
import {
  IPC,
  type KernelEvent,
  type McpServerStatusEntry,
  type RoutingState,
  type RunState,
  type SessionId,
  type UsageReport
} from '../shared/contract'
import type {
  ApplyModelKeysResult,
  NetworkStatus,
  WorkerKernelEvent,
  WorkerRequest,
  WorkerRequestInput,
  WorkerResponse
} from '../shared/kernel-protocol'
import { readModelKeys } from './modelKeys'
import { migratePlaintextKeys, staleManagedProviders } from './userModels'

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
  private mcpStatus: McpServerStatusEntry[] = []

  /** Last worker-reported MCP bridge status (empty until first attach). */
  getMcpStatus(): McpServerStatusEntry[] {
    return this.mcpStatus
  }

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
    if (msg.type === 'mcpStatus') {
      this.mcpStatus = msg.servers
      const payload: McpServerStatusEntry[] = JSON.parse(JSON.stringify(msg.servers))
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.mcpStatusChanged, { servers: payload })
      }
      return
    }
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

  /**
   * Pay the kernel's cold-start cost before the user interacts: the worker
   * loads the PI module graph, builds the model runtime and primes the resource
   * loader for `cwd`. Fire-and-forget — a failure here just means the first
   * real request pays the cost as it did before.
   */
  prewarm(cwd?: string): void {
    void this.request(cwd === undefined ? { type: 'warmup' } : { type: 'warmup', cwd })
      .catch(() => {})
      .then(() =>
        // Chained, not parallel: a cold worker has no model keys at all until
        // this lands, and asking before the runtime exists would only fail.
        this.applyModelKeys().catch(() => {})
      )
  }

  /**
   * The file the kernel reads custom models from. Asked of the worker rather
   * than recomputed in main: PI's agent dir is configurable, and writing a
   * models.json nobody reads is a silent failure.
   */
  async modelsPath(): Promise<string> {
    const result = (await this.request({ type: 'modelsPath' })) as { path?: string } | undefined
    if (result?.path === undefined) throw { ...KERNEL_INTERNAL }
    return result.path
  }

  /**
   * The models file was edited. The worker re-reads it and recomposes the
   * affected providers in place, so sessions that are already attached — all of
   * which share one ModelRuntime — gain the model without a re-attach.
   *
   * `verify` is not decoration: the write is on disk either way, so the only
   * honest way to report success is to ask the kernel whether it now resolves
   * `provider/id`. Returns the reason when it does not.
   */
  async reloadModels(
    providers: string[],
    verify: { provider: string; id: string; present: boolean }
  ): Promise<string | undefined> {
    const result = (await this.request({ type: 'reloadModels', providers, verify })) as
      | { error?: string }
      | undefined
    return result?.error
  }

  /**
   * Ticket 26 — hand the worker the model keys, opened here.
   *
   * Main is the side that can decrypt them (`safeStorage` is not reachable from
   * the worker thread), and the wire is the process channel rather than the
   * environment, which every bash subprocess the agent spawns would inherit.
   *
   * Safe to call repeatedly: it is how a key edited in Settings reaches a worker
   * that is already running, and how a fresh worker gets them at all.
   */
  async applyModelKeys(): Promise<ApplyModelKeysResult> {
    const file = await this.modelsPath()
    // A file written before this ticket still holds its key in plaintext. Move
    // it first, so the keys read below are the whole set and the disk copy never
    // has one by the time the runtime is given anything.
    await migratePlaintextKeys(file)
    const { keys } = readModelKeys()
    const clear = staleManagedProviders(file)
    const result = (await this.request({ type: 'applyModelKeys', keys, clear })) as
      | ApplyModelKeysResult
      | undefined
    return result ?? { applied: [], failed: Object.keys(keys), cleared: [] }
  }

  /** PI's own `settings.json`; the network settings are stored there. */
  async settingsPath(): Promise<string> {
    const result = (await this.request({ type: 'settingsPath' })) as { path?: string } | undefined
    if (result?.path === undefined) throw { ...KERNEL_INTERNAL }
    return result.path
  }

  /** Every routing role resolved against the live ModelRuntime, plus model facts. */
  async resolveModelRoles(): Promise<RoutingState> {
    const result = (await this.request({ type: 'resolveModelRoles' })) as RoutingState | undefined
    if (result === undefined) throw { ...KERNEL_INTERNAL }
    return result
  }

  /** Whether this process installed the kernel's HTTP dispatcher, and what env says. */
  async networkStatus(): Promise<NetworkStatus> {
    const result = (await this.request({ type: 'networkStatus' })) as NetworkStatus | undefined
    if (result === undefined) throw { ...KERNEL_INTERNAL }
    return result
  }

  /** Push the stored network settings into the running kernel. */
  async applyNetwork(proxy: string, idleTimeoutMs: number): Promise<NetworkStatus> {
    const result = (await this.request({ type: 'applyNetwork', proxy, idleTimeoutMs })) as
      | NetworkStatus
      | undefined
    if (result === undefined) throw { ...KERNEL_INTERNAL }
    return result
  }

  /** One session's tokens, attributed to the purpose that spent them. */
  async sessionUsage(sessionId: SessionId): Promise<UsageReport> {
    const result = (await this.request({ type: 'sessionUsage', sessionId })) as
      | UsageReport
      | undefined
    if (result === undefined) throw { ...KERNEL_INTERNAL }
    return result
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
