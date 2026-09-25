/**
 * Resolve a session host however a multi-agent child can address it.
 *
 * The worker's session table is keyed by the *kernel* SessionId, but the
 * `task` tool only sees what PI's tool context offers —
 * `ctx.sessionManager.getSessionId()`, the session-file uuid PI generated —
 * a different id space (a v7 uuid where the kernel key is v4). Every child
 * report and every permission forward carries that PI id, so the lookup tries
 * the table key first, then matches on the PI id. Re-derived per call rather
 * than kept as a second index, so a session-file switch cannot leave it stale.
 *
 * Returns undefined when neither id matches (parent disposed); callers fall
 * back to their existing "parent session ended" deny.
 */
export function resolveByAnySessionId<T>(
  sessions: ReadonlyMap<string, T>,
  id: string,
  piSessionId: (host: T) => string
): T | undefined {
  const direct = sessions.get(id)
  if (direct !== undefined) return direct
  for (const host of sessions.values()) {
    if (piSessionId(host) === id) return host
  }
  return undefined
}
