/**
 * Session attach latency probe.
 *
 * Attaching a session to the PI kernel is the slow path behind "New chat" and
 * chat switching: it loads the PI module graph, waits on MCP handshakes,
 * reloads the resource loader and constructs an agent session. Set
 * FLEXAGENT_PERF=1 to print per-stage timings — `[perf] <label> {…}` lines on
 * the main (or worker) stdout. Off by default, so it costs nothing in normal runs.
 */
export interface PerfTrace {
  mark(label: string): void
  done(label: string, meta?: Record<string, unknown>): void
}

export function perfStart(): PerfTrace {
  const enabled = process.env.FLEXAGENT_PERF === '1'
  const start = Date.now()
  let last = start
  const marks: Record<string, number> = {}
  return {
    mark(label) {
      const now = Date.now()
      marks[label] = now - last
      last = now
    },
    done(label, meta) {
      if (!enabled) return
      console.log(
        `[perf] ${label} ${JSON.stringify({ ...marks, total: Date.now() - start, ...meta })}`
      )
    }
  }
}
