/**
 * Ticket 27 — turn references into the text the kernel actually receives.
 *
 * The kernel's `prompt()` takes a string, so there is no structured channel to
 * hand references to; they are rendered here instead. What the separate field
 * buys is that this happens in one place, on the side that can open the file a
 * mention points at. Before this, a mention delivered a path and nothing else —
 * asking "what's wrong with @foo.ts" gave the model a filename and no file.
 *
 * Two rules the renderer cannot enforce on its own, and which are the reason
 * this lives here:
 *
 *  - A reference that cannot be resolved is *stated*, never dropped. A mention
 *    that silently contributes nothing is indistinguishable from one that
 *    worked, and the failure surfaces later as a confidently wrong answer.
 *  - The block is bounded, and going over the bound omits the overflow with a
 *    line saying so. Refusing the prompt outright would lose the user's draft;
 *    quietly trimming it would send the model a file it never saw the end of.
 */

import type { PromptReference } from '../shared/contract/index'
import { readWorkspaceFile } from './workspaceFiles'

/** Everything the block may add to the prompt. Files are large; drafts are not. */
const MAX_BLOCK_CHARS = 60_000

/** One selection or snippet's share of that budget. */
const MAX_SNIPPET_CHARS = 8_000

export interface RenderedReferences {
  /** Empty when there is nothing to attach — the prompt text is then untouched. */
  block: string
  /** What could not be attached, in the user's words. Shown in the composer. */
  notices: string[]
}

function escape(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

export async function renderReferences(
  root: string,
  references: readonly PromptReference[] | undefined
): Promise<RenderedReferences> {
  if (references === undefined || references.length === 0) return { block: '', notices: [] }

  const notices: string[] = []
  const parts: string[] = []
  let used = 0

  for (const ref of references) {
    let body: string
    if (ref.kind === 'file') {
      const path = ref.path ?? ''
      if (path.length === 0) {
        notices.push('A file mention had no path and was left out.')
        continue
      }
      const outcome = await readWorkspaceFile(root, path)
      if (!outcome.ok) {
        notices.push(`Could not read ${path}: ${outcome.reason}.`)
        parts.push(
          `<reference kind="file" path="${escape(path)}" status="unreadable">\n` +
            `Could not be read: ${escape(outcome.reason)}.\n</reference>`
        )
        continue
      }
      const note = outcome.truncated
        ? `\n[truncated at ${outcome.content.length} characters]`
        : ''
      body = outcome.content + note
    } else {
      // Trimmed, matching what the renderer sends: a reference of nothing but
      // whitespace is an empty reference, and attaching it would put a blank
      // block in front of the model with no way to say what it was for.
      const text = (ref.text ?? '').trim()
      if (text.length === 0) {
        notices.push(`The ${ref.kind} reference "${ref.label}" was empty and was left out.`)
        continue
      }
      const clipped = clip(text, MAX_SNIPPET_CHARS)
      if (clipped.truncated) notices.push(`"${ref.label}" was cut short at ${MAX_SNIPPET_CHARS} characters.`)
      body = clipped.text
    }

    if (used + body.length > MAX_BLOCK_CHARS) {
      // Omit rather than trim: a half-file is worse than no file, because the
      // model has no way to tell which half it got.
      notices.push(`"${ref.label}" was left out — the attached context is over its limit.`)
      continue
    }
    used += body.length
    const attrs =
      ref.kind === 'file'
        ? `kind="file" path="${escape(ref.path ?? '')}"`
        : `kind="${ref.kind}" label="${escape(ref.label)}"`
    parts.push(`<reference ${attrs}>\n${body}\n</reference>`)
  }

  if (parts.length === 0) return { block: '', notices }
  return {
    block: `\n\n---\n\nContext attached by the user:\n\n${parts.join('\n\n')}`,
    notices
  }
}
