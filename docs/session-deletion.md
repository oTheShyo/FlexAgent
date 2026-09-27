# Session deletion: what "delete" removes, and when it refuses

Ticket 29. A session is five things at once, and "delete" has to mean all
five:

| Thing | Where it lives | On delete |
| --- | --- | --- |
| Kernel session (PI host) | worker process memory | disposed, then unloaded |
| Terminal (PTY) | main process | destroyed |
| Registry row | `flex-agent/sessions.json` | removed |
| Permission rules | settings store | dropped (`dropRulesForSession`) |
| **Transcript file** | `~/.pi/agent/sessions/**/*.jsonl` (or fork files next to it) | **unlinked** |

The transcript holds the full conversation — messages, tool output, paths,
fragments. Its only pointer is the row's `piSessionFile` field: before this
ticket, delete removed the pointer and left the bytes on disk forever.

## Order is the safety property

Every step that can fail runs **while the row still exists**, so a refused
delete always leaves a session the user can still open:

1. **Dispose the kernel host.** A live worker that rejects the dispose means
   the host may still hold the file; the delete aborts with `SESSION_BUSY`
   and *nothing* is touched. A worker that was already dead is the opposite
   signal — nothing in memory holds the file — and the delete proceeds.
   Liveness is captured **before** the dispose call, because the worker's
   auto-restart would otherwise turn a "nobody holds it" rejection into
   "a live worker refused" after a crash-and-respawn window.
2. **Unlink the transcript.** Two guards: another row pointing at the same
   file keeps it (`shared-kept`), and an OS-level unlink failure (locked,
   permissions) aborts with the row intact so the retry stays possible.
3. **Terminal, row, rules.** None of these can orphan data.

The renderer surfaces a refusal as a normal contract error; the session list
does not change.

## Fork lineage (ticket 17 interaction)

- A fork child's transcript header carries `parentSession` pointing at the
  parent's PI id, and its registry row carries `derivedFrom`. Both are
  **annotations**; they never load, read, or cascade.
- Deleting the parent **does not cascade** to children: they are independent
  sessions with their own files. Opening a child passes only the child's own
  `piSessionFile`, so a missing parent file cannot break the child's cold
  load (covered by `tests/sessionDeletion.test.ts`).
- Deleting a child never touches the parent.

## Retention policy: hard delete, no undo

Delete is immediate and final. There is no recycle bin and no delayed
unlink, deliberately: a retention feature is only honest together with a UI
to browse and purge it, and a silent half-version (files kept, no way to see
them) recreates exactly the unbounded, unreachable growth this ticket closes.
If undo is ever wanted, it ships with the UI in the same change.

## Rollback paths follow the pointer too

`createSession` and `forkSession` remove their row when they fail after the
transcript was attached; both now unlink the attached file first
(`rollbackRowTranscript`). Those paths cannot abort the rollback (the row is
condemned either way), so an unlink failure there is logged loudly
(`[session-deletion] …`) instead of swallowed.

## Known residuals

- **Worker died mid-create/mid-fork, before the response.** The file exists
  but no row ever learned its path; main has nothing to follow. Fixing this
  requires the worker to journal created paths — not observable from main
  today. The fork diag script's sweep (`forkFilesOf` + registry diff) is the
  manual escape hatch for these.
- **Unlink failure during rollback** (above): logged, file orphaned until a
  manual sweep.
- Delete has no undo (policy above).

## Where deletion is wired (repo search, 2026-09-27)

Session rows are removed in exactly three places — `ipc.ts` `createSession`
rollback, `forkSession` rollback, and `deleteSession` — and all three follow
`piSessionFile`. The plugin marketplace/plugins `registry.remove` calls belong
to `PluginRegistry`, a different registry with no transcripts.
