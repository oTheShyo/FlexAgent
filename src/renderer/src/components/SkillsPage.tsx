import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  MemoryCard,
  MemoryCardFile,
  SkillHubEntry,
  SkillHubInfo,
  SkillPendingWrite,
  SkillSummary
} from '../types'
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

// ─── Skill Hub tab ────────────────────────────────────────────────────────────

function HubView({
  onInstalledChanged,
  onError
}: {
  onInstalledChanged: () => Promise<void>
  onError: (message: string | null) => void
}) {
  const [hubs, setHubs] = useState<SkillHubInfo[]>([])
  const [entries, setEntries] = useState<SkillHubEntry[]>([])
  const [activeHub, setActiveHub] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [browsing, setBrowsing] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [addHubOpen, setAddHubOpen] = useState(false)
  const [addHubName, setAddHubName] = useState('')
  const [addHubUrl, setAddHubUrl] = useState('')

  const refreshHubs = useCallback(async (): Promise<void> => {
    const list = await codexApi.listSkillHubs()
    setHubs(list)
    setActiveHub((current) => current ?? list[0]?.id ?? null)
  }, [])

  const browse = useCallback(
    async (hubId: string | null): Promise<void> => {
      setBrowsing(true)
      try {
        setEntries(await codexApi.browseSkillHub(hubId ?? undefined))
        onError(null)
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
        setEntries([])
      } finally {
        setBrowsing(false)
      }
    },
    [onError]
  )

  useEffect(() => {
    void (async () => {
      try {
        await refreshHubs()
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [refreshHubs, onError])

  useEffect(() => {
    if (activeHub !== null) void browse(activeHub)
  }, [activeHub, browse])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return entries
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        (entry.description ?? '').toLowerCase().includes(needle)
    )
  }, [entries, query])

  const handleInstall = useCallback(
    async (entry: SkillHubEntry, overwrite = false): Promise<void> => {
      setBusyName(entry.name)
      try {
        await codexApi.installSkill({ source: { kind: 'hub', hub: entry.hub, name: entry.name }, overwrite })
        await Promise.all([browse(activeHub), onInstalledChanged(), refreshHubs()])
        onError(null)
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyName(null)
      }
    },
    [activeHub, browse, onInstalledChanged, onError, refreshHubs]
  )

  const handleAddLocal = useCallback(async (): Promise<void> => {
    const dir = await codexApi.pickDirectory()
    if (dir === null) return
    setBusyName('(local)')
    try {
      await codexApi.installSkill({ source: { kind: 'folder', folderPath: dir } })
      await Promise.all([browse(activeHub), onInstalledChanged()])
      onError(null)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyName(null)
    }
  }, [activeHub, browse, onInstalledChanged, onError])

  const handleAddHub = useCallback(async (): Promise<void> => {
    const name = addHubName.trim()
    const url = addHubUrl.trim()
    if (name.length === 0 || url.length === 0) return
    setBusyName('(hub)')
    try {
      const hub = await codexApi.addSkillHub({ name, url })
      setAddHubOpen(false)
      setAddHubName('')
      setAddHubUrl('')
      await refreshHubs()
      setActiveHub(hub.id)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyName(null)
    }
  }, [addHubName, addHubUrl, onError, refreshHubs])

  const handleRemoveHub = useCallback(
    async (id: string): Promise<void> => {
      setBusyName(`(hub:${id})`)
      try {
        await codexApi.removeSkillHub(id)
        const list = await codexApi.listSkillHubs()
        setHubs(list)
        if (activeHub === id) setActiveHub(list[0]?.id ?? null)
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyName(null)
      }
    },
    [activeHub, onError]
  )

  if (loading) {
    return (
      <div className="mt-2">
        <SkillsSkeleton />
      </div>
    )
  }

  return (
    <section aria-label="Skill Hub">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
          Skill Hub
          <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">
            {filtered.length}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={busyName !== null}
            onClick={() => void handleAddLocal()}
            data-testid="skill-add-local"
            className="h-7 px-2.5 text-[11px]"
          >
            + Add from folder
          </Button>
          <Button
            variant="secondary"
            disabled={busyName !== null}
            onClick={() => setAddHubOpen((open) => !open)}
            data-testid="skill-add-hub"
            className="h-7 px-2.5 text-[11px]"
          >
            + Add hub
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
        Install ready-made skills into the agent's own skill home
        (<code>~/.flexagent/skills</code>). Hubs are GitHub repos or JSON indexes.
      </p>

      {addHubOpen && (
        <form
          className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            void handleAddHub()
          }}
        >
          <input
            type="text"
            value={addHubName}
            onChange={(event) => setAddHubName(event.target.value)}
            placeholder="hub id (e.g. team)"
            aria-label="New hub id"
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-32 shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          />
          <input
            type="text"
            value={addHubUrl}
            onChange={(event) => setAddHubUrl(event.target.value)}
            placeholder="github:owner/repo  or  https://…/skills.json"
            aria-label="New hub url"
            autoComplete="off"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={busyName !== null || addHubName.trim().length === 0 || addHubUrl.trim().length === 0}
            className="shrink-0"
          >
            Add
          </Button>
        </form>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Skill hubs">
        {hubs.map((hub) => (
          <span key={hub.id} className="inline-flex items-center">
            <Chip
              active={activeHub === hub.id}
              onClick={() => setActiveHub(hub.id)}
              aria-pressed={activeHub === hub.id}
              className="h-7 px-2.5 text-[11px]"
            >
              {hub.name}
            </Chip>
            {!hub.builtIn && (
              <button
                type="button"
                disabled={busyName !== null}
                onClick={() => void handleRemoveHub(hub.id)}
                aria-label={`Remove hub ${hub.name}`}
                className="-ml-1 rounded-md px-1 text-[10px] text-[var(--text-subtle)] transition-colors hover:text-[var(--text)] disabled:opacity-40"
              >
                ✕
              </button>
            )}
          </span>
        ))}
      </div>

      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search skills…"
        aria-label="Search hub skills"
        autoComplete="off"
        spellCheck={false}
        className="mt-2 h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        data-testid="skill-hub-search"
      />

      {browsing ? (
        <div className="mt-2">
          <SkillsSkeleton />
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-2 flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-6 py-8 text-center">
          <h3 className="text-sm font-semibold tracking-tight text-[var(--text)]">Nothing here</h3>
          <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--text-muted)]">
            The hub returned no skills matching the current search.
          </p>
        </div>
      ) : (
        <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="skill-hub-grid">
          {filtered.map((entry) => (
            <li
              key={`${entry.hub}-${entry.name}`}
              data-testid={`skill-hub-entry-${entry.name}`}
              className="flex items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                <PluginsIcon />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--text)]">{entry.name}</div>
                {entry.description !== undefined && (
                  <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-[var(--text-muted)]">
                    {entry.description}
                  </div>
                )}
                <div className="mt-1 truncate text-[10px] text-[var(--text-subtle)]">
                  {entry.label ?? entry.source}
                </div>
              </div>
              {entry.installed ? (
                <span
                  data-testid={`skill-installed-${entry.name}`}
                  className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]"
                >
                  Installed
                </span>
              ) : (
                <Button
                  variant="secondary"
                  disabled={busyName !== null}
                  onClick={() => void handleInstall(entry)}
                  data-testid={`skill-install-${entry.name}`}
                  className="h-7 w-7 shrink-0 px-0 text-sm"
                  aria-label={`Install ${entry.name}`}
                >
                  +
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function SkillsPage() {
  const [tab, setTab] = useState<'installed' | 'hub'>('installed')
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

  const handleUninstall = useCallback(
    async (name: string): Promise<void> => {
      setBusyId(`uninstall-${name}`)
      try {
        await codexApi.uninstallSkill(name)
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

  const installedView = (
    <div className="space-y-6">
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
              Install one from the Skill Hub tab, load a local folder, or let the agent create
              skills itself via <code>skill_manage</code>.
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
                      {skill.source === 'user' && (
                        <Button
                          variant="secondary"
                          disabled={busyId !== null}
                          onClick={() => void handleUninstall(skill.name)}
                          data-testid={`skill-uninstall-${skill.name}`}
                          className="h-7 shrink-0 px-2 text-[11px]"
                        >
                          Uninstall
                        </Button>
                      )}
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
  )

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6" data-testid="skills-page">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">Skills & Memory</h1>
        <div className="flex items-center gap-1" role="tablist" aria-label="Skills views">
          <Chip
            active={tab === 'installed'}
            onClick={() => setTab('installed')}
            aria-pressed={tab === 'installed'}
            className="h-7 px-2.5 text-[11px]"
          >
            Installed
          </Chip>
          <Chip
            active={tab === 'hub'}
            onClick={() => setTab('hub')}
            aria-pressed={tab === 'hub'}
            className="h-7 px-2.5 text-[11px]"
          >
            Skill Hub
          </Chip>
        </div>
      </div>

      {error !== null && (
        <div
          role="alert"
          data-testid="skills-error"
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

      <div className="mt-4">
        {tab === 'installed' ? (
          installedView
        ) : (
          <HubView
            onInstalledChanged={refresh}
            onError={setError}
          />
        )}
      </div>
    </div>
  )
}

export default SkillsPage
