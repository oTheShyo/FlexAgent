import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode
} from 'react'
import type {
  ModelConfig,
  ModelOption,
  PermissionMode,
  SessionSearchHit,
  SessionSummary,
  SlashCommandSummary,
  ThinkingLevel
} from '../types'
import { codexApi } from '../api'
import { pathBasename } from '../lib/paths'
import { ModeSwitcher } from './ModeSwitcher'
import { createComposerFileIndex } from './composerFiles'
import {
  composePrompt,
  describeRejections,
  formatBytes,
  stageAttachments
} from './composerAttachments'
import type { StagedAttachment } from './composerAttachments'
import {
  addReference,
  createSelectionReference,
  createSessionReference,
  formatReferencesBlock,
  MAX_REFERENCES,
  MAX_TOTAL_REFERENCE_CHARS,
  countReferenceChars,
  truncateLabel
} from './composerReferences'
import type { ContextReference } from './composerReferences'
import type { SelectionSource } from '../hooks/useChatSelection'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { debounce } from '../lib/debounce'
import { Button, Chip, IconButton, MenuItem, MenuPanel } from './ui'
import {
  EFFORT_NO_MODEL_REASON,
  EFFORT_UNSUPPORTED_REASON,
  PERMISSION_MODES,
  REASONING_EFFORT_GLOSS,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_OFF_LABEL,
  resolveEffortTiers
} from '../types'
import {
  ChatDotIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  QueueIcon,
  SendIcon,
  SlashIcon,
  StopIcon,
  TrashIcon
} from './icons'

export interface ComposerProps {
  onSend: (text: string) => void
  /** Aborts the run in progress; wired into the send-button slot while running. */
  onStop: () => void
  disabled?: boolean
  running?: boolean
  cwd?: string
  onChooseProject?: () => void
  /** True while the kernel rebuilds the session against a new workspace. */
  projectBusy?: boolean
  modelConfig?: ModelConfig | null
  modelOptions?: ModelOption[]
  /**
   * True while a session exists but its model is not known yet (attaching).
   * Drives the chip's loading copy — an unresolved model must never masquerade
   * as a model called "Model".
   */
  modelResolving?: boolean
  slashCommands?: SlashCommandSummary[]
  onSetModel?: (provider: string, id: string) => void
  onSetThinkingLevel?: (level: ThinkingLevel) => void
  /** Trust level for the active session; rendered as a live control, not a label. */
  permissionMode: PermissionMode
  permissionPending?: boolean
  onChangePermissionMode: (mode: PermissionMode) => void
  /** Messages typed during the running turn, waiting for it to finish. */
  queuedMessages?: readonly string[]
  onQueueRemove?: (index: number) => void
  onQueueSendNow?: (index: number) => void
  /**
   * References staged for this draft, from any entry point (`@`, a transcript
   * selection, `#`). Sent with the draft, cleared with it.
   */
  references?: readonly ContextReference[]
  onReferencesChange?: (next: readonly ContextReference[]) => void
  /**
   * One-shot channel for a selection made in the transcript: it arrives from a
   * sibling of this component, so App forwards it here and the pick is consumed
   * the moment it is staged — a copy, never a live re-read.
   */
  selectionPick?: { text: string; source: SelectionSource; token: number } | null
  onSelectionPickConsumed?: () => void
  /** Chats offered by `#`; the open one is excluded — a chat cannot reference itself. */
  sessions?: readonly SessionSummary[]
  activeSessionId?: string | null
}

const MENTION_BEFORE_CARET = /@[\w./-]*$/
const SLASH_AT_START = /^\/([\w-]*)$/
/** `#` stops at whitespace: a chat title with spaces closes the list at that point. */
const SESSION_BEFORE_CARET = /#([^\s@]*)$/
/** short enough that the popup still feels keyed to the keystrokes. */
const MENTION_DEBOUNCE_MS = 120

interface SessionOption {
  id: string
  title: string
  snippet?: string
  updatedAt: number
  /** A title-only match carries no content; the chip and the prompt say so. */
  hasSnippet: boolean
}
/** Long enough that a burst of keystrokes is one scan, short enough to feel immediate. */
const SESSION_SEARCH_DEBOUNCE_MS = 250
const SESSION_POPUP_LIMIT = 8
/** Rows of the transcript that hand text over, and what they are called. */
const SELECTION_LABELS: Record<SelectionSource, string> = {
  assistant: 'Assistant reply',
  tool: 'Tool output',
  user: 'Your message',
  error: 'Error'
}

/** The five trust levels, in the order the mode menu lists them. */
const PERMISSION_MODE_SPECTRUM: readonly PermissionMode[] = PERMISSION_MODES

function matchMentionQuery(value: string, caret: number): string | null {
  const match = value.slice(0, caret).match(MENTION_BEFORE_CARET)
  return match === null ? null : match[0].slice(1)
}

function matchSlashQuery(value: string, caret: number): string | null {
  const match = value.slice(0, caret).match(SLASH_AT_START)
  return match === null ? null : match[1]
}

function matchSessionQuery(value: string, caret: number): string | null {
  const match = value.slice(0, caret).match(SESSION_BEFORE_CARET)
  return match === null ? null : match[1]
}

interface CompletionItem {
  id: string
  label: string
  hint?: string
  mono?: boolean
  icon: ReactNode
}

interface CompletionPopupProps {
  listId: string
  ariaLabel: string
  emptyLabel: string
  items: CompletionItem[]
  selectedIndex: number
  onSelect: (index: number) => void
  onPick: (id: string) => void
}

function CompletionPopup({
  listId,
  ariaLabel,
  emptyLabel,
  items,
  selectedIndex,
  onSelect,
  onPick
}: CompletionPopupProps) {
  return (
    <ul
      id={listId}
      role="listbox"
      aria-label={ariaLabel}
      className="fx-pop absolute inset-x-1.5 bottom-full z-30 mb-2 max-h-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]"
    >
      {items.length === 0 ? (
        <li role="presentation" className="px-3 py-2 text-xs text-[var(--text-muted)]">
          {emptyLabel}
        </li>
      ) : (
        items.map((item, index) => {
          const isSelected = index === selectedIndex
          return (
            <li key={item.id} role="presentation">
              <div
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                onMouseMove={() => onSelect(index)}
                onClick={() => onPick(item.id)}
                tabIndex={-1}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]${
                  item.mono === true ? ' font-mono' : ''
                } ${
                  isSelected
                    ? 'bg-[var(--active)] font-medium text-[var(--text)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--hover)]'
                }`}
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint !== undefined && (
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-[var(--text-subtle)]">
                    {item.hint}
                  </span>
                )}
              </div>
            </li>
          )
        })
      )}
    </ul>
  )
}

interface AttachmentTrayProps {
  attachments: readonly StagedAttachment[]
  notice: string | null
  busy: boolean
  onRemove: (id: string) => void
}

function AttachmentTray({ attachments, notice, busy, onRemove }: AttachmentTrayProps) {
  if (attachments.length === 0 && notice === null && !busy) return null
  return (
    <div
      className="fx-fade border-b border-[var(--border)] pb-3"
      data-testid="composer-attachments"
    >
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span
                title={`${attachment.name} · ${formatBytes(attachment.size)} · contents are inlined into the message`}
                className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] py-1 pl-2 pr-1 text-xs text-[var(--text-secondary)]"
              >
                <FileIcon className="h-3 w-3 shrink-0 text-[var(--text-subtle)]" />
                <span className="max-w-[180px] truncate font-mono">{attachment.name}</span>
                <span className="shrink-0 text-[var(--text-subtle)]">
                  {formatBytes(attachment.size)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                  className="shrink-0 rounded px-1 text-[var(--text-subtle)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {busy && <p className="mt-1 text-xs text-[var(--text-muted)]">Reading files…</p>}
      {notice !== null && (
        <p
          role="status"
          data-testid="composer-attachment-notice"
          className="fx-fade mt-1 text-xs leading-4 text-[var(--warning-text)]"
        >
          {notice}
        </p>
      )}
    </div>
  )
}

interface ReferenceTrayProps {
  references: readonly ContextReference[]
  /** Why the last pick was refused; a refusal is never silent. */
  notice: string | null
  onRemove: (id: string) => void
}

function ReferenceTray({ references, notice, onRemove }: ReferenceTrayProps) {
  if (references.length === 0 && notice === null) return null
  const chars = countReferenceChars(references)
  return (
    <div
      className="fx-fade border-b border-[var(--border)] pb-3"
      data-testid="composer-references"
    >
      {references.length > 0 && (
        <>
          <ul className="flex flex-wrap gap-1.5">
            {references.map((reference) => (
              <li key={reference.id}>
                <span
                  title={
                    reference.partial === true
                      ? `${truncateLabel(reference.text, 160)} — title only: the transcript of this chat is not reachable from here`
                      : truncateLabel(reference.text, 160)
                  }
                  className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] py-1 pl-2 pr-1 text-xs text-[var(--text-secondary)]"
                >
                  {reference.kind === 'session' ? (
                    <ChatDotIcon className="h-3 w-3 shrink-0 text-[var(--text-subtle)]" />
                  ) : (
                    <FileIcon className="h-3 w-3 shrink-0 text-[var(--text-subtle)]" />
                  )}
                  <span className="max-w-[180px] truncate">{truncateLabel(reference.label)}</span>
                  {reference.partial === true && (
                    <span
                      title="Title only — no content could be collected for this chat"
                      className="shrink-0 rounded border border-[var(--border-strong)] px-1 text-[10px] text-[var(--text-muted)]"
                    >
                      title only
                    </span>
                  )}
                  <span className="shrink-0 text-[var(--text-subtle)]">
                    {reference.text.length} chars
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(reference.id)}
                    aria-label={`Remove reference ${truncateLabel(reference.label)}`}
                    className="shrink-0 rounded px-1 text-[var(--text-subtle)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
            {references.length} of {MAX_REFERENCES} references · {chars} of{' '}
            {MAX_TOTAL_REFERENCE_CHARS} characters — all of it travels with the message
          </p>
        </>
      )}
      {notice !== null && (
        <p
          role="status"
          data-testid="composer-reference-notice"
          className="fx-fade mt-1 text-[11px] leading-4 text-[var(--warning-text)]"
        >
          {notice}
        </p>
      )}
    </div>
  )
}

interface QueuedMessageTrayProps {
  messages: readonly string[]
  onEdit?: (index: number) => void
  onRemove?: (index: number) => void
  onSendNow?: (index: number) => void
}

function QueuedMessageTray({ messages, onEdit, onRemove, onSendNow }: QueuedMessageTrayProps) {
  if (messages.length === 0) return null
  const actionClass =
    'rounded-md p-1 text-[var(--text-subtle)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]'
  return (
    <ul
      aria-label="Queued messages"
      data-testid="queued-tray"
      className="fx-fade mx-auto mb-2 flex w-full max-w-3xl flex-col gap-1.5"
    >
      {messages.map((message, index) => (
        <li
          key={index}
          data-testid="queued-item"
          className="flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--info)_30%,var(--border))] bg-[color-mix(in_srgb,var(--info)_10%,transparent)] px-2.5 py-1.5"
        >
          <QueueIcon className="h-3.5 w-3.5 shrink-0 text-[var(--info)]" />
          <p className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-secondary)]">
            {message}
          </p>
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => onEdit?.(index)}
              aria-label="Edit queued message"
              title="Edit queued message"
              data-testid="queued-item-edit"
              className={actionClass}
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onRemove?.(index)}
              aria-label="Remove queued message"
              title="Remove queued message"
              data-testid="queued-item-remove"
              className={actionClass}
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onSendNow?.(index)}
              aria-label="Send queued message now"
              title="Send now (steer into the running turn)"
              data-testid="queued-item-send"
              className={actionClass}
            >
              <SendIcon className="h-3.5 w-3.5" />
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}

function Composer({
  onSend,
  onStop,
  disabled = false,
  running = false,
  cwd,
  onChooseProject,
  projectBusy = false,
  modelConfig = null,
  modelOptions = [],
  modelResolving = false,
  slashCommands = [],
  onSetModel,
  onSetThinkingLevel,
  permissionMode,
  permissionPending = false,
  onChangePermissionMode,
  queuedMessages = [],
  onQueueRemove,
  onQueueSendNow,
  references = [],
  onReferencesChange,
  selectionPick = null,
  onSelectionPickConsumed,
  sessions = [],
  activeSessionId = null
}: ComposerProps) {
  const [text, setText] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | null>(null)
  const [attachments, setAttachments] = useState<StagedAttachment[]>([])
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)
  const [stagingAttachments, setStagingAttachments] = useState(false)
  const [sessionQuery, setSessionQuery] = useState<string | null>(null)
  const [sessionIndex, setSessionIndex] = useState(0)
  const [referenceNotice, setReferenceNotice] = useState<string | null>(null)
  const [sessionHits, setSessionHits] = useState<SessionSearchHit[]>([])

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionQueryRef = useRef<string | null>(null)
  const slashQueryRef = useRef<string | null>(null)
  const sessionQueryRef = useRef<string | null>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const attachmentsRef = useRef<StagedAttachment[]>([])
  attachmentsRef.current = attachments
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const referencesRef = useRef<readonly ContextReference[]>(references)
  referencesRef.current = references
  const fileIndexRef = useRef(createComposerFileIndex())

  const canSend =
    !disabled &&
    (text.trim().length > 0 || attachments.length > 0 || references.length > 0)
  const showStop = running && text.trim().length === 0
  const slashOpen = slashQuery !== null
  const sessionOpen = !slashOpen && sessionQuery !== null
  const mentionOpen = !slashOpen && !sessionOpen && mentionQuery !== null

  const closeMenus = useCallback((): void => {
    setOpenMenu(null)
  }, [])

  useEffect(() => {
    if (disabled) setOpenMenu(null)
  }, [disabled])

  useEffect(() => {
    if (openMenu === null) return
    const container = modelMenuRef
    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (container.current !== null && !container.current.contains(target)) closeMenus()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenus()
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openMenu, closeMenus])

  // The query is debounced before it reaches the list source, and the source
  // caches per query: an identical query never recomputes. Today the source is a
  // static fixture, so this only avoids re-rendering the popup; when a real
  // `listFiles` lands it is the one place that has to change.
  const mentionListQuery = useDebouncedValue(mentionQuery, MENTION_DEBOUNCE_MS)
  const mentionFiles = useMemo(
    () => (mentionListQuery === null ? [] : fileIndexRef.current.query(mentionListQuery)),
    [mentionListQuery]
  )

  const mentionItems = useMemo<CompletionItem[]>(
    () =>
      mentionFiles.map((path) => ({
        id: path,
        label: path,
        mono: true,
        icon: <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-subtle)]" />
      })),
    [mentionFiles]
  )

  /**
   * `#` picks: chat titles the Composer already knows (no round trip) merged
   * with transcript hits from the main process, title matches first so a chat
   * whose name is what the user typed is never buried under an unrelated grep.
   *
   * A title match has no content behind it, so it is marked partial and the chip
   * says the transcript is out of reach rather than implying a quote.
   */
  const sessionOptions = useMemo<SessionOption[]>(() => {
    if (sessionQuery === null) return []
    const needle = sessionQuery.trim().toLowerCase()
    const picked: SessionOption[] = []
    const seen = new Set<string>()
    // An empty query lists the chats that are reachable at all (the open one is
    // never an option), the same way a bare `@` lists files.
    for (const session of sessions) {
      if (session.id === activeSessionId) continue
      if (needle.length > 0 && !session.title.toLowerCase().includes(needle)) continue
      if (seen.has(session.id)) continue
      seen.add(session.id)
      picked.push({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        hasSnippet: false
      })
    }
    for (const hit of sessionHits) {
      if (seen.has(hit.sessionId)) continue
      seen.add(hit.sessionId)
      picked.push({
        id: hit.sessionId,
        title: hit.title,
        snippet: hit.snippet,
        updatedAt: hit.updatedAt,
        hasSnippet: true
      })
    }
    return picked.slice(0, SESSION_POPUP_LIMIT)
  }, [sessionQuery, sessions, activeSessionId, sessionHits])

  const sessionItems = useMemo<CompletionItem[]>(
    () =>
      sessionOptions.map((option) => ({
        id: option.id,
        label: option.title,
        ...(option.snippet !== undefined && option.snippet.length > 0
          ? { hint: option.snippet }
          : {}),
        icon: <ChatDotIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-subtle)]" />
      })),
    [sessionOptions]
  )

  const slashItems = useMemo<CompletionItem[]>(() => {
    if (slashQuery === null) return []
    const query = slashQuery.toLowerCase()
    const matched = slashCommands.filter((command) =>
      command.name.toLowerCase().includes(query)
    )
    matched.sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1
      const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1
      return aStarts - bStarts
    })
    return matched.map((command) => ({
      id: command.name,
      label: `/${command.name}`,
      ...(command.description !== undefined ? { hint: command.description } : {}),
      icon: <SlashIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-subtle)]" />
    }))
  }, [slashQuery, slashCommands])

  const closeMention = useCallback((): void => {
    mentionQueryRef.current = null
    setMentionQuery(null)
    setMentionIndex(0)
  }, [])

  const closeSlash = useCallback((): void => {
    slashQueryRef.current = null
    setSlashQuery(null)
    setSlashIndex(0)
  }, [])

  const closeSession = useCallback((): void => {
    sessionQueryRef.current = null
    setSessionQuery(null)
    setSessionIndex(0)
  }, [])

  const closeCompletion = useCallback((): void => {
    closeMention()
    closeSlash()
    closeSession()
  }, [closeMention, closeSlash, closeSession])

  // Transcript search behind `#`. Cached per query string, because the same
  // needle typed twice (and every keystroke back onto it) re-scans stored
  // transcripts otherwise.
  const sessionHitsCacheRef = useRef(new Map<string, SessionSearchHit[]>())
  useEffect(() => {
    if (sessionQuery === null) {
      setSessionHits([])
      return
    }
    const needle = sessionQuery.trim()
    if (needle.length === 0) {
      setSessionHits([])
      return
    }
    const cacheKey = needle.toLowerCase()
    const cached = sessionHitsCacheRef.current.get(cacheKey)
    if (cached !== undefined) {
      setSessionHits(cached)
      return
    }
    let cancelled = false
    const run = debounce(() => {
      void codexApi
        .searchSessions(needle)
        .then((hits) => {
          if (cancelled) return
          sessionHitsCacheRef.current.set(cacheKey, hits)
          setSessionHits(hits)
        })
        .catch(() => {
          if (!cancelled) setSessionHits([])
        })
    }, SESSION_SEARCH_DEBOUNCE_MS)
    run()
    return () => {
      cancelled = true
      run.cancel()
    }
  }, [sessionQuery])

  const syncCompletion = useCallback((): void => {
    const el = textareaRef.current
    if (el === null) return
    const caret = el.selectionStart ?? el.value.length
    // A slash command is only recognised at the very start of the draft, so
    // path-like text later in the message never opens the command list.
    const slashNext = matchSlashQuery(el.value, caret)
    if (slashNext !== slashQueryRef.current) {
      slashQueryRef.current = slashNext
      setSlashQuery(slashNext)
      setSlashIndex(0)
    }
    if (slashNext !== null) {
      if (mentionQueryRef.current !== null) {
        mentionQueryRef.current = null
        setMentionQuery(null)
      }
      if (sessionQueryRef.current !== null) {
        sessionQueryRef.current = null
        setSessionQuery(null)
      }
      return
    }

    // `#` and `@` are the same gesture on different data, so only one of the two
    // lists may ever be open — a draft cannot be "attaching a file and a chat".
    const sessionNext = matchSessionQuery(el.value, caret)
    if (sessionNext !== sessionQueryRef.current) {
      sessionQueryRef.current = sessionNext
      setSessionQuery(sessionNext)
      setSessionIndex(0)
    }
    if (sessionNext !== null) {
      if (mentionQueryRef.current !== null) {
        mentionQueryRef.current = null
        setMentionQuery(null)
      }
      return
    }

    const mentionNext = matchMentionQuery(el.value, caret)
    if (mentionNext !== mentionQueryRef.current) {
      mentionQueryRef.current = mentionNext
      setMentionQuery(mentionNext)
      setMentionIndex(0)
    }
  }, [])

  const pickMention = useCallback(
    (path: string): void => {
      const el = textareaRef.current
      if (el === null) return
      const caret = el.selectionStart ?? el.value.length
      const before = el.value.slice(0, caret)
      const match = before.match(MENTION_BEFORE_CARET)
      if (match === null) {
        closeMention()
        return
      }
      const start = caret - match[0].length
      const snippet = `@${path} `
      setText(`${el.value.slice(0, start)}${snippet}${el.value.slice(caret)}`)
      pendingCaretRef.current = start + snippet.length
      closeMention()
    },
    [closeMention]
  )

  const pickSlashCommand = useCallback(
    (name: string): void => {
      const el = textareaRef.current
      if (el === null) return
      const caret = el.selectionStart ?? el.value.length
      if (matchSlashQuery(el.value, caret) === null) {
        closeSlash()
        return
      }
      const snippet = `/${name} `
      setText(`${snippet}${el.value.slice(caret)}`)
      pendingCaretRef.current = snippet.length
      closeSlash()
    },
    [closeSlash]
  )

  /**
   * Stages a `#` pick. A chat is referenced, not copied: the only content the
   * contract can hand over for a chat that is not the open one is the search
   * hit's snippet, so a title-only match becomes a chat named in the prompt and
   * nothing more (see `## Blocked by (new)` in the ticket).
   *
   * Nothing is written into the draft text — the chip and the prompt block are
   * the reference.
   */
  const pickSession = useCallback(
    (sessionId: string): void => {
      const el = textareaRef.current
      if (el === null) return
      if (matchSessionQuery(el.value, el.selectionStart ?? el.value.length) === null) {
        closeSession()
        return
      }
      const option = sessionOptions[sessionIndex]
      if (option === undefined || option.id !== sessionId) {
        closeSession()
        return
      }
      const candidate = createSessionReference({
        sessionId: option.id,
        title: option.title,
        ...(option.snippet !== undefined && option.snippet.length > 0
          ? { snippet: option.snippet }
          : {}),
        updatedAt: option.updatedAt
      })
      const applied = addReference(referencesRef.current, candidate)
      if (!applied.ok) {
        // The reason is the product: a silently dropped pick reads as a dead
        // button.
        setReferenceNotice(applied.reason)
        closeSession()
        return
      }
      onReferencesChange?.(applied.references)
      setReferenceNotice(null)
      closeSession()
    },
    [sessionOptions, sessionIndex, onReferencesChange, closeSession]
  )

  const acceptCompletion = useCallback((): boolean => {
    if (slashOpen) {
      const name = slashItems[slashIndex]?.id
      if (name !== undefined) pickSlashCommand(name)
      return true
    }
    if (sessionOpen) {
      const id = sessionItems[sessionIndex]?.id
      if (id !== undefined) pickSession(id)
      return true
    }
    if (mentionOpen) {
      const path = mentionItems[mentionIndex]?.id
      if (path !== undefined) pickMention(path)
      return true
    }
    return false
  }, [
    slashOpen,
    slashItems,
    slashIndex,
    pickSlashCommand,
    sessionOpen,
    sessionItems,
    sessionIndex,
    pickSession,
    mentionOpen,
    mentionItems,
    mentionIndex,
    pickMention
  ])

  const activeItems = slashOpen
    ? slashItems
    : sessionOpen
      ? sessionItems
      : mentionOpen
        ? mentionItems
        : []
  const setActiveIndex = slashOpen ? setSlashIndex : sessionOpen ? setSessionIndex : setMentionIndex

  useEffect(() => {
    if (pendingCaretRef.current === null) return
    const el = textareaRef.current
    const pos = pendingCaretRef.current
    pendingCaretRef.current = null
    if (el === null) return
    el.focus()
    el.setSelectionRange(pos, pos)
  }, [text])

  useEffect(() => {
    if (mentionIndex >= mentionFiles.length) {
      setMentionIndex(mentionFiles.length > 0 ? mentionFiles.length - 1 : 0)
    }
  }, [mentionFiles.length, mentionIndex])

  useEffect(() => {
    if (sessionIndex >= sessionItems.length) {
      setSessionIndex(sessionItems.length > 0 ? sessionItems.length - 1 : 0)
    }
  }, [sessionItems.length, sessionIndex])

  // A selection made in the transcript becomes a reference exactly once. The
  // text is the copy the hook froze at capture time, so a delta that lands
  // while the chip is being added cannot change what is staged.
  const stagedTokenRef = useRef<number | null>(null)
  useEffect(() => {
    if (selectionPick === null) return
    // A pick is staged once. Without the token guard a re-running effect (new
    // callback identity from the parent) would stage the same text a second
    // time and get it back as a duplicate, showing the user a limit error for
    // something they never tried to add twice.
    if (stagedTokenRef.current === selectionPick.token) return
    stagedTokenRef.current = selectionPick.token
    const candidate = createSelectionReference(
      selectionPick.text,
      SELECTION_LABELS[selectionPick.source]
    )
    const applied = addReference(referencesRef.current, candidate)
    if (!applied.ok) setReferenceNotice(applied.reason)
    else {
      onReferencesChange?.(applied.references)
      setReferenceNotice(null)
    }
    onSelectionPickConsumed?.()
  }, [selectionPick, onReferencesChange, onSelectionPickConsumed])

  useEffect(() => {
    if (slashIndex >= slashItems.length) {
      setSlashIndex(slashItems.length > 0 ? slashItems.length - 1 : 0)
    }
  }, [slashItems.length, slashIndex])

  const submit = (): void => {
    if (!canSend) return
    // The references travel inside the same string the kernel already receives;
    // the contract has no field of their own yet (see the ticket's Blocked by).
    const prompt = composePrompt(
      text.trim(),
      attachments,
      formatReferencesBlock(references)
    )
    onSend(prompt)
    setText('')
    setAttachments([])
    setAttachmentNotice(null)
    setReferenceNotice(null)
    onReferencesChange?.([])
    closeCompletion()
  }

  const editQueuedMessage = useCallback(
    (index: number): void => {
      const entry = queuedMessages[index]
      if (entry === undefined) return
      closeCompletion()
      setText(entry)
      pendingCaretRef.current = entry.length
      textareaRef.current?.focus()
      onQueueRemove?.(index)
    },
    [queuedMessages, onQueueRemove, closeCompletion]
  )

  const submitRef = useRef(submit)
  submitRef.current = submit

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.nativeEvent.isComposing) return

      const completionOpen =
        slashQueryRef.current !== null ||
        sessionQueryRef.current !== null ||
        mentionQueryRef.current !== null

      if (event.key === 'Escape') {
        if (completionOpen) {
          event.preventDefault()
          event.stopPropagation()
          closeCompletion()
        }
        return
      }

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        submitRef.current()
        return
      }

      if (completionOpen) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveIndex((index) =>
            activeItems.length === 0 ? 0 : (index + 1) % activeItems.length
          )
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveIndex((index) =>
            activeItems.length === 0
              ? 0
              : (index - 1 + activeItems.length) % activeItems.length
          )
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          acceptCompletion()
          return
        }
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submitRef.current()
      }
    },
    [activeItems.length, acceptCompletion, closeCompletion, setActiveIndex]
  )

  const handleTextChange = useCallback(
    (next: string): void => {
      setText(next)
      syncCompletion()
    },
    [syncCompletion]
  )

  const handleKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      // Escape already dismissed the popup; re-syncing here would reopen it
      // immediately because the draft still starts with "/" or "@".
      if (event.key === 'Escape') return
      syncCompletion()
    },
    [syncCompletion]
  )

  const stageFiles = useCallback(
    async (incoming: readonly File[]): Promise<void> => {
      if (incoming.length === 0) return
      setStagingAttachments(true)
      try {
        const { accepted, rejected } = await stageAttachments(incoming, attachmentsRef.current)
        if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted])
        setAttachmentNotice(describeRejections(rejected))
      } finally {
        setStagingAttachments(false)
      }
    },
    []
  )

  const removeAttachment = useCallback((id: string): void => {
    setAttachments((prev) => prev.filter((entry) => entry.id !== id))
    setAttachmentNotice(null)
  }, [])

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>): void => {
    const related = event.relatedTarget
    if (related instanceof Node && event.currentTarget.contains(related)) return
    setDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault()
      setDragOver(false)
      if (disabled) return
      void stageFiles(Array.from(event.dataTransfer?.files ?? []))
    },
    [disabled, stageFiles]
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>): void => {
      if (disabled) return
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length === 0) return
      // A copied image arrives as a file that cannot be inlined; let the tray
      // say so instead of letting the paste do nothing at all.
      event.preventDefault()
      void stageFiles(files)
    },
    [disabled, stageFiles]
  )

  const hasProject = cwd !== undefined && cwd.length > 0
  const projectLabel = projectBusy ? 'Binding…' : hasProject ? pathBasename(cwd) : 'No project'

  /**
   * What the chip says. Three states, and none of them invents a model name:
   * resolving (attaching), named (provider/id in the tooltip, so an id like
   * `qwen-chat` is unambiguous), or genuinely unset — which is an invitation to
   * pick one, not a placeholder pretending to be a name.
   */
  const knownModel = modelConfig?.model ?? null
  const modelLabel = modelResolving
    ? 'Resolving model…'
    : knownModel !== null
      ? (knownModel.label ?? knownModel.id)
      : 'Select model'
  const modelHint =
    knownModel !== null
      ? `${knownModel.provider}/${knownModel.id}`
      : modelResolving
        ? 'Waiting for the session to attach'
        : disabled
          ? 'A chat starts on the default model; pick another once it is open'
          : modelOptions.length === 0
            ? 'No usable model — add one in Settings › Models'
            : 'No model set for this chat — pick one here'
  const thinkingSuffix = knownModel === null ? '' : ` · ${modelConfig?.thinkingLevel}`
  const currentModel = knownModel
  const currentThinking = modelConfig === null ? null : modelConfig.thinkingLevel
  const thinkingLevels: ThinkingLevel[] =
    modelConfig === null
      ? []
      : (modelConfig.availableThinkingLevels ?? [modelConfig.thinkingLevel])
  const effortTiers = resolveEffortTiers(modelConfig?.availableThinkingLevels ?? null)
  const effortSupported = effortTiers.some((option) => option.available)
  const currentEffort = modelConfig?.effort ?? null
  const effortReason =
    knownModel === null
      ? EFFORT_NO_MODEL_REASON
      : effortSupported
        ? null
        : EFFORT_UNSUPPORTED_REASON
  const effortChipLabel =
    knownModel === null
      ? '推理'
      : !effortSupported
        ? '推理 · —'
        : currentEffort !== null
          ? `推理 · ${REASONING_EFFORT_LABELS[currentEffort]}`
          : currentThinking === 'off'
            ? `推理 · ${REASONING_EFFORT_OFF_LABEL}`
            : `推理 · ${currentThinking}`

  const activeOptionId = slashOpen
    ? slashItems[slashIndex] !== undefined
      ? `composer-slash-list-option-${slashIndex}`
      : undefined
    : sessionOpen && sessionItems[sessionIndex] !== undefined
      ? `composer-session-list-option-${sessionIndex}`
      : mentionOpen && mentionItems[mentionIndex] !== undefined
        ? `composer-mention-list-option-${mentionIndex}`
        : undefined

  const removeReference = useCallback((id: string): void => {
    setReferenceNotice(null)
    onReferencesChange?.(referencesRef.current.filter((entry) => entry.id !== id))
  }, [onReferencesChange])

  return (
    <div className="shrink-0 px-4 pb-4 pt-1" data-testid="composer">
      <div className="mx-auto w-full max-w-3xl">
        <button
          type="button"
          disabled={disabled || projectBusy || onChooseProject === undefined}
          onClick={() => onChooseProject?.()}
          data-testid="composer-project"
          title={
            projectBusy
              ? 'Rebuilding this chat against the new folder…'
              : hasProject
                ? cwd
                : 'No project — this chat runs in the scratch workspace. Pick a folder to give it one.'
          }
          className="mb-2 flex w-max max-w-full items-center gap-1.5 rounded-xl bg-[var(--surface-sunken)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FolderIcon className="h-3.5 w-3.5" />
          <span className="truncate">{projectLabel}</span>
          <ChevronDownIcon className="h-3 w-3" />
        </button>
      </div>

      {queuedMessages.length > 0 && (
        <QueuedMessageTray
          messages={queuedMessages}
          onEdit={editQueuedMessage}
          onRemove={onQueueRemove}
          onSendNow={onQueueSendNow}
        />
      )}

        <div className="relative mx-auto flex min-h-[168px] w-full max-w-3xl flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-[var(--ring)]">
        {slashOpen ? (
          <CompletionPopup
            listId="composer-slash-list"
            ariaLabel="Slash commands"
            emptyLabel="No matching commands"
            items={slashItems}
            selectedIndex={slashIndex}
            onSelect={setSlashIndex}
            onPick={pickSlashCommand}
          />
        ) : mentionOpen ? (
          <CompletionPopup
            listId="composer-mention-list"
            ariaLabel="File mentions"
            emptyLabel="No matching files"
            items={mentionItems}
            selectedIndex={mentionIndex}
            onSelect={setMentionIndex}
            onPick={pickMention}
          />
        ) : sessionOpen ? (
          <CompletionPopup
            listId="composer-session-list"
            ariaLabel="History chats"
            emptyLabel="No matching chats"
            items={sessionItems}
            selectedIndex={sessionIndex}
            onSelect={setSessionIndex}
            onPick={pickSession}
          />
        ) : null}

        {dragOver && (
          <div
            aria-hidden="true"
            className="fx-fade pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)] text-sm font-medium text-[var(--text-secondary)]"
          >
            Drop files to attach
          </div>
        )}

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          data-testid="composer-drop"
          className={`flex flex-1 flex-col p-4${dragOver ? ' rounded-2xl' : ''}`}
        >
          <AttachmentTray
            attachments={attachments}
            notice={attachmentNotice}
            busy={stagingAttachments}
            onRemove={removeAttachment}
          />

          <ReferenceTray
            references={references}
            notice={referenceNotice}
            onRemove={removeReference}
          />

          <textarea
            ref={textareaRef}
            rows={2}
            value={text}
            onChange={(event) => handleTextChange(event.target.value)}
            onKeyUp={handleKeyUp}
            onClick={syncCompletion}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              dragOver
                ? 'Drop files to attach'
                : running
                  ? 'Queue for after the current run'
                  : 'Do anything'
            }
            disabled={disabled}
            autoFocus
            spellCheck={false}
            aria-expanded={slashOpen || mentionOpen}
            aria-controls={
              slashOpen
                ? 'composer-slash-list'
                : mentionOpen
                  ? 'composer-mention-list'
                  : undefined
            }
            aria-activedescendant={activeOptionId}
            // The textarea itself stays ringless (a box inside the card reads
            // as clutter); focus visibility moves to the card via has-[:focus-visible].
            className="block min-h-[52px] w-full flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none disabled:opacity-40"
          />

          <div className="mt-auto flex items-center gap-1 pt-3">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (files.length > 0) void stageFiles(files)
              }}
            />
            <IconButton
              variant="ghost"
              label="Attach files"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              className="!rounded-lg"
            >
              <PlusIcon className="h-4 w-4" />
            </IconButton>

            <ModeSwitcher
              mode={permissionMode}
              pending={permissionPending}
              availableModes={PERMISSION_MODE_SPECTRUM}
              onChange={onChangePermissionMode}
              direction="up"
              compact
            />

            <div className="flex-1" />

            <div ref={modelMenuRef} className="relative flex items-center gap-1">
              <Chip
                disabled={
                  disabled ||
                  modelResolving ||
                  onSetThinkingLevel === undefined ||
                  effortReason !== null
                }
                onClick={() => setOpenMenu((menu) => (menu === 'effort' ? null : 'effort'))}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'effort'}
                aria-label={effortReason ?? undefined}
                title={effortReason ?? `推理强度 · thinking level ${currentThinking ?? 'off'}`}
                data-testid="composer-effort-chip"
                data-effort={currentEffort ?? ''}
                data-thinking-level={currentThinking ?? ''}
                className="gap-1 !border-transparent !px-1.5 !text-[var(--text-muted)] hover:!text-[var(--text)]"
              >
                <span className="truncate">{effortChipLabel}</span>
                <ChevronDownIcon className="h-3 w-3" />
              </Chip>
              <Chip
                disabled={disabled || onSetModel === undefined || modelResolving}
                onClick={() => setOpenMenu((menu) => (menu === 'model' ? null : 'model'))}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'model'}
                title={modelHint}
                data-testid="composer-model-chip"
                data-model-id={knownModel === null ? '' : `${knownModel.provider}/${knownModel.id}`}
                className="gap-1 !border-transparent !px-1.5 !text-[var(--text-muted)] hover:!text-[var(--text)]"
              >
                <span className="truncate">{modelLabel}</span>
                {thinkingSuffix.length > 0 && (
                  <span className="font-normal text-[var(--text-subtle)]">{thinkingSuffix}</span>
                )}
                <ChevronDownIcon className="h-3 w-3" />
              </Chip>
              {openMenu === 'effort' && (
                <MenuPanel
                  aria-label="Reasoning effort"
                  className="bottom-full right-0 mb-2 w-64 py-1"
                  data-testid="composer-effort-menu"
                >
                  <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                    Reasoning effort 推理强度
                  </div>
                  {thinkingLevels.includes('off') && (
                    <MenuItem
                      role="menuitemradio"
                      aria-checked={currentThinking === 'off'}
                      disabled={onSetThinkingLevel === undefined}
                      onClick={() => {
                        onSetThinkingLevel?.('off')
                        closeMenus()
                      }}
                      className="gap-2"
                      data-testid="composer-effort-option-off"
                    >
                      <span className="min-w-0 flex-1">
                        {REASONING_EFFORT_OFF_LABEL} · Off
                        <span className="text-[var(--text-subtle)]"> → off</span>
                      </span>
                      {currentThinking === 'off' && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
                    </MenuItem>
                  )}
                  {effortTiers.map((option) => {
                    const isCurrent = currentEffort === option.effort
                    return (
                      <MenuItem
                        key={option.effort}
                        role="menuitemradio"
                        aria-checked={isCurrent}
                        disabled={!option.available || onSetThinkingLevel === undefined}
                        onClick={() => {
                          if (option.level === null) return
                          onSetThinkingLevel?.(option.level)
                          closeMenus()
                        }}
                        className="gap-2"
                        data-testid={`composer-effort-option-${option.effort}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span>
                            {REASONING_EFFORT_LABELS[option.effort]} ·{' '}
                            {REASONING_EFFORT_GLOSS[option.effort]}
                            {option.level !== null && (
                              <span className="text-[var(--text-subtle)]"> → {option.level}</span>
                            )}
                          </span>
                          {option.reason !== undefined && (
                            <span className="block text-[10px] font-normal text-[var(--text-subtle)]">
                              {option.reason}
                            </span>
                          )}
                        </span>
                        {isCurrent && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
                      </MenuItem>
                    )
                  })}
                </MenuPanel>
              )}
              {openMenu === 'model' && (
                <MenuPanel
                  aria-label="Model and thinking level"
                  className="bottom-full right-0 mb-2 w-60 py-1"
                >
                  <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                    Model
                  </div>
                  {modelOptions.length === 0 ? (
                    <div className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
                      No models available
                    </div>
                  ) : (
                    modelOptions.map((option) => {
                      const isCurrent =
                        currentModel !== null &&
                        option.provider === currentModel.provider &&
                        option.id === currentModel.id
                      return (
                        <MenuItem
                          key={`${option.provider}/${option.id}`}
                          role="menuitemradio"
                          aria-checked={isCurrent}
                          disabled={onSetModel === undefined}
                          onClick={() => {
                            onSetModel?.(option.provider, option.id)
                            closeMenus()
                          }}
                          className="gap-2"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {option.label ?? option.id}
                          </span>
                          {isCurrent && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
                        </MenuItem>
                      )
                    })
                  )}
                  {modelConfig !== null && (
                    <>
                      <div className="mt-3 px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                        Thinking
                      </div>
                      {thinkingLevels.map((level) => {
                        const isCurrent = level === currentThinking
                        return (
                          <MenuItem
                            key={level}
                            role="menuitemradio"
                            aria-checked={isCurrent}
                            disabled={onSetThinkingLevel === undefined}
                            onClick={() => {
                              onSetThinkingLevel?.(level)
                              closeMenus()
                            }}
                            className="gap-2"
                          >
                            <span className="min-w-0 flex-1">{level}</span>
                            {isCurrent && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
                          </MenuItem>
                        )
                      })}
                    </>
                  )}
                </MenuPanel>
              )}
            </div>

            <Button
              variant="primary"
              disabled={!showStop && !canSend}
              onClick={showStop ? onStop : submit}
              aria-label={showStop ? 'Stop' : running ? 'Queue message' : 'Send message'}
              title={
                showStop
                  ? 'Stop the current run'
                  : running
                    ? 'Queue to send after the current run finishes'
                    : 'Send message'
              }
              className={`flex !h-9 w-9 shrink-0 items-center justify-center !rounded-full !px-0${
                showStop ? ' !bg-[var(--danger)] !text-white hover:brightness-110' : ''
              }`}
            >
              {showStop ? (
                <StopIcon className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <SendIcon />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(Composer)
