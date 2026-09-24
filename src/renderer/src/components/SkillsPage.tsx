import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MemoryCard, MemoryCardFile, SkillPendingWrite, SkillSummary } from '../types'
import { codexApi } from '../api'
import { Button, Chip } from './ui'
import { PluginsIcon } from './icons'

const SOURCE_LABEL: Record<SkillSummary['source'], string> = {
  user: 'Agent skills',
  plugin: 'Plugin skills'
}

const SOURCE_ORDER: SkillSummary['source'][] = ['user', 'plugin']

const MEMORY_FILE_LABEL: Record<MemoryCardFile, string> = {
  MEMORY: 'Project & environment',
  USER: 'User profile'
}

function SkillsSkeleton() {
  return (
    <ul
      role="status"
      aria-busy="true"
      aria-label="Loading skills"
      className="space-y-2"
    >
      {['72%', '55%', '64%'].map((width) => (
        <li
          key={width}
          className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
        >
          <span aria-hidden="true" className="h-8 w-8 animate-pulse rounded-lg bg-[var(--active)]" />
          <span aria-hidden="true" className="h-3 animate-pulse rounded-md bg-[var(--active)]" style={{ width }} />
        </li>
      ))}
    </ul>
  )
}

function PendingSection({
  writes,
  busyId,
  onApprove,
  onReject
}: {
  writes: SkillPendingWrite[]
  busyId: string | null
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  return (
    <section aria-label="Pending skill writes">
      <h2 className="flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
        Pending writes
        <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">
          {writes.length}
        </span>
      </h2>
      <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
        The agent staged these skill changes for your review (skills.writeApproval). Approving
        applies them and refreshes the kernel.
      </p>
      <div className="mt-2 space-y-2">
        {writes.map((write) => (
          <div
            key={write.id}
            data-testid={`skill-pending-${write.id}`}
            className="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2.5"
          >
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium text-[var(--text)]">
                {write.skillName || '(unnamed)'}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-[var(--text-muted)]">
                {new Date(write.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <ul className="mt-1 space-y-0.5 text-xs leading-5 text-[var(--text-secondary)]">
              {write.summary.map((line, index) => (
                <li key={index}>· {line}</li>
              ))}
            </ul>
            {write.targetPaths.length > 0 && (
              <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
                {write.targetPaths.join('  ·  ')}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="primary"
                disabled={busyId !== null}
                onClick={() => onApprove(write.id)}
                data-testid={`skill-approve-${write.id}`}
                className="h-7 px-2.5 text-[11px]"
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                disabled={busyId !== null}
                onClick={() => onReject(write.id)}
                data-testid={`skill-reject-${write.id}`}
                className="h-7 px-2.5 text-[11px]"
              >
                Reject
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function SkillsPage() {
  const [loading, setLoading] = useState(true)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [pending, setPending] = useState<SkillPendingWrite[]>([])
  const [cards, setCards] = useState<MemoryCard[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [memoryFile, setMemoryFile] = useState<MemoryCardFile>('MEMORY')
  const [memoryDraft, setMemoryDraft] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [skillList, pendingList, cardList] = await Promise.all([
        codexApi.listSkills(),
        codexApi.listPendingSkillWrites(),
        codexApi.listMemoryCards()
      ])
      setSkills(skillList)
      setPending(pendingList)
      setCards(cardList)
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

  const handlePending = useCallback(
    async (id: string, action: 'approve' | 'reject'): Promise<void> => {
      setBusyId(id)
      try {
        if (action === 'approve') await codexApi.approveSkillWrite(id)
        else await codexApi.rejectSkillWrite(id)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [refresh]
  )

  const handleAddCard = useCallback(async (): Promise<void> => {
    const text = memoryDraft.trim()
    if (text.length === 0) return
    setBusyId('memory-add')
    try {
      await codexApi.addMemoryCard(memoryFile, text)
      setMemoryDraft('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }, [memoryDraft, memoryFile, refresh])

  const handleRemoveCard = useCallback(
    async (card: MemoryCard): Promise<void> => {
      setBusyId(`memory-${card.file}-${card.index}`)
      try {
        await codexApi.removeMemoryCard(card.file, card.index)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [refresh]
  )

  const sections = useMemo(() => {
    return SOURCE_ORDER.map((source) => ({
      source,
      label: SOURCE_LABEL[source],
      items: skills.filter((skill) => skill.source === source)
    })).filter((section) => section.items.length > 0)
  }, [skills])

  const memoryGroups = useMemo(() => {
    return (['MEMORY', 'USER'] as MemoryCardFile[])
      .map((file) => ({
        file,
        label: MEMORY_FILE_LABEL[file],
        items: cards.filter((card) => card.file === file)
      }))
  }, [cards])

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6" data-testid="skills-page">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">Skills & Memory</h1>
      </div>

      {error !== null && (
        <div
          role="alert"
          data-testid="skills-error"
          className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--warning)]" />
          <span className="min-w-0 flex-1 truncate">{error}</span>
        </div>
      )}

      <div className="mt-4 space-y-6">
        {pending.length > 0 && (
          <PendingSection
            writes={pending}
            busyId={busyId}
            onApprove={(id) => void handlePending(id, 'approve')}
            onReject={(id) => void handlePending(id, 'reject')}
          />
        )}

        <section aria-label="Skills">
          <h2 className="flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
            Skills
            <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">
              {skills.length}
            </span>
          </h2>
          {loading ? (
            <div className="mt-2">
              <SkillsSkeleton />
            </div>
          ) : sections.length === 0 ? (
            <div className="mt-2 flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-6 py-10 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] shadow-[var(--shadow-sm)]">
                <PluginsIcon className="h-5 w-5" />
              </div>
              <h3 className="text-sm font-semibold tracking-tight text-[var(--text)]">No skills yet</h3>
              <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--text-muted)]">
                The agent creates skills itself via <code>skill_manage</code> when it finds a
                reusable workflow. Plugin-bundled skills appear here too.
              </p>
            </div>
          ) : (
            <div className="mt-2 space-y-4">
              {sections.map((section) => (
                <div key={section.source}>
                  <div className="text-[11px] font-medium text-[var(--text-muted)]">{section.label}</div>
                  <div className="mt-1.5 space-y-2">
                    {section.items.map((skill) => (
                      <div
                        key={`${skill.source}-${skill.pluginId ?? ''}-${skill.name}`}
                        data-testid={`skill-row-${skill.name}`}
                        className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                          <PluginsIcon />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--text)]">{skill.name}</div>
                          {skill.description !== undefined && (
                            <div className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                              {skill.description}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                          {skill.source === 'user' ? 'user' : (skill.pluginId ?? 'plugin')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-label="Memory">
          <h2 className="flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
            Memory cards
            <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">
              {cards.length}
            </span>
          </h2>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
            Curated facts injected into every session. The agent maintains them via{' '}
            <code>memory_manage</code>; edits here apply from the next turn.
          </p>

          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void handleAddCard()
            }}
          >
            <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Memory file">
              {(['MEMORY', 'USER'] as MemoryCardFile[]).map((file) => (
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
              value={memoryDraft}
              onChange={(event) => setMemoryDraft(event.target.value)}
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
              disabled={busyId !== null || memoryDraft.trim().length === 0}
              className="shrink-0"
              data-testid="memory-add"
            >
              Add
            </Button>
          </form>

          <div className="mt-3 space-y-3">
            {memoryGroups.map((group) => (
              <div key={group.file}>
                <div className="text-[11px] font-medium text-[var(--text-muted)]">{group.label}</div>
                {group.items.length === 0 ? (
                  <div className="mt-1 text-xs text-[var(--text-subtle)]">No cards.</div>
                ) : (
                  <ul className="mt-1.5 space-y-1.5">
                    {group.items.map((card) => (
                      <li
                        key={`${card.file}-${card.index}`}
                        data-testid={`memory-card-${card.file}-${card.index}`}
                        className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 text-xs leading-5 text-[var(--text-secondary)]">
                          {card.text}
                        </span>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void handleRemoveCard(card)}
                          aria-label={`Remove card: ${card.text.slice(0, 40)}`}
                          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

export default SkillsPage
