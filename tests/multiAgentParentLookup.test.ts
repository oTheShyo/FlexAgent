import { describe, expect, it } from 'vitest'
import { resolveByAnySessionId } from '../src/main/agents/parentLookup'

/**
 * Regression for ticket 03 (multi-agent e2e): children address the parent by
 * PI's session-file uuid (`ctx.sessionManager.getSessionId()`), while the
 * worker's session table is keyed by the kernel SessionId. Looking the table
 * up by the PI id alone made every child permission forward deny with "the
 * parent session ended while the child was running" and misattributed every
 * `role_task` ledger row to an id no session owns.
 *
 * e2e pins (scripts/diag-multie2e.mjs, real model): `single` asserts the
 * role_task row carries the kernel session id; `perm-default` asserts the
 * child's bash call reaches the parent's UI channel as `subagent-*` and is
 * answered deny with a `child-permission` audit record.
 */
interface Host {
  sessionId: string
  piSessionId: string
}

const host = (sessionId: string, piSessionId: string): Host => ({ sessionId, piSessionId })
const piIdOf = (h: Host): string => h.piSessionId

describe('resolveByAnySessionId', () => {
  it('resolves a host by its table key', () => {
    const sessions = new Map([['kernel-1', host('kernel-1', 'pi-file-1')]])
    expect(resolveByAnySessionId(sessions, 'kernel-1', piIdOf)?.sessionId).toBe('kernel-1')
  })

  it('resolves a host addressed by the PI session-file id', () => {
    const sessions = new Map([
      ['kernel-1', host('kernel-1', 'pi-file-1')],
      ['kernel-2', host('kernel-2', 'pi-file-2')]
    ])
    expect(resolveByAnySessionId(sessions, 'pi-file-2', piIdOf)?.sessionId).toBe('kernel-2')
  })

  it('prefers the table key when a PI id collides with another host key', () => {
    const sessions = new Map([
      ['kernel-1', host('kernel-1', 'pi-file-1')],
      ['kernel-2', host('kernel-2', 'kernel-1')]
    ])
    expect(resolveByAnySessionId(sessions, 'kernel-1', piIdOf)?.sessionId).toBe('kernel-1')
  })

  it('returns undefined for an id that matches neither space', () => {
    const sessions = new Map([['kernel-1', host('kernel-1', 'pi-file-1')]])
    expect(resolveByAnySessionId(sessions, 'disposed-parent', piIdOf)).toBeUndefined()
  })

  it('returns undefined when the table is empty', () => {
    expect(resolveByAnySessionId(new Map<string, Host>(), 'pi-file-1', piIdOf)).toBeUndefined()
  })
})
