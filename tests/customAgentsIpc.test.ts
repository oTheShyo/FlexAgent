/**
 * Error-envelope contract for the custom-subagent IPC handlers.
 *
 * The four handlers used to reject with raw Errors; Electron flattens those
 * into `Error invoking remote method …` and drops the {code, message} fields
 * the preload layer re-inflates (contract §5), so a failed CRUD call arrived
 * in the renderer as an opaque string. This harness registers the handlers for
 * real — electron and the kernel are mocked, the sender-validation frame is a
 * same-origin dev URL — and asserts every rejection crosses the boundary as
 * the JSON payload the guard embeds in Error.message.
 *
 * AGENTS_HOME is baked at import time, so the env seam is set before the
 * module is imported (same pattern the homedir-redirecting suites use).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { IPC, type CustomAgentsSnapshot } from '../src/shared/contract'
import { KernelHost } from '../src/main/kernel'

const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
)

vi.mock('electron', () => ({
  // ipcGuard only needs these two: registration goes through `handle`, and
  // sender validation asks whether the sender is one of our windows.
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }
  },
  BrowserWindow: {
    fromWebContents: () => ({ isDestroyed: () => false })
  }
}))

// kernel.ts pulls the whole worker graph in at import time; the handlers only
// ever call `request({ type: 'reloadResources' })`, which this answers.
vi.mock('../src/main/kernel', () => ({
  KernelHost: class {
    request(): Promise<unknown> {
      return Promise.resolve(undefined)
    }
  }
}))

const root = mkdtempSync(join(tmpdir(), 'flexagent-ipc-agents-'))
const home = join(root, 'agents', 'home')
mkdirSync(home, { recursive: true })
process.env.FLEXAGENT_AGENTS_HOME = home
// Sender validation: this harness's fake frame is the dev renderer origin.
const mutableEnv = process.env as Record<string, string | undefined>
mutableEnv.ELECTRON_RENDERER_URL = 'http://localhost:5173'

const { registerCustomAgentsIpc } = await import('../src/main/customAgentsIpc')
registerCustomAgentsIpc(new KernelHost())

interface IpcFailure {
  code?: unknown
  message?: unknown
}

const SENDER_FRAME = { sender: {}, senderFrame: { url: 'http://localhost:5173/' } }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`)
  return (await handler(SENDER_FRAME, ...args)) as T
}

async function rejection(channel: string, ...args: unknown[]): Promise<Error> {
  try {
    await invoke(channel, ...args)
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`rejected with a non-Error value: ${String(error)}`)
  }
  throw new Error(`expected ${channel} to reject`)
}

async function failure(channel: string, ...args: unknown[]): Promise<IpcFailure> {
  const error = await rejection(channel, ...args)
  expect(typeof (error as { code?: unknown }).code).toBe('string')
  return JSON.parse(error.message) as IpcFailure
}

afterEach(() => {
  for (const entry of readdirSync(home)) {
    rmSync(join(home, entry), { recursive: true, force: true })
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.FLEXAGENT_AGENTS_HOME
  delete mutableEnv.ELECTRON_RENDERER_URL
})

describe('customAgentsIpc error envelope', () => {
  it('passes success paths through the guard untouched (list, save, delete)', async () => {
    expect(await invoke<CustomAgentsSnapshot>(IPC.listCustomAgents)).toMatchObject({
      agents: expect.any(Array),
      diagnostics: expect.any(Array)
    })

    const saved = await invoke<CustomAgentsSnapshot>(IPC.saveCustomAgent, {
      name: 'ipc-round-x',
      description: 'round trip',
      tools: ['read'],
      enabled: true,
      persona: 'p'
    })
    expect(saved.agents.some((agent) => agent.name === 'ipc-round-x')).toBe(true)

    const deleted = await invoke<CustomAgentsSnapshot>(IPC.deleteCustomAgent, { name: 'ipc-round-x' })
    expect(deleted.agents.some((agent) => agent.name === 'ipc-round-x')).toBe(false)
  })

  it('wraps saveCustomAgent traversal rejections in the error envelope', async () => {
    const result = await failure(IPC.saveCustomAgent, {
      name: '../../evil',
      description: 'd',
      tools: ['read'],
      enabled: true,
      persona: 'p'
    })
    expect(result.code).toBe('INVALID_INPUT')
    expect(String(result.message)).toMatch(/invalid subagent name/)
  })

  it('wraps saveCustomAgent built-in refusal in the error envelope', async () => {
    const result = await failure(IPC.saveCustomAgent, {
      name: 'researcher',
      description: 'd',
      tools: ['read'],
      enabled: true,
      persona: 'p'
    })
    expect(result.code).toBe('INVALID_INPUT')
    expect(String(result.message)).toMatch(/built-in/)
  })

  it('wraps deleteCustomAgent traversal rejections in the error envelope', async () => {
    const result = await failure(IPC.deleteCustomAgent, { name: 'a/b' })
    expect(result.code).toBe('INVALID_INPUT')
    expect(String(result.message)).toMatch(/invalid subagent name/)
  })

  it('wraps deleteCustomAgent built-in refusal in the error envelope', async () => {
    const result = await failure(IPC.deleteCustomAgent, { name: 'researcher' })
    expect(result.code).toBe('INVALID_INPUT')
    expect(String(result.message)).toMatch(/built-in/)
  })

  it('wraps setCustomAgentEnabled traversal rejections in the error envelope', async () => {
    const result = await failure(IPC.setCustomAgentEnabled, { name: '..', enabled: false })
    expect(result.code).toBe('INVALID_INPUT')
    expect(String(result.message)).toMatch(/invalid subagent name/)
  })

  it('wraps setCustomAgentEnabled built-in refusal in the error envelope', async () => {
    const result = await failure(IPC.setCustomAgentEnabled, { name: 'researcher', enabled: false })
    expect(result.code).toBe('INVALID_INPUT')
    expect(String(result.message)).toMatch(/built-in/)
  })
})
