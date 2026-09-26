import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { forkSessionFile } from '../src/main/sessionFork'

const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flexagent-fork-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function header(id: string): string {
  return JSON.stringify({
    type: 'session',
    version: 1,
    id,
    timestamp: '2026-09-26T00:00:00.000Z',
    cwd: 'C:\\proj'
  })
}

function message(role: string, text: string, ts: number, stopReason: string): string {
  return JSON.stringify({
    type: 'message',
    id: `entry-${ts}`,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role,
      content: [{ type: 'text', text }],
      timestamp: ts,
      stopReason
    }
  })
}

function configChange(kind: 'model_change' | 'thinking_level_change', ts: number): string {
  return JSON.stringify({
    type: kind,
    id: `cfg-${ts}`,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    ...(kind === 'model_change' ? { provider: 'anthropic', model: 'x' } : { thinkingLevel: 'high' })
  })
}

function writeTranscript(dir: string, lines: string[]): string {
  const file = join(dir, 'sess.jsonl')
  writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

describe('forkSessionFile', () => {
  it('keeps entries up to and including the matched assistant message', () => {
    const dir = freshDir()
    const file = writeTranscript(dir, [
      header('pi-source'),
      message('user', 'first question', 1000, 'stop'),
      message('assistant', 'first answer', 1100, 'stop'),
      message('user', 'second question', 2000, 'stop'),
      message('assistant', 'second answer', 2100, 'stop')
    ])

    const result = forkSessionFile(file, { ts: 1100, prefix: 'first answer' }, 'pi-new')

    const lines = readFileSync(result.file, 'utf8').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('first question')
    expect(lines[2]).toContain('first answer')
    expect(lines.join('\n')).not.toContain('second question')
    expect(result.entriesDropped).toBe(2)
  })

  it('rewrites the header id and records the source as parentSession', () => {
    const dir = freshDir()
    const file = writeTranscript(dir, [
      header('pi-source'),
      message('assistant', 'answer', 1100, 'stop')
    ])

    const result = forkSessionFile(file, { ts: 1100, prefix: 'answer' }, 'pi-forked')

    const parsedHeader = JSON.parse(readFileSync(result.file, 'utf8').split('\n')[0]!) as Record<
      string,
      unknown
    >
    expect(parsedHeader.id).toBe('pi-forked')
    expect(parsedHeader.parentSession).toBe('pi-source')
    expect(parsedHeader.type).toBe('session')
  })

  it('drops config changes that only appear after the fork point', () => {
    const dir = freshDir()
    const file = writeTranscript(dir, [
      header('pi-source'),
      configChange('thinking_level_change', 900),
      message('assistant', 'answer', 1100, 'stop'),
      configChange('model_change', 1500),
      message('assistant', 'later answer', 2100, 'stop')
    ])

    const result = forkSessionFile(file, { ts: 1100, prefix: 'answer' }, 'pi-forked')
    const text = readFileSync(result.file, 'utf8')

    expect(text).toContain('thinking_level_change')
    expect(text).not.toContain('model_change')
    expect(text).not.toContain('later answer')
  })

  it('never matches a failed or aborted assistant turn', () => {
    const dir = freshDir()
    const file = writeTranscript(dir, [
      header('pi-source'),
      message('assistant', 'half an answer', 1100, 'error'),
      message('assistant', 'interrupted answer', 2100, 'aborted')
    ])

    expect(() => forkSessionFile(file, { ts: 1100, prefix: 'half an answer' }, 'pi-new')).toThrow(
      /no stable completed assistant message/
    )
  })

  it('never matches a user message or a tool result', () => {
    const dir = freshDir()
    const file = writeTranscript(dir, [
      header('pi-source'),
      message('user', 'the question', 1000, 'stop'),
      JSON.stringify({
        type: 'message',
        id: 'tool-1',
        parentId: null,
        timestamp: new Date(1200).toISOString(),
        message: { role: 'toolResult', content: 'tool output', timestamp: 1200 }
      })
    ])

    expect(() => forkSessionFile(file, { ts: 1000, prefix: 'the question' }, 'pi-new')).toThrow()
    expect(() => forkSessionFile(file, { ts: 1200, prefix: 'tool output' }, 'pi-new')).toThrow()
  })

  it('falls back to prefix matching when the transcript carries no message timestamp', () => {
    const dir = freshDir()
    const file = writeTranscript(dir, [
      header('pi-source'),
      JSON.stringify({
        type: 'message',
        id: 'no-ts',
        parentId: null,
        timestamp: '2026-09-26T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'timestampless answer' }], stopReason: 'stop' }
      }),
      message('assistant', 'a later answer', 2100, 'stop')
    ])

    const result = forkSessionFile(file, { ts: 999999, prefix: 'timestampless answer' }, 'pi-new')
    const text = readFileSync(result.file, 'utf8')
    expect(text).toContain('timestampless answer')
    expect(text).not.toContain('a later answer')
  })

  it('refuses an empty fork point', () => {
    const dir = freshDir()
    const file = writeTranscript(dir, [header('pi-source')])
    expect(() => forkSessionFile(file, { prefix: '   ' }, 'pi-new')).toThrow(/no text to match/)
  })

  it('refuses when the transcript file is gone', () => {
    const dir = freshDir()
    expect(() =>
      forkSessionFile(join(dir, 'missing.jsonl'), { prefix: 'anything' }, 'pi-new')
    ).toThrow(/transcript file is gone/)
  })

  it('tolerates malformed lines between entries', () => {
    const dir = freshDir()
    const file = writeTranscript(dir, [
      header('pi-source'),
      '{ this is not json',
      message('assistant', 'good answer', 1100, 'stop'),
      'also broken'
    ])

    const result = forkSessionFile(file, { ts: 1100, prefix: 'good answer' }, 'pi-new')
    expect(result.entriesKept).toBe(3)
  })
})
