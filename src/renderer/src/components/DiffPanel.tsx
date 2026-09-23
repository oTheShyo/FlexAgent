import { memo, useEffect, useMemo, useState } from 'react'
import { ContractError, type ApplyFileChangesResult, type FileChange } from '../types'
import { parsePatch, type DiffRow } from './diffUtils'

export interface DiffPanelProps {
  open: boolean
  files: FileChange[]
  acceptDisabled?: boolean
  acceptTitle?: string
  onAccept: (files: FileChange[]) => Promise<ApplyFileChangesResult | null>
  onReject?: () => void
  onClose: () => void
}

type Flash =
  | { kind: 'accepted' }
  | { kind: 'rejected' }
  | { kind: 'error'; message: string }
  | null

const ROW_CLASS: Record<DiffRow['kind'], string> = {
  add: 'bg-emerald-950/40 text-emerald-300',
  del: 'bg-red-950/40 text-red-300',
  ctx: 'bg-zinc-950 text-zinc-100',
  hunk: 'bg-sky-950/50 text-sky-400',
}

const SIGN: Record<DiffRow['kind'], string> = {
  add: '+',
  del: '-',
  ctx: ' ',
  hunk: '',
}

function shortPath(path: string): string {
  const parts = path.split(/[/\\]/)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}

function DiffRowLine({ row }: { row: DiffRow }): React.ReactElement {
  return (
    <div className={`flex min-w-max font-mono text-xs leading-5 ${ROW_CLASS[row.kind]}`}>
      <span className="w-10 shrink-0 select-none border-r border-zinc-800 px-2 text-right text-zinc-600">
        {row.oldNo ?? ''}
      </span>
      <span className="w-10 shrink-0 select-none border-r border-zinc-800 px-2 text-right text-zinc-600">
        {row.newNo ?? ''}
      </span>
      <span
        className={`w-4 shrink-0 select-none text-center ${
          row.kind === 'add'
            ? 'text-emerald-500'
            : row.kind === 'del'
              ? 'text-red-500'
              : 'text-zinc-600'
        }`}
        aria-hidden="true"
      >
        {SIGN[row.kind]}
      </span>
      <span className="whitespace-pre pr-4">
        {row.text.length > 0 ? row.text : ' '}
      </span>
    </div>
  )
}

export function DiffPanel({
  open,
  files,
  acceptDisabled = false,
  acceptTitle,
  onAccept,
  onReject,
  onClose
}: DiffPanelProps): React.ReactElement | null {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [flash, setFlash] = useState<Flash>(null)
  const [pending, setPending] = useState(false)

  const parsedFiles = useMemo(
    () => files.map((file) => ({ file, parsed: parsePatch(file.patch) })),
    [files],
  )

  const activeIndex =
    files.length === 0 ? -1 : selectedIndex < files.length ? selectedIndex : 0
  const active = activeIndex >= 0 ? parsedFiles[activeIndex] : null

  useEffect(() => {
    if (flash === null) return
    const duration = flash.kind === 'error' ? 5000 : 2200
    const timer = window.setTimeout(() => {
      setFlash(null)
      if (flash.kind === 'rejected') onReject?.()
    }, duration)
    return () => window.clearTimeout(timer)
  }, [flash, onReject])

  useEffect(() => {
    setFlash(null)
  }, [open])

  if (!open) return null

  const totalAdds = parsedFiles.reduce((sum, f) => sum + f.parsed.additions, 0)
  const totalDels = parsedFiles.reduce((sum, f) => sum + f.parsed.deletions, 0)

  const handleAccept = async (): Promise<void> => {
    if (pending || acceptDisabled || files.length === 0) return
    setPending(true)
    setFlash(null)
    try {
      const result = await onAccept(files)
      if (result === null) {
        setFlash({ kind: 'error', message: 'Apply unavailable' })
      } else if (result.failed.length > 0) {
        const first = result.failed[0]
        const extra =
          result.failed.length > 1 ? ` (+${result.failed.length - 1} more)` : ''
        setFlash({ kind: 'error', message: `${first.path}: ${first.reason}${extra}` })
      } else {
        setFlash({ kind: 'accepted' })
      }
    } catch (err) {
      const message =
        err instanceof ContractError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      setFlash({ kind: 'error', message })
    } finally {
      setPending(false)
    }
  }

  const handleReject = (): void => {
    if (pending || flash?.kind === 'rejected') return
    setFlash({ kind: 'rejected' })
  }

  const statusText = pending
    ? 'Applying…'
    : flash === null
      ? ''
      : flash.kind === 'accepted'
        ? 'Changes accepted'
        : flash.kind === 'rejected'
          ? 'Changes rejected'
          : flash.message

  const statusClassName = pending
    ? 'text-[var(--text-muted)] opacity-100'
    : flash === null
      ? 'opacity-0'
      : flash.kind === 'accepted'
        ? 'text-emerald-700 opacity-100'
        : 'text-red-700 opacity-100'

  return (
    <div className="fixed inset-0 z-40" role="presentation">
      <button
        type="button"
        aria-label="Close review"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-zinc-950/20"
      />
      <aside
        role="dialog"
        aria-label="Review"
        className="absolute inset-y-0 right-0 flex w-[640px] max-w-[92vw] flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[-12px_0_32px_rgba(0,0,0,0.08)]"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-sm font-semibold text-[var(--text)]">Review</h2>
            {files.length > 0 && (
              <span className="font-mono text-xs text-[var(--text-muted)]">
                {files.length} file{files.length === 1 ? '' : 's'}
                <span className="ml-2 text-emerald-700">+{totalAdds}</span>
                <span className="ml-1 text-red-700">-{totalDels}</span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </header>

        {files.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <p className="text-sm text-[var(--text-muted)]">No changes to review</p>
          </div>
        ) : (
          <>
            <nav
              aria-label="Changed files"
              className="max-h-40 shrink-0 overflow-y-auto border-b border-[var(--border)] py-1"
            >
              {parsedFiles.map(({ file, parsed }, index) => {
                const selected = index === activeIndex
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setSelectedIndex(index)}
                    aria-current={selected ? 'true' : undefined}
                    className={`flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${
                      selected ? 'bg-[var(--surface-raised)]' : 'hover:bg-[var(--hover)]'
                    }`}
                  >
                    <span
                      className={`truncate font-mono text-xs ${
                        selected ? 'text-[var(--text)]' : 'text-[var(--text-secondary)]'
                      }`}
                      title={file.path}
                    >
                      {shortPath(file.path)}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-xs">
                      <span className="text-emerald-700">+{parsed.additions}</span>
                      <span className="ml-1.5 text-red-700">-{parsed.deletions}</span>
                    </span>
                  </button>
                )
              })}
            </nav>

            <div className="min-h-0 flex-1 overflow-auto bg-zinc-950">
              {active === null || active.parsed.rows.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6">
                  <p className="text-sm text-zinc-400">No diff content for this file.</p>
                </div>
              ) : (
                <div className="min-w-max py-1">
                  {active.parsed.rows.map((row, index) => (
                    <DiffRowLine key={index} row={row} />
                  ))}
                </div>
              )}
            </div>

            <footer className="flex h-14 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--surface)] px-4">
              <span
                role="status"
                aria-live="polite"
                className={`min-w-0 truncate pr-3 text-xs transition-opacity duration-150 ${statusClassName}`}
              >
                {statusText}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  data-testid="diff-reject"
                  onClick={handleReject}
                  disabled={flash?.kind === 'rejected'}
                  className="h-8 rounded border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] active:translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  type="button"
                  data-testid="diff-accept"
                  onClick={() => void handleAccept()}
                  disabled={pending || acceptDisabled}
                  title={acceptDisabled ? acceptTitle : undefined}
                  className="h-8 rounded bg-[var(--accent)] px-4 text-xs font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Accept
                </button>
              </div>
            </footer>
          </>
        )}
      </aside>
    </div>
  )
}

export default memo(DiffPanel)
