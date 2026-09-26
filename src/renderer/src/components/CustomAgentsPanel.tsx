import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { codexApi } from '../api'
import type { CustomAgentDefinitionInput, CustomAgentsSnapshot } from '../types'

const EMPTY_FORM: CustomAgentDefinitionInput = {
  name: '',
  description: '',
  tools: ['read', 'grep', 'find', 'ls'],
  enabled: true,
  persona: ''
}

function toolsToText(tools: string[]): string {
  return tools.join(', ')
}

function textToTools(raw: string): string[] {
  return raw
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0)
}

function AgentForm({
  initial,
  editing,
  busy,
  onSave,
  onCancel
}: {
  initial: CustomAgentDefinitionInput
  editing: boolean
  busy: boolean
  onSave: (input: CustomAgentDefinitionInput) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<CustomAgentDefinitionInput>(initial)
  useEffect(() => {
    setForm(initial)
  }, [initial])

  const field = 'w-full rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-xs text-[var(--text)]'

  return (
    <form
      className="mt-3 rounded-md border border-[var(--border)] px-3 py-3"
      data-testid="custom-agent-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ ...form, name: form.name.trim(), description: form.description.trim() })
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] text-[var(--text-muted)]">
          name
          <input
            className={field}
            value={form.name}
            disabled={editing}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            data-testid="custom-agent-name"
          />
        </label>
        <label className="text-[11px] text-[var(--text-muted)]">
          label
          <input
            className={field}
            value={form.label ?? ''}
            onChange={(event) => setForm({ ...form, label: event.target.value })}
          />
        </label>
      </div>
      <label className="mt-2 block text-[11px] text-[var(--text-muted)]">
        description
        <input
          className={field}
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          data-testid="custom-agent-description"
        />
      </label>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <label className="text-[11px] text-[var(--text-muted)]">
          model (provider/id)
          <input
            className={field}
            value={form.model ?? ''}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
          />
        </label>
        <label className="text-[11px] text-[var(--text-muted)]">
          tools (comma list)
          <input
            className={field}
            value={toolsToText(form.tools)}
            onChange={(event) => setForm({ ...form, tools: textToTools(event.target.value) })}
            data-testid="custom-agent-tools"
          />
        </label>
        <label className="text-[11px] text-[var(--text-muted)]">
          maxTurns
          <input
            className={field}
            type="number"
            min={1}
            value={form.maxTurns ?? ''}
            onChange={(event) =>
              setForm({
                ...form,
                maxTurns: event.target.value === '' ? undefined : Number(event.target.value)
              })
            }
          />
        </label>
      </div>
      <label className="mt-2 block text-[11px] text-[var(--text-muted)]">
        system prompt
        <textarea
          className={`${field} mt-0.5 h-24 resize-y`}
          value={form.persona}
          onChange={(event) => setForm({ ...form, persona: event.target.value })}
          data-testid="custom-agent-persona"
        />
      </label>
      <div className="mt-2 flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />
          enabled
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || form.name.trim() === '' || form.description.trim() === '' || form.persona.trim() === ''}
            className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] disabled:opacity-50"
            data-testid="custom-agent-save"
          >
            {editing ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </form>
  )
}

function AgentRow({
  agent,
  busy,
  onToggle,
  onEdit,
  onDelete
}: {
  agent: CustomAgentsSnapshot['agents'][number]
  busy: boolean
  onToggle: (name: string, enabled: boolean) => void
  onEdit: (agent: CustomAgentsSnapshot['agents'][number]) => void
  onDelete: (name: string) => void
}): ReactNode {
  return (
    <li
      className="flex items-start justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-2"
      data-testid={`agent-row-${agent.name}`}
    >
      <div className="min-w-0">
        <p className="text-xs text-[var(--text)]">
          <span className="font-medium">{agent.name}</span>
          {agent.builtin && (
            <span className="ml-1.5 rounded bg-[var(--surface)] px-1 py-0.5 text-[10px] text-[var(--text-muted)]">
              built-in
            </span>
          )}
          {!agent.enabled && (
            <span className="ml-1.5 rounded bg-[var(--surface)] px-1 py-0.5 text-[10px] text-[var(--text-muted)]">
              off
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{agent.description}</p>
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]" title={agent.tools.join(', ')}>
          {agent.tools.join(', ')}
          {agent.model !== undefined ? ` · model ${agent.model}` : ' · follows session model'}
          {agent.maxTurns !== undefined ? ` · maxTurns ${agent.maxTurns}` : ''}
        </p>
      </div>
      {!agent.builtin && (
        <div className="flex shrink-0 items-center gap-1.5">
          <label className="flex items-center text-[10px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={agent.enabled}
              disabled={busy}
              onChange={(event) => onToggle(agent.name, event.target.checked)}
              data-testid={`agent-toggle-${agent.name}`}
            />
          </label>
          <button
            type="button"
            onClick={() => onEdit(agent)}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(agent.name)}
            disabled={busy}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
            data-testid={`agent-delete-${agent.name}`}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  )
}

export function CustomAgentsPanel(): ReactNode {
  const [snapshot, setSnapshot] = useState<CustomAgentsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<CustomAgentDefinitionInput | null>(null)

  const load = useCallback(async () => {
    try {
      setSnapshot(await codexApi.listCustomAgents())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(
    async (action: () => Promise<CustomAgentsSnapshot>) => {
      setBusy(true)
      setError(null)
      try {
        setSnapshot(await action())
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-[var(--text-muted)]">
          Reusable roles from definition files under ~/.flexagent/agents. Changes apply to new
          sessions — running ones keep the roles they started with.
        </p>
        <button
          type="button"
          onClick={() => setEditing({ ...EMPTY_FORM })}
          disabled={busy}
          className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)] disabled:opacity-50"
          data-testid="custom-agent-new"
        >
          New subagent
        </button>
      </div>

      {error !== null && (
        <p className="mt-2 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text)]" data-testid="custom-agent-error">
          {error}
        </p>
      )}

      {editing !== null && (
        <AgentForm
          initial={editing}
          editing={snapshot?.agents.some((agent) => agent.name === editing.name) === true}
          busy={busy}
          onSave={(input) => {
            void run(async () => {
              const next = await codexApi.saveCustomAgent(input)
              setEditing(null)
              return next
            })
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {snapshot !== null && snapshot.agents.length > 0 && (
        <ul className="mt-3 space-y-2">
          {snapshot.agents.map((agent) => (
            <AgentRow
              key={agent.name}
              agent={agent}
              busy={busy}
              onToggle={(name, enabled) =>
                void run(() => codexApi.setCustomAgentEnabled({ name, enabled }))
              }
              onEdit={(agent) =>
                setEditing({
                  name: agent.name,
                  description: agent.description,
                  label: agent.label,
                  tools: agent.tools,
                  enabled: agent.enabled,
                  persona: agent.persona,
                  ...(agent.model !== undefined ? { model: agent.model } : {}),
                  ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {})
                })
              }
              onDelete={(name) => void run(() => codexApi.deleteCustomAgent({ name }))}
            />
          ))}
        </ul>
      )}

      {snapshot !== null && snapshot.diagnostics.length > 0 && (
        <ul className="mt-3 space-y-1" data-testid="custom-agent-diagnostics">
          {snapshot.diagnostics.map((diag, i) => (
            <li key={i} className="text-[11px] text-[var(--text-muted)]">
              {diag.severity === 'error' ? 'error' : 'warning'} · {diag.file} · {diag.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default CustomAgentsPanel
