export default function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] shadow-[var(--shadow-sm)]">
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M7 16.5a3.8 3.8 0 0 1 .7-7.5 5.2 5.2 0 0 1 9.7 1.3A3.4 3.4 0 0 1 16.7 16.5z" />
          <path d="m10.3 11.6-1.6 1.6 1.6 1.6" />
          <path d="m13.7 11.6 1.6 1.6-1.6 1.6" />
          <path d="m12.7 10.9-.9 4.6" />
        </svg>
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
