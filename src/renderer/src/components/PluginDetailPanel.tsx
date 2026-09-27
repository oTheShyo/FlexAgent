import { memo, useEffect, useRef, useState } from 'react'
import type { PluginCapabilities, PluginComponentKind, PluginDetail } from '../types'
import { ComponentKindIcon, PluginIcon } from './pluginIcons'
import { Button, IconButton } from './ui'

export interface PluginDetailPanelProps {
  open: boolean
  detail: PluginDetail | null
  loading: boolean
  uninstallBusy: boolean
  onClose: () => void
  onUninstall: (id: string) => void
  /**
   * Ticket 22: grant a plugin the capabilities it declares, or take the grant
   * back with `null`. Absent = the bridge has no such call, so the panel shows
   * what the plugin runs with and offers no controls for changing it.
   */
  onSetCapabilities?: (id: string, capabilities: PluginCapabilities | null) => void
  capabilityBusy?: boolean
}

const KIND_ORDER: PluginComponentKind[] = ['extension', 'skill', 'command', 'hook', 'mcp']

const KIND_HEADING: Record<PluginComponentKind, string> = {
  extension: 'Extensions',
  skill: 'Skills',
  command: 'Commands',
  hook: 'Hooks',
  mcp: 'MCP'
}

function CloseIcon() {
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
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </svg>
  )
}

function ExternalIcon() {
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
      <path d="M14 5h5v5" />
      <path d="m19 5-9 9" />
      <path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" />
    </svg>
  )
}

function authorName(author: PluginDetail['author']): string | null {
  if (author === undefined) return null
  if (typeof author === 'string') return author
  return author.name ?? null
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-xs">
      <span className="w-20 shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 flex-1 text-[var(--text-secondary)]">{children}</span>
    </div>
  )
}

function PluginDetailPanel({
  open,
  detail,
  loading,
  uninstallBusy,
  onClose,
  onUninstall,
  onSetCapabilities,
  capabilityBusy = false
}: PluginDetailPanelProps) {
  const [configOpen, setConfigOpen] = useState(false)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  const grouped = new Map<PluginComponentKind, PluginDetail['components']>()
  if (detail !== null) {
    for (const component of detail.components) {
      const list = grouped.get(component.kind) ?? []
      list.push(component)
      grouped.set(component.kind, list)
    }
  }

  const author = detail === null ? null : authorName(detail.author)

  return (
    <div className="fixed inset-0 z-40" role="presentation">
      <button
        type="button"
        aria-label="Close plugin details"
        tabIndex={-1}
        onClick={onClose}
        className="fx-overlay absolute inset-0 h-full w-full cursor-default bg-[var(--overlay)]"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Plugin details"
        tabIndex={-1}
        data-testid="plugin-detail"
        className="fx-slide-right absolute inset-y-0 right-0 flex w-[520px] max-w-[92vw] flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-overlay)] focus:outline-none"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
              <PluginIcon className="h-3.5 w-3.5" />
            </span>
            <h2 className="truncate text-sm font-semibold text-[var(--text)]">
              {detail?.name ?? 'Plugin'}
            </h2>
            {detail !== null && (
              <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                v{detail.version}
              </span>
            )}
          </div>
          <IconButton
            variant="ghost"
            label="Close plugin details"
            onClick={onClose}
            className="shrink-0"
          >
            <CloseIcon />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading && detail === null ? (
            <p className="text-xs text-[var(--text-muted)]" role="status">
              Loading details…
            </p>
          ) : detail === null ? (
            <p className="text-xs text-[var(--text-muted)]">No plugin selected.</p>
          ) : (
            <div className="space-y-5">
              {detail.description !== undefined && (
                <p className="text-sm leading-5 text-[var(--text-secondary)]">
                  {detail.description}
                </p>
              )}

              <section aria-label="Plugin information" className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2">
                {author !== null && <MetaRow label="Author">{author}</MetaRow>}
                <MetaRow label="Source">{detail.source.label}</MetaRow>
                <MetaRow label="Root">
                  <span className="break-all font-mono text-[11px]">{detail.rootPath}</span>
                </MetaRow>
                {detail.homepage !== undefined && (
                  <MetaRow label="Homepage">
                    <a
                      href={detail.homepage}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--text)] underline decoration-[var(--border-strong)] underline-offset-2 hover:decoration-[var(--text)]"
                    >
                      {detail.homepage}
                      <ExternalIcon />
                    </a>
                  </MetaRow>
                )}
                {detail.keywords !== undefined && detail.keywords.length > 0 && (
                  <MetaRow label="Keywords">
                    <span className="flex flex-wrap gap-1">
                      {detail.keywords.map((keyword) => (
                        <span
                          key={keyword}
                          className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
                        >
                          {keyword}
                        </span>
                      ))}
                    </span>
                  </MetaRow>
                )}
              </section>

              {detail.capabilities !== undefined && (
                <section
                  aria-label="Plugin capabilities"
                  data-testid="plugin-capabilities"
                >
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                    Capabilities
                  </h3>
                  <ul className="mt-1.5 space-y-1">
                    {detail.capabilities.lines.map((line) => (
                      <li
                        key={line}
                        className="flex items-start gap-1.5 text-[11px] leading-4 text-[var(--text-secondary)]"
                      >
                        <span
                          aria-hidden="true"
                          className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--text-subtle)]"
                        />
                        {line}
                      </li>
                    ))}
                  </ul>
                  {detail.capabilities.needsGrant && (
                    <div className="mt-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2.5 py-2">
                      <p className="text-[11px] leading-4 text-[var(--warning-text)]">
                        {detail.capabilities.granted
                          ? 'You granted this. Its hooks run with these capabilities.'
                          : 'This asks for more than its source gets by default. Until you grant it, it runs at the minimum — which may break its hooks.'}
                      </p>
                      {onSetCapabilities !== undefined && (
                        <div className="mt-2 flex gap-2">
                          {detail.capabilities.granted ? (
                            <Button
                              variant="secondary"
                              disabled={capabilityBusy}
                              data-testid="plugin-capability-revoke"
                              onClick={() => onSetCapabilities(detail.id, null)}
                            >
                              Revoke
                            </Button>
                          ) : (
                            <Button
                              variant="primary"
                              disabled={capabilityBusy}
                              data-testid="plugin-capability-grant"
                              onClick={() => {
                                if (detail !== null && detail.capabilities !== undefined) {
                                  onSetCapabilities(detail.id, detail.capabilities.requested)
                                }
                              }}
                            >
                              Grant
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}

              <section aria-label="Plugin components">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                  Components
                </h3>
                {detail.components.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--text-muted)]">No components.</p>
                ) : (
                  KIND_ORDER.map((kind) => {
                    const items = grouped.get(kind)
                    if (items === undefined) return null
                    return (
                      <div key={kind} className="mt-3">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
                          <span className="text-[var(--text-muted)]">
                            <ComponentKindIcon kind={kind} />
                          </span>
                          {KIND_HEADING[kind]}
                          <span className="text-[11px] font-normal text-[var(--text-muted)]">
                            {items.length}
                          </span>
                        </div>
                        <ul className="mt-1.5 space-y-1.5">
                          {items.map((component) => (
                            <li
                              key={`${kind}:${component.name}`}
                              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2"
                            >
                              <div className="text-xs font-medium text-[var(--text)]">
                                {component.name}
                              </div>
                              {component.description !== undefined && (
                                <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-muted)]">
                                  {component.description}
                                </p>
                              )}
                              {component.path !== undefined && (
                                <p className="mt-0.5 break-all font-mono text-[10px] text-[var(--text-subtle)]">
                                  {component.path}
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  })
                )}
              </section>

              {detail.diagnostics !== undefined && detail.diagnostics.length > 0 && (
                <section aria-label="Plugin diagnostics">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                    Diagnostics
                  </h3>
                  <ul className="mt-1.5 space-y-1.5">
                    {detail.diagnostics.map((diagnostic) => (
                      <li
                        key={`${diagnostic.code}:${diagnostic.message}`}
                        className={`rounded-md border px-2.5 py-2 text-[11px] leading-4 ${
                          diagnostic.severity === 'error'
                            ? 'border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)]'
                            : 'border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning-text)]'
                        }`}
                      >
                        <span className="font-mono font-medium">{diagnostic.code}</span>
                        <span className="mx-1.5 opacity-50">·</span>
                        {diagnostic.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {detail.userConfig !== undefined && detail.userConfig.length > 0 && (
                <section aria-label="Plugin configuration">
                  <button
                    type="button"
                    onClick={() => setConfigOpen((value) => !value)}
                    aria-expanded={configOpen}
                    aria-controls="plugin-config-panel"
                    className="flex w-full items-center gap-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)] transition-colors hover:text-[var(--text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    data-testid="plugin-config-toggle"
                  >
                    Configuration (read-only)
                    <svg
                      className={`h-3 w-3 transition-transform ${configOpen ? 'rotate-180' : ''}`}
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
                  </button>
                  {configOpen && (
                    <ul id="plugin-config-panel" className="mt-1.5 space-y-1.5">
                      {detail.userConfig.map((spec) => (
                        <li
                          key={spec.key}
                          title={
                            spec.sensitive === true
                              ? "Sensitive values can't be edited yet"
                              : undefined
                          }
                          className={`rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 ${
                            spec.sensitive === true ? 'opacity-60' : ''
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-medium text-[var(--text)]">
                              {spec.title}
                            </span>
                            <span className="rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                              {spec.type}
                            </span>
                            {spec.required === true && (
                              <span className="rounded-full border border-[var(--border-strong)] bg-[var(--active)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text)]">
                                Required
                              </span>
                            )}
                            {spec.sensitive === true && (
                              <span className="rounded-full border border-[var(--warning-border)] bg-[var(--warning-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--warning-text)]">
                                Sensitive
                              </span>
                            )}
                          </div>
                          {spec.description !== undefined && (
                            <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-muted)]">
                              {spec.description}
                            </p>
                          )}
                          {spec.default !== undefined && (
                            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                              Default:{' '}
                              <span className="font-mono">{String(spec.default)}</span>
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between border-t border-[var(--border)] px-4 py-3">
          <span className="text-[11px] text-[var(--text-muted)]">
            {uninstallBusy ? 'Uninstalling…' : undefined}
          </span>
          <Button
            variant="danger"
            disabled={detail === null || uninstallBusy}
            onClick={() => {
              if (detail !== null) onUninstall(detail.id)
            }}
            data-testid="plugin-uninstall"
          >
            Uninstall
          </Button>
        </footer>
      </aside>
    </div>
  )
}

export default memo(PluginDetailPanel)
