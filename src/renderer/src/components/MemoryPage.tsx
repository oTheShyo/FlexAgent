import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MemoryCard, MemoryCardFile } from '../types'
import { codexApi } from '../api'
import { Button, Chip } from './ui'

const MEMORY_FILE_LABEL: Record<MemoryCardFile, string> = {
  MEMORY: 'Project & environment',
  USER: 'User profile'
}

const FILE_ORDER: MemoryCardFile[] = ['MEMORY', 'USER']

/**
 * Memory cards — declarative facts/preferences the agent injects into every
 * session. Kept separate from Skills: the two differ in lifecycle (install vs.
 * curate), cost model (progressive disclosure vs. every-turn context) and
 * sharing (publishable vs. machine-private).
 */
export default function MemoryPage() {
  const [cards, setCards] = useState<MemoryCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [memoryFile, setMemoryFile] = useState<MemoryCardFile>('MEMORY')
  const [draft, setDraft] = useState('')
  const [draftScope, setDraftScope] = useState('')
  const [notices, setNotices] = useState<string[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setCards(await codexApi.listMemoryCards())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAdd = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0) return
    setBusyId('memory-add')
    setNotices([])
    try {
      // Advisory only: the card is stored even when the linter objects, so the
      // warning is shown rather than thrown. A rejected card does throw.
      const scope = draftScope.trim()
      const receipt = await codexApi.addMemoryCard(memoryFile, text, scope.length > 0 ? scope : undefined)
      setNotices(receipt.warnings ?? [])
      setDraft('')
      setDraftScope('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }, [draft, draftScope, memoryFile, refresh])

  const handleRemove = useCallback(
    async (card: MemoryCard): Promise<void> => {
      setBusyId(`memory-${card.file}-${card.id}`)
      try {
        // By id, not position: an index captured before an earlier removal
        // points at whatever shifted into its place.
        await codexApi.removeMemoryCard(card.file, card.id)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [refresh]
  )

  const groups = useMemo(
    () =>
      FILE_ORDER.map((file) => ({
        file,
        label: MEMORY_FILE_LABEL[file],
        items: cards.filter((card) => card.file === file)
      })),
    [cards]
  )

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6" data-testid="memory-page">
      <h1 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">Memory</h1>
      <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
        Curated facts injected into every session. The agent maintains them via{' '}
        <code>memory_manage</code>; edits here apply from the next turn. Stored locally in{' '}
        <code>~/.flexagent/memory/</code>. A card with a scope is only shown in sessions working in
        that directory.
      </p>

      {error !== null && (
        <div
          role="alert"
          className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--warning)]" />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="shrink-0 rounded px-1 text-[11px] hover:text-[var(--text)]"
          >
            ✕
          </button>
        </div>
      )}

      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void handleAdd()
        }}
      >
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Memory file">
          {FILE_ORDER.map((file) => (
            <Chip
              key={file}
              active={memoryFile === file}
              onClick={() => setMemoryFile(file)}
              aria-pressed={memoryFile === file}
              className="h-7 px-2.5 text-[11px]"
            >
              {file}
            </Chip>
          ))}
        </div>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a durable fact…"
          aria-label="New memory card"
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          data-testid="memory-add-input"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={busyId !== null || draft.trim().length === 0}
          className="shrink-0"
          data-testid="memory-add"
        >
          Add
        </Button>
      </form>
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--text-subtle)]">
        <label htmlFor="memory-scope" className="shrink-0">
          Scope (optional)
        </label>
        <input
          id="memory-scope"
          type="text"
          value={draftScope}
          onChange={(event) => setDraftScope(event.target.value)}
          placeholder="Leave empty for everywhere, or paste a project path"
          autoComplete="off"
          spellCheck={false}
          aria-label="Memory card scope"
          className="h-6 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[11px] text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          data-testid="memory-scope-input"
        />
      </div>

      {notices.length > 0 && (
        <ul
          role="status"
          data-testid="memory-notices"
          className="mt-3 space-y-1 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-[11px] leading-5 text-[var(--warning-text)]"
        >
          {notices.map((notice) => (
            <li key={notice}>Stored, but: {notice}</li>
          ))}
        </ul>
      )}

      {loading ? (
        <div role="status" aria-busy="true" aria-label="Loading memory cards" className="mt-4 space-y-2">
          {['78%', '62%', '70%'].map((width) => (
            <div
              key={width}
              className="h-9 animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface)]"
              style={{ width }}
            />
          ))}
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {groups.map((group) => (
            <section key={group.file} aria-label={group.label}>
              <h2 className="flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                {group.label}
                <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">
                  {group.items.length}
                </span>
              </h2>
              {group.items.length === 0 ? (
                <div className="mt-1.5 text-xs text-[var(--text-subtle)]">No cards.</div>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {group.items.map((card) => (
                    <li
                      key={`${card.file}-${card.id}`}
                      data-testid={`memory-card-${card.file}-${card.index}`}
                      className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="block text-xs leading-5 text-[var(--text-secondary)]">
                          {card.text}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-subtle)]">
                          {card.scope !== undefined && (
                            <span
                              data-testid={`memory-card-scope-${card.file}-${card.index}`}
                              title="Only injected in sessions working in this directory"
                              className="rounded border border-[var(--border)] px-1 py-px"
                            >
                              scope: {card.scope}
                            </span>
                          )}
                          {card.updatedAt !== undefined && (
                            <span data-testid={`memory-card-updated-${card.file}-${card.index}`}>
                              updated {new Date(card.updatedAt).toLocaleDateString()}
                            </span>
                          )}
                          {card.createdAt !== undefined && card.createdAt !== card.updatedAt && (
                            <span title={`Created ${new Date(card.createdAt).toLocaleString()}`}>
                              since {new Date(card.createdAt).toLocaleDateString()}
                            </span>
                          )}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void handleRemove(card)}
                        aria-label={`Remove card: ${card.text.slice(0, 40)}`}
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
