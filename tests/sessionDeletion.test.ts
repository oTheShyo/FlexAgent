import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '../src/shared/contract'
import {
  deleteSessionRecord,
  rollbackRowTranscript,
  type DeleteSessionDeps,
  type TranscriptIo
} from '../src/main/sessionDeletion'
import { forkSessionFile } from '../src/main/sessionFork'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flexagent-delete-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

interface Harness {
  deps: DeleteSessionDeps
  events: string[]
  warnings: string[]
}

function makeDeps(overrides: Partial<DeleteSessionDeps> = {}): Harness {
  const events: string[] = []
  const warnings: string[] = []
  const deps: DeleteSessionDeps = {
    transcriptOwners: () => [],
    exists: () => true,
    unlink: () => {
      events.push('unlink')
    },
    warn: (message: string) => warnings.push(message),
    disposeKernel: async () => {
      events.push('dispose')
    },
    kernelAlive: true,
    removeTerminal: () => {
      events.push('terminal')
    },
    removeRow: () => {
      events.push('row')
    },
    dropRules: async () => {
      events.push('rules')
    },
    ...overrides
  }
  return { deps, events, warnings }
}

describe('deleteSessionRecord', () => {
  const ID: SessionId = 'session-under-test'

  it('follows the pointer: dispose, unlink, terminal, row, rules — in that order', async () => {
    const { deps, events } = makeDeps()
    const outcome = await deleteSessionRecord(ID, '/transcripts/session.jsonl', deps)
    expect(events).toEqual(['dispose', 'unlink', 'terminal', 'row', 'rules'])
    expect(outcome.transcript).toBe('deleted')
    expect(outcome.sharedWith).toEqual([])
  })

  it('aborts when a live kernel refuses to dispose: nothing else is touched', async () => {
    const { deps, events } = makeDeps({
      disposeKernel: async () => {
        events.push('dispose')
        throw new Error('host is mid-run')
      },
      kernelAlive: true
    })
    await expect(deleteSessionRecord(ID, '/transcripts/session.jsonl', deps)).rejects.toMatchObject({
      code: 'SESSION_BUSY'
    })
    expect(events).toEqual(['dispose'])
  })

  it('deletes anyway when the worker was already dead — nothing in memory holds the file', async () => {
    const { deps, events } = makeDeps({
      disposeKernel: async () => {
        events.push('dispose')
        throw new Error('worker not running')
      },
      kernelAlive: false
    })
    const outcome = await deleteSessionRecord(ID, '/transcripts/session.jsonl', deps)
    expect(events).toEqual(['dispose', 'unlink', 'terminal', 'row', 'rules'])
    expect(outcome.transcript).toBe('deleted')
  })

  it('keeps a transcript another row still points at, but removes this row', async () => {
    const { deps, events } = makeDeps({
      transcriptOwners: () => ['other-session']
    })
    const outcome = await deleteSessionRecord(ID, '/transcripts/session.jsonl', deps)
    expect(events).toEqual(['dispose', 'terminal', 'row', 'rules'])
    expect(outcome.transcript).toBe('shared-kept')
    expect(outcome.sharedWith).toEqual(['other-session'])
  })

  it('reports an already-missing file without calling unlink', async () => {
    const { deps, events } = makeDeps({ exists: () => false })
    const outcome = await deleteSessionRecord(ID, '/transcripts/session.jsonl', deps)
    expect(events).toEqual(['dispose', 'terminal', 'row', 'rules'])
    expect(outcome.transcript).toBe('already-gone')
  })

  it('handles a session that never had a transcript attached', async () => {
    const { deps, events } = makeDeps()
    const outcome = await deleteSessionRecord(ID, undefined, deps)
    expect(events).toEqual(['dispose', 'terminal', 'row', 'rules'])
    expect(outcome.transcript).toBe('none')
  })

  it('aborts with the row intact when the filesystem refuses the unlink', async () => {
    const { deps, events } = makeDeps({
      unlink: () => {
        events.push('unlink')
        throw new Error('EBUSY: file locked')
      }
    })
    await expect(deleteSessionRecord(ID, '/transcripts/session.jsonl', deps)).rejects.toThrow(
      'EBUSY'
    )
    expect(events).toEqual(['dispose', 'unlink'])
  })
})

describe('rollbackRowTranscript', () => {
  const ID: SessionId = 'failing-create'

  function io(overrides: Partial<TranscriptIo> = {}): { io: TranscriptIo; warnings: string[] } {
    const warnings: string[] = []
    return {
      io: {
        transcriptOwners: () => [],
        exists: () => true,
        unlink: () => {},
        warn: (message: string) => warnings.push(message),
        ...overrides
      },
      warnings
    }
  }

  it('unlinks the attached transcript before its row disappears', () => {
    const unlinked: string[] = []
    const { io: deps } = io({ unlink: (file) => unlinked.push(file) })
    rollbackRowTranscript('/transcripts/forked.jsonl', ID, deps)
    expect(unlinked).toEqual(['/transcripts/forked.jsonl'])
  })

  it('keeps the file when another row owns it', () => {
    const unlinked: string[] = []
    const { io: deps } = io({
      transcriptOwners: () => ['owner'],
      unlink: (file) => unlinked.push(file)
    })
    rollbackRowTranscript('/transcripts/shared.jsonl', ID, deps)
    expect(unlinked).toEqual([])
  })

  it('skips a session that never attached a file', () => {
    const unlinked: string[] = []
    const { io: deps } = io({ unlink: (file) => unlinked.push(file) })
    rollbackRowTranscript(undefined, ID, deps)
    expect(unlinked).toEqual([])
  })

  it('cannot abort — an unlink failure is logged loudly instead', () => {
    const { io: deps, warnings } = io({
      unlink: () => {
        throw new Error('EPERM')
      }
    })
    expect(() => rollbackRowTranscript('/transcripts/orphan.jsonl', ID, deps)).not.toThrow()
    expect(warnings.join(' ')).toContain('orphan')
    expect(warnings.join(' ')).toContain('/transcripts/orphan.jsonl')
  })
})

describe('real files (acceptance: the transcript is really gone)', () => {
  const PARENT: SessionId = 'parent-session'

  function transcript(file: string, id: string): void {
    const header = JSON.stringify({
      type: 'session',
      version: 1,
      id,
      timestamp: '2026-09-27T00:00:00.000Z',
      cwd: 'C:\\proj'
    })
    const message = JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'answer to keep',
        stopReason: 'stop',
        timestamp: 1
      }
    })
    writeFileSync(file, `${header}\n${message}\n`, 'utf8')
  }

  function realIo(owners: (file: string, exceptId: SessionId) => SessionId[] = () => []): TranscriptIo {
    return {
      transcriptOwners: owners,
      exists: existsSync,
      unlink: (file) => rmSync(file, { force: false })
    }
  }

  function realDeps(io: TranscriptIo): DeleteSessionDeps {
    return {
      ...io,
      disposeKernel: async () => {},
      kernelAlive: true,
      removeTerminal: () => {},
      removeRow: () => {},
      dropRules: async () => {}
    }
  }

  it('deletes a session and its transcript file is not on disk afterwards', async () => {
    const dir = freshDir()
    const file = join(dir, 'session.jsonl')
    transcript(file, 'pi-1')
    const outcome = await deleteSessionRecord('s1', file, realDeps(realIo()))
    expect(outcome.transcript).toBe('deleted')
    expect(existsSync(file)).toBe(false)
  })

  it('deleting the parent leaves the fork child loadable from its own file', async () => {
    const dir = freshDir()
    const parentFile = join(dir, 'parent.jsonl')
    transcript(parentFile, 'pi-parent')
    const forked = forkSessionFile(parentFile, { ts: 1, prefix: 'answer to keep' }, 'pi-child')
    expect(existsSync(forked.file)).toBe(true)

    const outcome = await deleteSessionRecord(PARENT, parentFile, realDeps(realIo()))
    expect(outcome.transcript).toBe('deleted')
    expect(existsSync(parentFile)).toBe(false)

    // The child is self-contained: its header still names the (now gone)
    // parent as lineage, and its entries parse without it.
    const lines = readFileSync(forked.file, 'utf8').split('\n').filter(Boolean)
    const header = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(header.id).toBe('pi-child')
    expect(header.parentSession).toBe('pi-parent')
    expect(lines).toHaveLength(2)
    expect(() => JSON.parse(lines[1] ?? '')).not.toThrow()
  })
})
