import { memo, useCallback, useEffect, useState } from 'react'
import { HTTP_IDLE_TIMEOUT_CHOICES } from '../types'
import type { SetNetworkInput } from '../types'
import type { UseNetworkSettingsResult } from '../hooks/useNetworkSettings'

/** No width class here: `w-full` would win over a per-field width. */
const controlClass =
  'h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60'

function Field({
  label,
  hint,
  htmlFor,
  children
}: {
  label: string
  hint?: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-[var(--border)] py-2.5 last:border-b-0">
      <label htmlFor={htmlFor} className="block text-xs text-[var(--text)]">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint !== undefined && (
        <p id={`${htmlFor}-hint`} className="mt-1 text-[10px] leading-3.5 text-[var(--text-muted)]">
          {hint}
        </p>
      )}
    </div>
  )
}

/**
 * Settings › Network.
 *
 * These are the kernel's own `settings.json` fields, deliberately — a proxy that
 * only applies to requests this app makes would be a half-measure, and the idle
 * timeout is the one guard that turns a stalled stream into a retry instead of a
 * hang (article §9).
 */
function NetworkSettings({ controller }: { controller: UseNetworkSettingsResult }) {
  const { settings, loading, saving, error, save } = controller
  const [proxy, setProxy] = useState('')

  // The main process re-reads the file after every write, so the committed value
  // is what comes back — not what was typed.
  useEffect(() => {
    setProxy(settings?.proxy ?? '')
  }, [settings?.proxy])

  const unavailable = settings?.dispatcher === 'unavailable'
  const commitProxy = useCallback(
    (value: string) => {
      if (settings === null) return
      if (value.trim() === settings.proxy) return
      void save({ proxy: value.trim() })
    },
    [save, settings]
  )

  const patch = useCallback(
    (next: SetNetworkInput) => {
      void save(next)
    },
    [save]
  )

  if (loading) {
    return <p className="text-[11px] text-[var(--text-muted)]">Reading the kernel&apos;s settings…</p>
  }

  return (
    <div data-testid="settings-network" className="space-y-3">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
        <h3 className="text-xs font-medium text-[var(--text-secondary)]">Kernel settings</h3>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
          Written to{' '}
          <code className="break-all font-mono text-[10px] text-[var(--text-secondary)]">
            {settings?.path ?? '…/settings.json'}
          </code>
          . This is the kernel&apos;s file, shared with every session it runs.
        </p>

        {unavailable && (
          <p
            role="status"
            className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-[11px] leading-4 text-[var(--warning-text)]"
            data-testid="network-dispatcher-note"
          >
            {settings?.note ??
              'The kernel\u2019s HTTP dispatcher could not be loaded, so a proxy here would have no effect. Node ignores the proxy environment variables on its own.'}
          </p>
        )}

        <div className="mt-2">
          <Field
            label="HTTP proxy"
            htmlFor="network-proxy"
            hint={
              unavailable
                ? 'Unavailable until the dispatcher loads. Requests go direct.'
                : 'e.g. http://127.0.0.1:7890. Leave blank to go direct — the proxy applies to every provider, so it is all-or-nothing.'
            }
          >
            <input
              id="network-proxy"
              type="text"
              value={proxy}
              disabled={saving || unavailable}
              onChange={(event) => setProxy(event.target.value)}
              onBlur={(event) => commitProxy(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
              placeholder="http://127.0.0.1:7890"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="network-proxy-hint"
              className={`${controlClass} w-full`}
              data-testid="network-proxy"
            />
          </Field>

          {settings?.envProxy != null && (
            <p
              className="mt-1 text-[10px] leading-3.5 text-[var(--warning-text)]"
              data-testid="network-env-proxy"
            >
              This machine already sets{' '}
              <code className="font-mono">{settings.envProxy}</code> in the environment. That
              variable wins over this field, so clear it (or relaunch without it) before relying on
              a proxy configured here.
            </p>
          )}

          <Field
            label="Stream idle timeout"
            htmlFor="network-idle"
            hint="How long a response may go silent before the request is dropped and retried. Long-running tools can pause for a while — five minutes is the kernel's default; disabling the guard means a dead stream hangs until the provider gives up."
          >
            <select
              id="network-idle"
              value={String(settings?.idleTimeoutMs ?? 300_000)}
              disabled={saving}
              onChange={(event) => patch({ idleTimeoutMs: Number(event.target.value) })}
              aria-describedby="network-idle-hint"
              className={`${controlClass} w-full`}
              data-testid="network-idle"
            >
              {HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => (
                <option key={choice.ms} value={String(choice.ms)}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Max retries"
            htmlFor="network-retries"
            hint="Retries for one request before the turn fails, with exponential backoff and jitter. Applies to rate limits and dropped streams alike."
          >
            <input
              id="network-retries"
              type="number"
              min={0}
              max={10}
              step={1}
              value={settings?.maxRetries ?? 3}
              disabled={saving}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isInteger(next) || next < 0 || next > 10) return
                patch({ maxRetries: next })
              }}
              aria-describedby="network-retries-hint"
              className={`${controlClass} w-24`}
              data-testid="network-retries"
            />
          </Field>
        </div>

        {error !== null && (
          <p role="alert" className="mt-2 text-[11px] leading-4 text-[var(--danger-text)]" data-testid="network-error">
            {error}
          </p>
        )}
      </section>

      <p className="text-[11px] leading-4 text-[var(--text-muted)]">
        Per-provider routing (which host needs the proxy and which does not) is not offered here —
        the kernel&apos;s setting is a single switch, and a UI that implied finer control would be
        lying.
      </p>
    </div>
  )
}

export default memo(NetworkSettings)
