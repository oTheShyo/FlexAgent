import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import type { PromptMode } from '../types'
import { filterComposerFiles } from './composerFiles'

export interface ComposerProps {
  onSend: (text: string, mode?: PromptMode) => void
  disabled?: boolean
  running?: boolean
}

const APPROVAL_MODES = ['Manual', 'Auto', 'Full access'] as const

const MENTION_BEFORE_CARET = /@[\w./-]*$/

function matchMentionQuery(value: string, caret: number): string | null {
  const match = value.slice(0, caret).match(MENTION_BEFORE_CARET)
  return match === null ? null : match[0].slice(1)
}

function PlusIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8l1 1.3a1 1 0 0 0 .8.4H19a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  )
}

function QueueIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h10" />
      <path d="M4 12h10" />
      <path d="M4 17h6" />
      <path d="M17 10v7" />
      <path d="m14 14 3 3 3-3" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 text-[var(--text-subtle)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

interface MentionPopupProps {
  files: string[]
  selectedIndex: number
  onSelect: (index: number) => void
  onPick: (path: string) => void
}

function MentionPopup({ files, selectedIndex, onSelect, onPick }: MentionPopupProps) {
  return (
    <ul
      id="composer-mention-list"
      role="listbox"
      aria-label="File mentions"
      className="absolute inset-x-1.5 bottom-full z-30 mb-2 max-h-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]"
    >
      {files.length === 0 ? (
        <li role="presentation" className="px-3 py-2 text-xs text-[var(--text-muted)]">
          No matching files
        </li>
      ) : (
        files.map((path, index) => {
          const isSelected = index === selectedIndex
          return (
            <li key={path} role="presentation">
              <div
                id={`composer-mention-option-${index}`}
                role="option"
                aria-selected={isSelected}
                onMouseMove={() => onSelect(index)}
                onClick={() => onPick(path)}
                tabIndex={-1}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                  isSelected
                    ? 'bg-[var(--active)] font-medium text-[var(--text)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--hover)]'
                }`}
              >
                <FileIcon />
                <span className="min-w-0 flex-1 truncate">{path}</span>
              </div>
            </li>
          )
        })
      )}
    </ul>
  )
}

function Composer({ onSend, disabled = false, running = false }: ComposerProps) {
  const [text, setText] = useState('')
  const [approvalIndex, setApprovalIndex] = useState(0)
  const [queueNext, setQueueNext] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionQueryRef = useRef<string | null>(null)
  const pendingCaretRef = useRef<number | null>(null)

  const approvalLabel = APPROVAL_MODES[approvalIndex]
  const canSend = !disabled && text.trim().length > 0
  const mentionOpen = mentionQuery !== null

  const mentionFiles = useMemo(
    () => (mentionQuery === null ? [] : filterComposerFiles(mentionQuery)),
    [mentionQuery]
  )

  const closeMention = useCallback((): void => {
    mentionQueryRef.current = null
    setMentionQuery(null)
    setMentionIndex(0)
  }, [])

  const syncMention = useCallback((): void => {
    const el = textareaRef.current
    if (el === null) return
    const next = matchMentionQuery(el.value, el.selectionStart ?? el.value.length)
    if (next !== mentionQueryRef.current) {
      mentionQueryRef.current = next
      setMentionQuery(next)
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

  const acceptMention = useCallback((): boolean => {
    if (!mentionOpen) return false
    const path = mentionFiles[mentionIndex]
    if (path === undefined) return true
    pickMention(path)
    return true
  }, [mentionOpen, mentionFiles, mentionIndex, pickMention])

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

  const submit = (): void => {
    if (!canSend) return
    const mode: PromptMode | undefined = running && queueNext ? 'followUp' : undefined
    onSend(text.trim(), mode)
    setText('')
    setQueueNext(false)
    closeMention()
  }

  const submitRef = useRef(submit)
  submitRef.current = submit

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.nativeEvent.isComposing) return

      if (event.key === 'Escape') {
        if (mentionQueryRef.current !== null) {
          event.preventDefault()
          event.stopPropagation()
          closeMention()
        }
        return
      }

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        submitRef.current()
        return
      }

      if (mentionQueryRef.current !== null) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setMentionIndex((index) =>
            mentionFiles.length === 0 ? 0 : (index + 1) % mentionFiles.length
          )
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setMentionIndex((index) =>
            mentionFiles.length === 0
              ? 0
              : (index - 1 + mentionFiles.length) % mentionFiles.length
          )
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          acceptMention()
          return
        }
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submitRef.current()
      }
    },
    [mentionFiles.length, acceptMention, closeMention]
  )

  const handleTextChange = useCallback(
    (next: string): void => {
      setText(next)
      syncMention()
    },
    [syncMention]
  )

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
      try {
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length === 0) return
        const el = textareaRef.current
        if (el === null) return
        const caret = el.selectionStart ?? el.value.length
        const prefix = el.value.length > 0 && caret > 0 && !/\s$/.test(el.value.slice(0, caret)) ? ' ' : ''
        const snippet = files.map((file) => `@${file.name} `).join('')
        setText(`${el.value.slice(0, caret)}${prefix}${snippet}${el.value.slice(caret)}`)
        pendingCaretRef.current = caret + prefix.length + snippet.length
        closeMention()
      } catch {
        setDragOver(false)
      }
    },
    [closeMention]
  )

  function cycleApproval(): void {
    setApprovalIndex((prev) => (prev + 1) % APPROVAL_MODES.length)
  }

  const chipClass =
    'flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--surface)]'

  const activeMentionId =
    mentionOpen && mentionFiles.length > 0 && mentionIndex < mentionFiles.length
      ? `composer-mention-option-${mentionIndex}`
      : undefined

  return (
    <div className="shrink-0 px-4 pb-4" data-testid="composer">
      <div className="relative mx-auto w-full max-w-3xl rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
        {mentionOpen && (
          <MentionPopup
            files={mentionFiles}
            selectedIndex={mentionIndex}
            onSelect={setMentionIndex}
            onPick={pickMention}
          />
        )}

        {dragOver && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)] text-sm font-medium text-[var(--text-secondary)]"
          >
            Drop files to attach
          </div>
        )}

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={dragOver ? 'rounded-xl' : undefined}
        >
          <button
            type="button"
            disabled={disabled}
            className="flex w-full items-center gap-1.5 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FolderIcon />
            <span>Choose project</span>
            <ChevronDownIcon />
          </button>

          <textarea
            ref={textareaRef}
            rows={2}
            value={text}
            onChange={(event) => handleTextChange(event.target.value)}
            onKeyUp={syncMention}
            onClick={syncMention}
            onKeyDown={handleKeyDown}
            placeholder={dragOver ? 'Drop files to attach' : running ? 'Steer the running turn…' : 'Do anything'}
            disabled={disabled}
            autoFocus
            spellCheck={false}
            aria-expanded={mentionOpen}
            aria-controls={mentionOpen ? 'composer-mention-list' : undefined}
            aria-activedescendant={activeMentionId}
            className="block min-h-[52px] w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] disabled:opacity-40"
          />

          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <button
              type="button"
              disabled={disabled}
              aria-label="Add attachment"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <PlusIcon />
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={cycleApproval}
              title="Cycle approval mode"
              className={chipClass}
            >
              {approvalLabel}
              <ChevronDownIcon />
            </button>

            {running && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => setQueueNext((value) => !value)}
                aria-pressed={queueNext}
                title="Queue this message to send after the current run finishes (followUp)"
                className={`${chipClass} ${
                  queueNext
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] hover:text-[var(--accent-contrast)]'
                    : ''
                }`}
              >
                <QueueIcon />
                Queue
              </button>
            )}

            <div className="flex-1" />

            <button type="button" disabled={disabled} className={chipClass}>
              mimo-v2.6 Flash
              <ChevronDownIcon />
            </button>

            <button
              type="button"
              disabled={!canSend}
              onClick={submit}
              aria-label={running && queueNext ? 'Queue message' : 'Send message'}
              title={
                running
                  ? queueNext
                    ? 'Queue for after the current run'
                    : 'Send as a steer (injected mid-run)'
                  : 'Send message'
              }
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(Composer)
