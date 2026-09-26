import { memo, useMemo, useState } from 'react'
import type { McpServerStatusEntry, UserMcpSaveInput, UserMcpServerConfig, UserMcpTransport } from '../types'
import { Button, Chip } from './ui'
import { ToggleSwitch } from './ToggleSwitch'
import type { UseUserMcpResult } from '../hooks/useUserMcp'

const inputClass =
  'h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60'

function statusOf(
  status: Map<string, McpServerStatusEntry>,
  key: string
): McpServerStatusEntry | undefined {
  return status.get(key)
}

function StatusLine({ entry }: { entry: McpServerStatusEntry | undefined }) {
  if (entry === undefined) {
    return <span className="text-[11px] text-[var(--text-subtle)]">未连接（内核挂载后上报）</span>
  }
  // Connecting first: an npx-spawned server was measured at 5.9–6.9 s, and a
  // panel that says nothing during that window reads as a broken feature.
  if (entry.status === 'connecting') {
    return (
      <span className="text-[11px] text-[var(--text-muted)]">
        连接中…（不阻塞会话，就绪后新会话生效）
      </span>
    )
  }
  if (!entry.connected) {
    return (
      <span className="text-[11px] text-[var(--warning-text)]" title={entry.error ?? undefined}>
        连接失败{entry.error !== undefined ? `：${entry.error}` : ''}
      </span>
    )
  }
  return (
    <span className="text-[11px] text-[var(--text-muted)]">
      已连接{entry.toolCount !== undefined ? ` · ${entry.toolCount} 工具` : ''}
    </span>
  )
}

function AddServerForm({
  busy,
  onCancel,
  onSubmit
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (input: UserMcpSaveInput) => Promise<boolean>
}) {
  const [transport, setTransport] = useState<UserMcpTransport>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const buildConfig = (): UserMcpServerConfig | null => {
    if (jsonMode) {
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>
        const type = parsed.type === 'http' ? 'http' : parsed.type === 'sse' ? 'sse' : 'stdio'
        if (type === 'http' || type === 'sse') {
          return {
            type,
            url: typeof parsed.url === 'string' ? parsed.url : '',
            ...(parsed.headers !== undefined && typeof parsed.headers === 'object'
              ? { headers: parsed.headers as Record<string, string> }
              : {}),
            ...(parsed.timeoutMs !== undefined && typeof parsed.timeoutMs === 'number'
              ? { timeoutMs: parsed.timeoutMs }
              : {})
          }
        }
        return {
          type: 'stdio',
          command: typeof parsed.command === 'string' ? parsed.command : '',
          ...(Array.isArray(parsed.args) ? { args: parsed.args.filter((a): a is string => typeof a === 'string') } : {}),
          ...(parsed.env !== undefined && typeof parsed.env === 'object'
            ? { env: parsed.env as Record<string, string> }
            : {})
        }
      } catch {
        setLocalError('JSON 解析失败')
        return null
      }
    }
    if (transport === 'http' || transport === 'sse') {
      let headers: Record<string, string> | undefined
      if (headersText.trim().length > 0) {
        try {
          headers = JSON.parse(headersText) as Record<string, string>
        } catch {
          setLocalError('Headers 必须是 JSON 对象，例如 {"Authorization": "Bearer xxx"}')
          return null
        }
      }
      return {
        type: transport,
        url: url.trim(),
        ...(headers !== undefined ? { headers } : {})
      }
    }
    const argList = args
      .split(/\s+/)
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0)
    return {
      type: 'stdio',
      command: command.trim(),
      ...(argList.length > 0 ? { args: argList } : {})
    }
  }

  const submit = async (): Promise<void> => {
    setLocalError(null)
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      setLocalError('名称必填')
      return
    }
    const config = buildConfig()
    if (config === null) return
    const ok = await onSubmit({ name: trimmedName, config })
    if (ok) {
      setName('')
      setCommand('')
      setArgs('')
      setUrl('')
      setHeadersText('')
      setJsonText('')
      onCancel()
    }
  }

  return (
    <form
      className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
      data-testid="mcp-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex items-center gap-2">
        <Chip active={!jsonMode} onClick={() => setJsonMode(false)} aria-pressed={!jsonMode} className="h-6 px-2 text-[11px]">
          表单
        </Chip>
        <Chip active={jsonMode} onClick={() => setJsonMode(true)} aria-pressed={jsonMode} className="h-6 px-2 text-[11px]">
          JSON
        </Chip>
        {!jsonMode && (
          <span className="ml-auto flex items-center gap-1.5" role="group" aria-label="传输类型">
            <Chip active={transport === 'stdio'} onClick={() => setTransport('stdio')} aria-pressed={transport === 'stdio'} className="h-6 px-2 text-[11px]">
              stdio
            </Chip>
            <Chip active={transport === 'http'} onClick={() => setTransport('http')} aria-pressed={transport === 'http'} className="h-6 px-2 text-[11px]">
              http
            </Chip>
            <Chip active={transport === 'sse'} onClick={() => setTransport('sse')} aria-pressed={transport === 'sse'} className="h-6 px-2 text-[11px]">
              sse
            </Chip>
          </span>
        )}
      </div>

      <div className="mt-2.5">
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="名称，如 github"
          aria-label="MCP 服务名称"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className={inputClass}
          data-testid="mcp-add-name"
        />
      </div>

      {jsonMode ? (
        <textarea
          value={jsonText}
          onChange={(event) => setJsonText(event.target.value)}
          placeholder={`{\n  "type": "stdio",\n  "command": "cmd",\n  "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "D:\\\\dir"]\n}`}
          aria-label="MCP 配置 JSON"
          rows={7}
          spellCheck={false}
          disabled={busy}
          className="mt-2.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[11px] leading-5 text-[var(--text)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60"
          data-testid="mcp-add-json"
        />
      ) : transport === 'stdio' ? (
        <>
          <div className="mt-2.5 flex gap-2">
            <input
              type="text"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="命令，如 cmd 或 node"
              aria-label="启动命令"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className={inputClass}
            />
            <input
              type="text"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder="参数（空格分隔），如 /c npx -y server"
              aria-label="启动参数"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className={inputClass}
            />
          </div>
        </>
      ) : (
        <>
          <div className="mt-2.5">
            <input
              type="text"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/mcp"
              aria-label="MCP URL"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className={inputClass}
            />
          </div>
          <div className="mt-2.5">
            <input
              type="text"
              value={headersText}
              onChange={(event) => setHeadersText(event.target.value)}
              placeholder='Headers JSON（可选），如 {"Authorization": "Bearer xxx"}'
              aria-label="HTTP Headers JSON"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className={inputClass}
            />
          </div>
        </>
      )}

      {(localError !== null) && (
        <p role="alert" className="mt-2 text-[11px] text-[var(--warning-text)]">
          {localError}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy} data-testid="mcp-add-cancel">
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy} data-testid="mcp-add-submit">
          保存
        </Button>
      </div>
    </form>
  )
}

function McpPanel({ mcp }: { mcp: UseUserMcpResult }) {
  const [adding, setAdding] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const pluginRows = useMemo(() => {
    // A flipped-off plugin server disappears from the bridge status, so the
    // rows merge both sources: bridged servers (live status) plus any
    // user-disabled keys that must stay visible with their toggle off.
    const rows: { key: string; label: string; type: string }[] = []
    for (const [key, entry] of mcp.status) {
      if (entry.source !== 'plugin') continue
      rows.push({ key, label: key.replace(/^plugin:/, ''), type: entry.type })
    }
    for (const key of Object.keys(mcp.pluginOverrides)) {
      if (!key.startsWith('plugin:')) continue
      if (rows.some((row) => row.key === key)) continue
      rows.push({ key, label: key.replace(/^plugin:/, ''), type: 'disabled' })
    }
    rows.sort((a, b) => a.key.localeCompare(b.key))
    return rows
  }, [mcp.status, mcp.pluginOverrides])

  // Bridge-level notices: tool-name collisions between servers, and anything
  // else the worker wants said out loud rather than dropped silently.
  const warnings = useMemo(() => {
    const out: string[] = []
    for (const entry of mcp.status.values()) {
      if (entry.warnings !== undefined) out.push(...entry.warnings)
    }
    return out
  }, [mcp.status])

  return (
    <div data-testid="mcp-panel">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          自定义 MCP 服务保存在本机 <code className="rounded bg-[var(--surface-sunken)] px-1">~/.flexagent/mcp.json</code>
          ，保存后内核自动重载。插件自带的 MCP 在对应插件里管理。
        </p>
        <Button
          variant="primary"
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
          data-testid="mcp-add-toggle"
          className="shrink-0"
        >
          {adding ? '收起' : '添加 MCP'}
        </Button>
      </div>

      {adding && (
        <AddServerForm busy={mcp.busyName !== null} onCancel={() => setAdding(false)} onSubmit={mcp.save} />
      )}

      {mcp.error !== null && (
        <div role="alert" data-testid="mcp-error" className="mt-3 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]">
          {mcp.error}
        </div>
      )}

      {warnings.length > 0 && (
        <div
          data-testid="mcp-warnings"
          className="mt-3 space-y-1 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
        >
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-4">
        <section aria-label="自定义 MCP 服务">
          <h3 className="flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
            自定义
            <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">{mcp.servers.length}</span>
          </h3>
          {mcp.loading ? (
            <p className="mt-2 text-xs text-[var(--text-muted)]" role="status">
              加载中…
            </p>
          ) : mcp.servers.length === 0 ? (
            <p className="mt-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">
              还没有自定义 MCP 服务。粘贴一份 Claude / Cursor 格式的 mcpServers 配置即可直接使用。
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {mcp.servers.map((server) => {
                const entry = statusOf(mcp.status, `user:${server.name}`)
                const busy = mcp.busyName === server.name
                return (
                  <div
                    key={server.name}
                    data-testid={`mcp-row-${server.name}`}
                    className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium text-[var(--text)]">{server.name}</span>
                        <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                          {server.config.type}
                        </span>
                      </div>
                      <div className="mt-0.5">
                        <StatusLine entry={entry} />
                      </div>
                    </div>
                    {busy && (
                      <span className="shrink-0 text-[11px] text-[var(--text-muted)]" role="status">
                        保存中…
                      </span>
                    )}
                    <ToggleSwitch
                      checked={server.config.enabled !== false}
                      disabled={busy}
                      label={`${server.config.enabled !== false ? '禁用' : '启用'} ${server.name}`}
                      testId={`mcp-toggle-${server.name}`}
                      onClick={() => void mcp.toggle(server.name, server.config.enabled === false)}
                    />
                    {confirmRemove === server.name ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmRemove(null)
                            void mcp.remove(server.name)
                          }}
                          className="rounded-md border border-[var(--warning-border)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning-text)] hover:bg-[var(--hover)]"
                          data-testid={`mcp-remove-confirm-${server.name}`}
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(null)}
                          className="rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--hover)]"
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(server.name)}
                        aria-label={`删除 ${server.name}`}
                        className="shrink-0 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]"
                        data-testid={`mcp-remove-${server.name}`}
                      >
                        删除
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {pluginRows.length > 0 && (
          <section aria-label="插件提供的 MCP 服务">
            <h3 className="flex items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
              来自插件
              <span className="font-normal normal-case tracking-normal text-[var(--text-muted)]">{pluginRows.length}</span>
            </h3>
            <div className="mt-2 space-y-2">
              {pluginRows.map((row) => {
                const entry = mcp.status.get(row.key)
                const enabled = mcp.pluginOverrides[row.key]?.enabled !== false
                return (
                  <div
                    key={row.key}
                    data-testid={`mcp-row-${row.key}`}
                    className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium text-[var(--text)]">{row.label}</span>
                        <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                          {row.type}
                        </span>
                      </div>
                      <div className="mt-0.5">
                        {enabled ? (
                          <StatusLine entry={entry} />
                        ) : (
                          <span className="text-[11px] text-[var(--text-subtle)]">已停用</span>
                        )}
                      </div>
                    </div>
                    <ToggleSwitch
                      checked={enabled}
                      label={`${enabled ? '禁用' : '启用'} ${row.label}`}
                      testId={`mcp-toggle-${row.key}`}
                      onClick={() => void mcp.togglePluginServer(row.key, !enabled)}
                    />
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export interface McpSectionProps {
  mcp: UseUserMcpResult
}

function McpSection({ mcp }: McpSectionProps) {
  return <McpPanel mcp={mcp} />
}

export default memo(McpSection)
