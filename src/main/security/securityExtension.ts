/**
 * Security extension — the two output boundaries (security §敏感信息输出过滤).
 *
 * A tool result crosses two boundaries before the user sees it:
 *
 *   1. into the model context — a credential read from a file or an environment
 *      variable is then visible to the provider, and re-emitted in later turns;
 *   2. into the transcript — the same content is persisted and replayed.
 *
 * Both are closed at the kernel's own hook points rather than in the UI, because
 * filtering at the display layer would still have leaked to the provider:
 *
 * - `tool_result`  — every tool result (read, bash, grep, MCP, custom tools) is
 *   masked *before* it enters the context. This is the layer that matters most:
 *   it is where `cat .env` stops being a leak.
 * - `message_end`  — the assistant's final message is masked before it is
 *   persisted, so a secret the model reconstructed from context cannot be
 *   written to the transcript or replayed to the provider next turn.
 *
 * Known limitation, stated rather than papered over: text already streamed to
 * the UI as deltas (`text_delta`) was emitted before this hook runs, so a user
 * watching the stream may see the value in that one render pass. Retro-masking
 * the display would mean buffering the stream, i.e. giving up streaming. The
 * value never reaches the model provider and never reaches the saved
 * transcript, which is the part that has lasting consequences.
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import { recordAudit } from './auditLog'
import { redactSecrets } from './secretPatterns'

/**
 * Structural view of an agent message. The kernel exports the hook's event but
 * not its message type (`AgentMessage` lives in pi-agent-core), and all this
 * module needs is `content` — so it matches on shape instead of importing a
 * type the package does not re-export.
 */
interface RedactableMessage {
  role?: string
  content?: unknown
  [key: string]: unknown
}

export interface SecurityExtensionOptions {
  /**
   * Working directory of the sessions this loader serves, used only as the
   * `actor` on redaction audit entries — the hook carries no session identity.
   */
  cwd?: string
}

type ContentBlock = { type?: string; text?: string; [key: string]: unknown }

function redactBlocks(
  blocks: unknown,
  onHit: (kinds: string[], count: number) => void
): { blocks: ContentBlock[]; changed: boolean } {
  if (!Array.isArray(blocks)) return { blocks: [], changed: false }
  const kinds = new Set<string>()
  let count = 0
  let changed = false
  const out = (blocks as ContentBlock[]).map((block) => {
    if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
      return block
    }
    const result = redactSecrets(block.text)
    if (result.hits.length === 0) return block
    changed = true
    count += result.hits.length
    for (const hit of result.hits) kinds.add(hit.kind)
    return { ...block, text: result.text }
  })
  if (changed) onHit([...kinds], count)
  return { blocks: out, changed }
}

/** Message content is either a plain string or a block array depending on the role. */
function redactMessage(message: RedactableMessage): RedactableMessage | undefined {
  const record = message
  if (typeof record.content === 'string') {
    const result = redactSecrets(record.content)
    if (result.hits.length === 0) return undefined
    recordAudit({
      kind: 'redaction',
      sessionId: '',
      actor: 'assistant-message',
      tool: 'message_end',
      outcome: `${result.hits.length} masked`,
      reason: [...new Set(result.hits.map((hit) => hit.kind))].join(', ')
    })
    return { ...message, content: result.text }
  }
  if (Array.isArray(record.content)) {
    const { blocks, changed } = redactBlocks(record.content, (kinds, count) =>
      recordAudit({
        kind: 'redaction',
        sessionId: '',
        actor: 'assistant-message',
        tool: 'message_end',
        outcome: `${count} masked`,
        reason: kinds.join(', ')
      })
    )
    if (!changed) return undefined
    return { ...message, content: blocks }
  }
  return undefined
}

export function createSecurityExtension(options: SecurityExtensionOptions = {}): InlineExtension {
  return {
    name: 'flex-security',
    factory: (pi: ExtensionAPI): void => {
      const actorBase = options.cwd ?? ''

      pi.on('tool_result', (event) => {
        const { blocks, changed } = redactBlocks(event.content, (kinds, count) =>
          recordAudit({
            kind: 'redaction',
            sessionId: '',
            actor: actorBase,
            tool: event.toolName,
            outcome: `${count} masked`,
            reason: kinds.join(', ')
          })
        )
        // Returning a result replaces the tool output that the model receives.
        return changed ? { content: blocks as typeof event.content } : undefined
      })

      pi.on('message_end', (event) => {
        const redacted = redactMessage(event.message as unknown as RedactableMessage)
        return redacted === undefined
          ? undefined
          : { message: redacted as unknown as typeof event.message }
      })
    }
  }
}
