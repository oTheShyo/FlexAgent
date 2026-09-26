import { describe, expect, it } from 'vitest'
import {
  aggregateLlmCalls,
  aggregateToolCalls,
  buildUsageStats,
  parseJsonl
} from '../src/main/usageStats'

function call(row: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'llm_call', ok: true, ...row })
}

describe('parseJsonl', () => {
  it('skips blank lines and unparseable ones instead of failing the report', () => {
    const rows = parseJsonl('{"a":1}\n\nnot json\n{"b":2}')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ a: 1 })
  })

  it('skips a truncated last line — append-only writes lose at most one', () => {
    expect(parseJsonl('{"a":1}\n{"b":')).toEqual([{ a: 1 }])
  })
})

describe('aggregateLlmCalls', () => {
  it('sums tokens per model and per call source', () => {
    const lines = [
      call({ ts: 1_700_000_000_000, model: 'USTC/qwen-chat', callSource: 'chat', tokens: { input: 100, output: 20 } }),
      call({ ts: 1_700_000_000_000, model: 'USTC/qwen-chat', callSource: 'chat', tokens: { input: 300, output: 50 } }),
      call({ ts: 1_700_000_000_000, model: 'USTC/glm', callSource: 'permission_classifier', tokens: { input: 10, output: 1 } })
    ]
    const agg = aggregateLlmCalls(parseJsonl(lines.join('\n')))
    expect(agg.totals.calls).toBe(3)
    expect(agg.totals.input).toBe(410)
    expect(agg.totals.output).toBe(71)
    expect(agg.totals.total).toBe(481)
    expect(agg.byModel.map((b) => b.key)).toEqual(['USTC/qwen-chat', 'USTC/glm'])
    expect(agg.byModel[0]!.total).toBe(470)
    // The axis that makes an auxiliary feature's cost visible.
    expect(agg.byCallSource.map((b) => b.key)).toEqual(['chat', 'permission_classifier'])
    expect(agg.byCallSource[1]!.total).toBe(11)
  })

  it('counts cache tokens into the total and failures separately', () => {
    const lines = [
      call({ ts: 1, callSource: 'chat', tokens: { input: 10, output: 5, cacheRead: 7, cacheWrite: 3 } }),
      call({ ts: 1, callSource: 'chat', ok: false, tokens: { input: 1, output: 0 } })
    ]
    const agg = aggregateLlmCalls(parseJsonl(lines.join('\n')))
    expect(agg.totals.cacheRead).toBe(7)
    expect(agg.totals.total).toBe(26)
    expect(agg.totals.failed).toBe(1)
  })

  it('ignores non-LLM pipeline rows so a skill download is not billed as tokens', () => {
    const lines = [JSON.stringify({ kind: 'skill_hub', ok: false, stage: 'download' })]
    expect(aggregateLlmCalls(parseJsonl(lines.join('\n'))).totals.calls).toBe(0)
  })

  it('groups by UTC day, oldest first, and reports the covered range', () => {
    const lines = [
      call({ ts: Date.parse('2026-09-02T10:00:00Z'), callSource: 'chat' }),
      call({ ts: Date.parse('2026-09-01T10:00:00Z'), callSource: 'chat' })
    ]
    const agg = aggregateLlmCalls(parseJsonl(lines.join('\n')))
    expect(agg.byDay.map((b) => b.key)).toEqual(['2026-09-01', '2026-09-02'])
    expect(agg.firstTs).toBe(Date.parse('2026-09-01T10:00:00Z'))
    expect(agg.lastTs).toBe(Date.parse('2026-09-02T10:00:00Z'))
  })

  it('counts distinct sessions, not rows', () => {
    const lines = [
      call({ ts: 1, sessionId: 'a', callSource: 'chat' }),
      call({ ts: 1, sessionId: 'a', callSource: 'chat' }),
      call({ ts: 1, sessionId: 'b', callSource: 'chat' })
    ]
    expect(aggregateLlmCalls(parseJsonl(lines.join('\n'))).sessions.size).toBe(2)
  })
})

describe('aggregateToolCalls', () => {
  it('counts tool_start and ranks the busiest tools', () => {
    const rows = parseJsonl(
      [
        JSON.stringify({ type: 'tool_start', name: 'bash' }),
        JSON.stringify({ type: 'tool_start', name: 'bash' }),
        JSON.stringify({ type: 'tool_start', name: 'read' }),
        JSON.stringify({ type: 'tool_end', name: 'bash' })
      ].join('\n')
    )
    const tools = aggregateToolCalls(rows)
    expect(tools.total).toBe(3)
    expect(tools.byTool).toEqual([
      { name: 'bash', count: 2 },
      { name: 'read', count: 1 }
    ])
  })
})

describe('buildUsageStats', () => {
  it('reports an empty, non-throwing state when nothing was recorded', () => {
    const stats = buildUsageStats({ llmCallsText: '', eventsText: [] })
    expect(stats.hasData).toBe(false)
    expect(stats.totals.calls).toBe(0)
    expect(stats.byModel).toEqual([])
    expect(stats.toolCalls).toBe(0)
  })

  it('combines both streams and keeps the tool ranking capped', () => {
    const stats = buildUsageStats({
      llmCallsText: call({ ts: 1, model: 'm', callSource: 'chat', tokens: { input: 5, output: 5 } }),
      eventsText: [JSON.stringify({ type: 'tool_start', name: 'bash' })]
    })
    expect(stats.hasData).toBe(true)
    expect(stats.totals.total).toBe(10)
    expect(stats.toolCalls).toBe(1)
    expect(stats.sessions).toBe(0)
  })
})
