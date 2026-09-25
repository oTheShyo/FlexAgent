import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ChatItem, ModelRetryState } from '../hooks/useChat'
import { LoadingIndicator } from './LoadingIndicator'
import { Markdown } from './Markdown'
import { CheckIcon, CopyIcon, RegenerateIcon } from './icons'

export interface ChatViewProps {
  items: ChatItem[]
  running?: boolean
  /** Live kernel retry notice — the model call failed and is being retried. */
  modelRetry?: ModelRetryState | null
  onRegenerate?: () => void
}

const AssistantContent = memo(function AssistantContent({
  content,
  streaming = false
}: {
  content: string
  streaming?: boolean
}): ReactElement {
  return <Markdown content={content} streaming={streaming} />
})

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

function fallbackCopyText(text: string): void {
  let textarea: HTMLTextAreaElement | null = null
  try {
    textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    document.execCommand('copy')
  } catch {
    // execCommand unavailable or blocked — copy is best-effort.
  } finally {
    if (textarea?.parentNode) textarea.parentNode.removeChild(textarea)
  }
}

function copyTextToClipboard(text: string): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {
        fallbackCopyText(text)
      })
      return
    }
  } catch {
    // Clipboard access threw — fall back below.
  }
  fallbackCopyText(text)
}

const CopyButton = memo(function CopyButton({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    },
    []
  )

  const handleClick = useCallback((): void => {
    copyTextToClipboard(text)
    setCopied(true)
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => setCopied(false), 1600)
  }, [text])

  return (
    <button
      type="button"
      data-testid="message-actions-copy"
      onClick={handleClick}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy message'}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-[var(--text-subtle)] transition-colors hover:border-[var(--border)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5 text-[var(--success)]" />
      ) : (
        <CopyIcon className="h-3.5 w-3.5" />
      )}
    </button>
  )
})

function RegenerateButton({ onClick }: { onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      data-testid="message-actions-regenerate"
      onClick={onClick}
      aria-label="Regenerate response"
      title="Regenerate response"
      className="inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 text-[11px] font-medium text-[var(--text-subtle)] transition-colors hover:border-[var(--border)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <RegenerateIcon className="h-3.5 w-3.5" />
      Regenerate
    </button>
  )
}

const TOOL_STATUS: Record<ToolItem['status'], { dot: string; label: string; text: string }> = {
  waiting: {
    dot: 'bg-[var(--warning)] animate-pulse',
    label: 'Waiting for approval',
    text: 'text-[var(--warning-text)]'
  },
  running: {
    dot: 'bg-[var(--info-dot)] animate-pulse',
    label: 'Running',
    text: 'text-[var(--text-muted)]'
  },
  done: { dot: 'bg-[var(--success)]', label: 'Done', text: 'text-[var(--text-subtle)]' },
  error: { dot: 'bg-[var(--danger)]', label: 'Failed', text: 'text-[var(--danger-text)]' }
}

const ToolCard = memo(function ToolCard({ item }: { item: ToolItem }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const status = TOOL_STATUS[item.status]
  const isError = item.status === 'error'
  const content = item.chunks.join('')
  const isLongOutput = content.length > 0 && (content.split('\n').length > 8 || content.length > 600)

  const handleToggleExpanded = useCallback((): void => {
    setExpanded((value) => !value)
  }, [])

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isError
          ? 'border-[var(--danger-border)] bg-[var(--danger-bg)]'
          : 'border-[var(--border)] bg-[var(--surface-sunken)]'
      }`}
      data-testid="tool-card"
    >
      {(item.status === 'waiting' || item.status === 'running') && (
        <div className="mb-2" aria-hidden="true">
          <LoadingIndicator size={20} color="var(--text-subtle)" label={status.label} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} aria-hidden="true" />
        <span className="truncate text-xs font-medium text-[var(--text)]">{item.label}</span>
        <span className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-px font-mono text-[10px] text-[var(--text-muted)]">
          {item.name}
        </span>
        <span className={`ml-auto shrink-0 text-[11px] ${status.text}`}>{status.label}</span>
      </div>
      {item.chunks.length > 0 && (
        <>
          <pre
            className={`mt-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[11px] leading-4 text-[var(--text-secondary)] ${
              isLongOutput
                ? expanded
                  ? 'overflow-auto'
                  : 'max-h-40 overflow-hidden'
                : 'max-h-40 overflow-auto'
            }`}
          >
            {content}
          </pre>
          {isLongOutput && (
            <button
              type="button"
              data-testid="tool-card-expand"
              onClick={handleToggleExpanded}
              aria-expanded={expanded}
              className="-ml-1 mt-1 rounded-md px-1 py-0.5 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
      {item.summary && <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">{item.summary}</p>}
    </div>
  )
})

type ErrorItem = Extract<ChatItem, { kind: 'error' }>

const ErrorBlock = memo(function ErrorBlock({
  item,
  onRetry
}: {
  item: ErrorItem
  onRetry?: () => void
}): ReactElement {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    },
    []
  )

  const details = `${item.code}\n${item.message}`

  const handleCopy = useCallback((): void => {
    copyTextToClipboard(details)
    setCopied(true)
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => setCopied(false), 1600)
  }, [details])

  return (
    <div
      className="fx-fade rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2"
      data-testid="error-block"
    >
      <span className="font-mono text-[11px] font-semibold text-[var(--danger-text)]">{item.code}</span>
      <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--danger-text)]">{item.message}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          data-testid="error-copy-details"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy error details'}
          title={copied ? 'Copied' : 'Copy error details'}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 text-[11px] font-medium text-[var(--danger-text)] transition-colors hover:border-[var(--danger-border)] hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          {copied ? (
            <CheckIcon className="h-3.5 w-3.5 text-[var(--success)]" />
          ) : (
            <CopyIcon className="h-3.5 w-3.5" />
          )}
          {copied ? 'Copied' : 'Copy details'}
        </button>
        {onRetry && (
          <button
            type="button"
            data-testid="error-retry"
            onClick={onRetry}
            aria-label="Retry"
            title="Retry"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 text-[11px] font-medium text-[var(--danger-text)] transition-colors hover:border-[var(--danger-border)] hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <RegenerateIcon className="h-3.5 w-3.5" />
            Retry
          </button>
        )}
      </div>
    </div>
  )
})

function Caret({ block = false }: { block?: boolean }): ReactElement {
  if (block) {
    return (
      <div className="mt-2" aria-label="Assistant is responding">
        <LoadingIndicator size={28} color="var(--text-subtle)" label="Assistant is responding" />
      </div>
    )
  }
  return (
    <span className="ml-1 inline-flex align-middle" aria-label="Assistant is responding">
      <LoadingIndicator size={18} color="var(--text-subtle)" label="Assistant is responding" />
    </span>
  )
}

function chatRowKey(item: ChatItem, index: number): string {
  switch (item.kind) {
    case 'message':
      return item.message.id
    case 'partial':
      return 'partial'
    case 'tool':
      return item.toolCallId
    case 'error':
      return `error-${index}`
  }
}

const ChatRow = memo(function ChatRow({
  item,
  running,
  isLatestAssistant = false,
  onRegenerate
}: {
  item: ChatItem
  running?: boolean
  isLatestAssistant?: boolean
  onRegenerate?: () => void
}): ReactElement {
  switch (item.kind) {
    case 'message': {
      const { message } = item
      if (message.role === 'user') {
        return (
          <div className="group flex items-start justify-end gap-1.5">
            <div className="max-w-[75%] rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-2.5 text-sm leading-6 text-[var(--text)]">
              <span className="whitespace-pre-wrap">{message.content}</span>
            </div>
            <div className="mt-1.5 flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
              <CopyButton text={message.content} />
            </div>
          </div>
        )
      }
      return (
        <div className="flex justify-start">
          <div className="w-full min-w-0 max-w-[92%]">
            <div className="group">
              <AssistantContent content={message.content} />
              {isLatestAssistant && (
                <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                  <CopyButton text={message.content} />
                  {onRegenerate && <RegenerateButton onClick={onRegenerate} />}
                </div>
              )}
            </div>
          </div>
        </div>
      )
    }
    case 'partial':
      return (
        <div className="flex justify-start">
          <div className="w-full min-w-0 max-w-[92%]">
            <AssistantContent content={item.content} streaming />
            {running && <Caret />}
          </div>
        </div>
      )
    case 'tool':
      return (
        <div className="flex justify-start">
          <div className="w-full min-w-0 max-w-[92%]">
            <ToolCard item={item} />
          </div>
        </div>
      )
    case 'error':
      return (
        <div className="flex justify-start">
          <div className="w-full min-w-0 max-w-[92%]">
            <ErrorBlock item={item} onRetry={onRegenerate} />
          </div>
        </div>
      )
  }
})

export function ChatView({
  items,
  running = false,
  modelRetry = null,
  onRegenerate
}: ChatViewProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastItem = items.length > 0 ? items[items.length - 1] : null

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
    // Scroll when the tail item identity or list length changes (streaming
    // replaces the tail partial each token). Avoids JSON.stringify per render.
  }, [lastItem, items.length])

  const trailingPartial = items.length > 0 && items[items.length - 1].kind === 'partial'

  let lastAssistantIndex = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index]
    if (candidate.kind === 'message' && candidate.message.role === 'assistant') {
      lastAssistantIndex = index
      break
    }
  }

  function renderItems(): ReactElement[] {
    return items.map((item, index) => {
      const isLatestAssistant = index === lastAssistantIndex
      const isTrailingError = item.kind === 'error' && index === items.length - 1
      return (
        <ChatRow
          key={chatRowKey(item, index)}
          item={item}
          running={item.kind === 'partial' ? running : undefined}
          isLatestAssistant={isLatestAssistant}
          onRegenerate={
            (isLatestAssistant || isTrailingError) && onRegenerate ? onRegenerate : undefined
          }
        />
      )
    })
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto overscroll-contain"
      role="log"
      aria-live="polite"
      aria-label="Chat messages"
    >
      {items.length === 0 ? (
        <div className="flex h-full items-center justify-center px-6">
          <p className="text-sm text-[var(--text-subtle)]">Send a message to start.</p>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {renderItems()}
          {running && !trailingPartial && <Caret block />}
          {modelRetry !== null && (
            <p
              role="status"
              data-testid="model-retry-notice"
              className="fx-fade rounded-lg border border-[var(--warning-border,var(--border))] bg-[var(--surface-sunken)] px-3 py-2 text-[11px] leading-4 text-[var(--warning-text,var(--text-secondary))]"
            >
              Model call failed (attempt {modelRetry.attempt}/{modelRetry.maxAttempts}) — retrying
              in {Math.max(1, Math.round(modelRetry.delayMs / 1000))}s
              {modelRetry.errorMessage !== undefined ? ` · ${modelRetry.errorMessage}` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default ChatView
