/**
 * Deleting a session (ticket 29): what "delete" has to mean.
 *
 * A session is five things at once — a kernel host, a terminal, a registry
 * row, a set of permission rules, and the PI transcript file holding the full
 * conversation (tool output, paths, fragments and all). The row's
 * `piSessionFile` is the *only* pointer to that file: remove the row and the
 * bytes stay on disk forever with nothing left that knows they exist. That is
 * the leak this module closes — deletion follows the pointer.
 *
 * Order is the whole design. Every step that can fail runs while the row
 * still exists, so an aborted delete leaves a session the user can still
 * open:
 *
 *   1. dispose the kernel host — a live worker that refuses to let go may
 *      still hold the file, so abort before touching anything. A *dead*
 *      worker is the opposite signal (nothing in memory holds the file) and
 *      falls through to the delete.
 *   2. unlink the transcript — refused when another row points at the same
 *      file; an OS-level unlink failure aborts with the row intact.
 *   3. drop the terminal, the row, and the session's permission rules — none
 *      of these fail in ways that can orphan data.
 *
 * What this cannot fix, recorded in docs/session-deletion.md: a worker that
 * dies after creating a file but before responding leaves a file no row ever
 * pointed at. Main never learns that path, so there is no pointer to follow.
 */
import { existsSync, unlinkSync } from 'fs'
import type { SessionId } from '../shared/contract'
import { ContractError } from '../shared/contract'

export interface TranscriptIo {
  /** Rows other than `exceptId` pointing at the same file. */
  transcriptOwners: (file: string, exceptId: SessionId) => SessionId[]
  exists: (file: string) => boolean
  unlink: (file: string) => void
  /** Residuals that cannot abort (rollback paths only). */
  warn?: (message: string) => void
}

export interface DeleteSessionDeps extends TranscriptIo {
  /** May reject; the SESSION_BUSY contract depends on how it rejects. */
  disposeKernel: (id: SessionId) => Promise<void>
  /**
   * Kernel worker liveness captured *before* dispose was attempted. A worker
   * that dies mid-request must not read as "a live worker refused"; capture
   * up front so the auto-restart cannot change the verdict after the fact.
   */
  kernelAlive: boolean
  removeTerminal: (id: SessionId) => void
  removeRow: (id: SessionId) => void
  dropRules: (id: SessionId) => Promise<void>
}

export type TranscriptOutcome = 'deleted' | 'shared-kept' | 'already-gone' | 'none'

export interface DeleteSessionOutcome {
  transcript: TranscriptOutcome
  sharedWith: SessionId[]
}

/**
 * Delete a session end to end. Throws SESSION_BUSY (touching nothing past
 * dispose) when a live kernel still holds it; throws the raw unlink error
 * with the row intact when the filesystem refuses. Resolving means the row,
 * terminal, rules, and transcript are all gone — or the transcript was
 * deliberately kept because another row owns it.
 */
export async function deleteSessionRecord(
  id: SessionId,
  file: string | undefined,
  deps: DeleteSessionDeps
): Promise<DeleteSessionOutcome> {
  // 1. Dispose first; abort on failure. Unlinking under a host that may still
  //    hold the file open is the exact mistake this ticket exists to prevent.
  try {
    await deps.disposeKernel(id)
  } catch (err) {
    if (deps.kernelAlive) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new ContractError(
        'SESSION_BUSY',
        `delete aborted: the kernel still holds this session (${detail}); nothing was removed`
      )
    }
    // Worker gone when dispose was attempted: the process that could have
    // held the file no longer exists, so its transcript is safe to remove.
  }

  // 2. The transcript, guarded. Two rows sharing one file means the file is
  //    still wanted; a failed unlink aborts while the row (and therefore the
  //    pointer) is intact, so a retry stays possible instead of orphaning.
  let transcript: TranscriptOutcome = 'none'
  let sharedWith: SessionId[] = []
  if (file !== undefined) {
    sharedWith = deps.transcriptOwners(file, id)
    if (sharedWith.length > 0) {
      transcript = 'shared-kept'
    } else if (!deps.exists(file)) {
      transcript = 'already-gone'
    } else {
      deps.unlink(file)
      transcript = 'deleted'
    }
  }

  // 3. Teardown — from here down nothing can orphan data.
  deps.removeTerminal(id)
  deps.removeRow(id)
  await deps.dropRules(id)

  return { transcript, sharedWith }
}

/**
 * Rollback paths (create/fork failing after the transcript was attached):
 * the row must go — the session never existed as far as the user is
 * concerned — but dropping the row without the file recreates this ticket's
 * orphan, so follow the pointer first. Unlink failure cannot abort here (the
 * row is already condemned), so it is logged loudly instead.
 */
export function rollbackRowTranscript(
  file: string | undefined,
  retiringId: SessionId,
  io: TranscriptIo
): void {
  if (file === undefined) return
  if (io.transcriptOwners(file, retiringId).length > 0) return
  if (!io.exists(file)) return
  try {
    io.unlink(file)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    io.warn?.(`rollback left an orphan transcript (unlink failed): ${file} — ${detail}`)
  }
}

export function fsTranscriptIo(
  transcriptOwners: (file: string, exceptId: SessionId) => SessionId[]
): TranscriptIo {
  return {
    transcriptOwners,
    exists: existsSync,
    unlink: unlinkSync,
    warn: (message: string) => console.warn(`[session-deletion] ${message}`)
  }
}
