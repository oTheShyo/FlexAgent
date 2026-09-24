import { EmptyCloudIcon } from './icons'

export default function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] shadow-[var(--shadow-sm)]">
        <EmptyCloudIcon className="h-5 w-5" />
      </div>
      <h2 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">
        What should we work on?
      </h2>
      <p className="mt-1 max-w-xs text-sm leading-5 text-[var(--text-muted)]">
        Describe a task in the composer below to get started.
      </p>
    </div>
  )
}
