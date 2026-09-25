export function ToggleSwitch({
  checked,
  disabled,
  label,
  testId,
  onClick
}: {
  checked: boolean
  disabled?: boolean
  label: string
  testId: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`relative h-4.5 w-8 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 ${
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)]'
          : 'border-[var(--border-strong)] bg-[var(--surface-sunken)]'
      }`}
      style={{ height: 18, width: 32 }}
      data-testid={testId}
    >
      <span
        aria-hidden="true"
        className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-[var(--surface)] shadow-sm transition-all ${
          checked ? 'left-[16px]' : 'left-[2px]'
        }`}
      />
    </button>
  )
}

export default ToggleSwitch
