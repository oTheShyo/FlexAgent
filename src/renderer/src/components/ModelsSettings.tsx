import { memo, useCallback, useMemo, useState } from 'react'
import type {
  CustomModelApi,
  CustomModelEntry,
  CustomModelRef,
  CustomModelSaveInput
} from '../types'
import { CUSTOM_MODEL_APIS } from '../types'
import type { UseCustomModelsResult } from '../hooks/useCustomModels'
import { Button, IconButton } from './ui'
import { ModelIcon, PencilIcon, PlusIcon, TrashIcon } from './icons'

const inputClass =
  'h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60'

const API_LABEL: Record<CustomModelApi, string> = {
  'openai-completions': 'Chat Completions (OpenAI-compatible)',
  'openai-responses': 'Responses (OpenAI)',
  'anthropic-messages': 'Messages (Anthropic)'
}

function modelKey(entry: CustomModelRef): string {
  return `${entry.provider}\u0000${entry.id}`
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

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
    <div className="mt-2">
      <label htmlFor={htmlFor} className="block text-[11px] font-medium text-[var(--text-secondary)]">
        {label}
      </label>
      {children}
      {hint !== undefined && (
        <p id={`${htmlFor}-hint`} className="mt-1 text-[10px] leading-3.5 text-[var(--text-muted)]">
          {hint}
        </p>
      )}
    </div>
  )
}

/**
 * Add/edit one entry. One form serves both: the fields are identical and the
 * server treats `original` as "move this entry", so nothing is duplicated.
 */
function ModelForm({
  entry,
  models,
  busy,
  onCancel,
  onSubmit
}: {
  entry?: CustomModelEntry
  models: CustomModelEntry[]
  busy: boolean
  onCancel: () => void
  onSubmit: (input: CustomModelSaveInput) => Promise<boolean>
}) {
  const [provider, setProvider] = useState(entry?.provider ?? '')
  const [baseUrl, setBaseUrl] = useState(entry?.baseUrl ?? '')
  const [api, setApi] = useState<string>(entry?.api ?? 'openai-completions')
  const [apiKey, setApiKey] = useState('')
  const [id, setId] = useState(entry?.id ?? '')
  const [label, setLabel] = useState(entry?.label ?? '')
  const [localError, setLocalError] = useState<string | null>(null)

  const providers = useMemo(
    () => [...new Set(models.map((model) => model.provider))].sort(),
    [models]
  )
  /** Existing provider settings the form can borrow instead of re-typing a key. */
  const known = useMemo(
    () => models.find((model) => model.provider === provider.trim()),
    [models, provider]
  )
  const keepsStoredKey = entry !== undefined && known !== undefined && entry.provider === known.provider
  // PI refuses to compose a provider with no auth method, so a brand-new one
  // needs a key now rather than a silently empty model list later.
  const apiKeyRequired = !keepsStoredKey && (known === undefined || !known.apiKeySet)

  const apiOptions = useMemo(() => {
    const options = [...CUSTOM_MODEL_APIS] as string[]
    if (api.length > 0 && !options.includes(api)) options.push(api)
    return options
  }, [api])

  const handleProviderChange = useCallback(
    (value: string) => {
      setProvider(value)
      const match = models.find((model) => model.provider === value.trim())
      if (match === undefined) return
      if (baseUrl.trim().length === 0 && match.baseUrl !== undefined) setBaseUrl(match.baseUrl)
      if (match.api !== undefined) setApi(match.api)
    },
    [models, baseUrl]
  )

  const submit = async (): Promise<void> => {
    setLocalError(null)
    const nextProvider = provider.trim()
    const nextId = id.trim()
    const nextBaseUrl = baseUrl.trim()
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(nextProvider)) {
      setLocalError('Provider must match [a-zA-Z0-9_-]{1,64} — e.g. "openai" or "ustc".')
      return
    }
    if (nextId.length === 0) {
      setLocalError('Model id is required — it is the name the API expects.')
      return
    }
    if (!isHttpUrl(nextBaseUrl)) {
      setLocalError('Base URL must start with http:// or https://.')
      return
    }
    if (apiKeyRequired && apiKey.trim().length === 0) {
      setLocalError('API key is required for a new provider. Use $VAR to read it from the environment.')
      return
    }
    const trimmedLabel = label.trim()
    const ok = await onSubmit({
      provider: nextProvider,
      id: nextId,
      baseUrl: nextBaseUrl,
      api: api as CustomModelApi,
      ...(trimmedLabel.length > 0 ? { label: trimmedLabel } : {}),
      ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      ...(entry !== undefined ? { original: { provider: entry.provider, id: entry.id } } : {})
    })
    if (ok) onCancel()
  }

  return (
    <form
      className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 pb-3 pt-1"
      data-testid="custom-model-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="pt-2 text-[11px] font-semibold text-[var(--text)]">
        {entry === undefined ? 'Add model' : `Edit ${entry.id}`}
      </p>

      <Field
        label="Model id"
        htmlFor="custom-model-id"
        hint="Sent to the API as the model name, e.g. glm-5.3-flash."
      >
        <input
          id="custom-model-id"
          type="text"
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="glm-5.3-flash"
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
          data-testid="custom-model-id"
        />
      </Field>

      <Field label="Display name" htmlFor="custom-model-label" hint="Optional. Shown in the model picker.">
        <input
          id="custom-model-label"
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="GLM 5.3 Flash"
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
          data-testid="custom-model-label"
        />
      </Field>

      <Field
        label="Provider"
        htmlFor="custom-model-provider"
        hint="Groups models that share a Base URL and key. Reuse an existing one to inherit both."
      >
        <input
          id="custom-model-provider"
          type="text"
          value={provider}
          onChange={(event) => handleProviderChange(event.target.value)}
          placeholder="ustc"
          autoComplete="off"
          spellCheck={false}
          list="custom-model-providers"
          className={inputClass}
          data-testid="custom-model-provider"
        />
        <datalist id="custom-model-providers">
          {providers.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>

      <Field
        label="Base URL"
        htmlFor="custom-model-baseurl"
        hint="The endpoint root, e.g. https://api.example.com/v1."
      >
        <input
          id="custom-model-baseurl"
          type="text"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
          data-testid="custom-model-baseurl"
        />
      </Field>

      <Field label="API type" htmlFor="custom-model-api" hint="Must match what the endpoint actually speaks.">
        <select
          id="custom-model-api"
          value={api}
          onChange={(event) => setApi(event.target.value)}
          className={inputClass}
          data-testid="custom-model-api"
        >
          {apiOptions.map((option) => (
            <option key={option} value={option}>
              {API_LABEL[option as CustomModelApi] ?? option}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="API key"
        htmlFor="custom-model-apikey"
        hint={
          keepsStoredKey
            ? 'Leave blank to keep the stored key. $VAR reads it from the environment.'
            : 'Stored in models.json on this device. $VAR reads it from the environment.'
        }
      >
        <input
          id="custom-model-apikey"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={keepsStoredKey ? 'Keep current key' : '$MY_PROVIDER_KEY'}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="custom-model-apikey-hint"
          className={inputClass}
          data-testid="custom-model-apikey"
        />
      </Field>

      {localError !== null && (
        <p role="alert" className="mt-2 text-[11px] text-[var(--danger-text)]" data-testid="custom-model-error">
          {localError}
        </p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy} data-testid="custom-model-submit">
          {busy ? 'Saving…' : entry === undefined ? 'Add model' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

function ModelsSettings({ controller }: { controller: UseCustomModelsResult }) {
  const { models, path, loading, saving, error, kernelWarning, save, remove } = controller
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const closeForm = useCallback(() => {
    setAdding(false)
    setEditing(null)
  }, [])

  const formOpen = adding || editing !== null

  return (
    <div className="mt-5" data-testid="settings-models">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-[var(--text-secondary)]">Models</p>
        {!formOpen && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setAdding(true)
              setEditing(null)
              setConfirming(null)
            }}
            data-testid="custom-model-add"
          >
            <span className="flex items-center gap-1.5">
              <PlusIcon className="h-3.5 w-3.5" />
              Add model
            </span>
          </Button>
        )}
      </div>

      <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]">
        Custom models are written to{' '}
        <code className="break-all font-mono text-[10px] text-[var(--text-secondary)]">
          {path ?? '…/models.json'}
        </code>{' '}
        and handed to the kernel immediately — no restart. Each entry brings its provider&apos;s Base
        URL, API type and key, so it is selectable in the composer as soon as it is saved.
      </p>

      {adding && (
        <ModelForm
          models={models}
          busy={saving}
          onCancel={closeForm}
          onSubmit={(input) => save(input)}
        />
      )}

      {loading ? (
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">Reading models.json…</p>
      ) : models.length === 0 && !adding ? (
        <p className="mt-3 rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[11px] leading-4 text-[var(--text-muted)]">
          No custom models yet. Without one the composer has nothing to send a prompt with.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {models.map((model) => {
            const key = modelKey(model)
            if (editing === key) {
              return (
                <li key={key}>
                  <ModelForm
                    entry={model}
                    models={models}
                    busy={saving}
                    onCancel={closeForm}
                    onSubmit={(input) => save(input)}
                  />
                </li>
              )
            }
            return (
              <li
                key={key}
                className="flex items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2"
                data-testid={`custom-model-row-${model.provider}-${model.id}`}
              >
                <ModelIcon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-[var(--text)]">
                    {model.label ?? model.id}
                  </p>
                  <p className="truncate text-[10px] text-[var(--text-muted)]">
                    {model.id} · {model.provider}
                    {model.api !== undefined ? ` · ${model.api}` : ''}
                    {model.apiKeySet ? '' : ' · no key'}
                  </p>
                </div>
                {confirming === key ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="max-w-[220px] text-right text-[11px] leading-4 text-[var(--text-secondary)]">
                      {models.filter((entry) => entry.provider === model.provider).length === 1
                        ? `Remove ${model.id}? It is ${model.provider}'s only model — its Base URL and key go with it.`
                        : 'Remove from models.json?'}
                    </span>
                    <Button
                      type="button"
                      variant="danger"
                      disabled={saving}
                      onClick={() => {
                        setConfirming(null)
                        void remove({ provider: model.provider, id: model.id })
                      }}
                      data-testid={`custom-model-remove-confirm-${model.id}`}
                    >
                      Remove
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton
                      label={`Edit ${model.id}`}
                      variant="ghost"
                      disabled={saving}
                      onClick={() => {
                        setEditing(key)
                        setAdding(false)
                      }}
                      data-testid={`custom-model-edit-${model.id}`}
                    >
                      <PencilIcon className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      label={`Remove ${model.id}`}
                      variant="ghost"
                      disabled={saving}
                      onClick={() => setConfirming(key)}
                      data-testid={`custom-model-remove-${model.id}`}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className="mt-2 text-[11px] leading-4 text-[var(--danger-text)]" data-testid="custom-model-list-error">
          {error}
        </p>
      )}
      {kernelWarning !== null && (
        <p role="status" className="mt-2 text-[11px] leading-4 text-[var(--warning-text)]" data-testid="custom-model-kernel-warning">
          Saved to models.json, but the kernel did not pick it up: {kernelWarning}
        </p>
      )}
    </div>
  )
}

export default memo(ModelsSettings)
