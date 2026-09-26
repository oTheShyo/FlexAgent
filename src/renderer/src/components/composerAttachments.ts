/**
 * Composer attachments: staging, validation and prompt inlining.
 *
 * The contract has no attachment field (`PromptInput` is
 * `{ sessionId, text, mode }`), so there is no transport for an upload and no
 * path the kernel would read on its own. The honest thing a renderer can do is
 * stage the dropped files for real, validate them, read the text ones here and
 * inline their contents into the prompt behind an explicit delimiter.
 * Anything that cannot be inlined is rejected with a visible reason instead of
 * quietly pasting a filename that would mean nothing to the agent.
 */

/** Files per message. */
export const MAX_ATTACHMENTS = 5
/** Per-file cap for inlined text. */
export const MAX_TEXT_BYTES = 64 * 1024
/** Combined cap across one message. */
export const MAX_TOTAL_BYTES = 192 * 1024

const TEXT_EXTENSIONS = new Set([
  'c',
  'cc',
  'cfg',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'cts',
  'env',
  'go',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'log',
  'md',
  'mdx',
  'mjs',
  'mts',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml'
])

const TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'procfile',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc'
])

const TEXT_MIMES = new Set([
  'application/javascript',
  'application/json',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-httpd-php',
  'application/x-sh',
  'application/xml',
  'application/yaml',
  'image/svg+xml'
])

export interface StagedAttachment {
  id: string
  name: string
  size: number
  text: string
}

export interface AttachmentRejection {
  name: string
  reason: string
}

export interface StageResult {
  accepted: StagedAttachment[]
  rejected: AttachmentRejection[]
}

let attachmentCounter = 0

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isTextLike(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (TEXT_MIMES.has(file.type)) return true
  if (TEXT_EXTENSIONS.has(extensionOf(file.name))) return true
  return TEXT_FILENAMES.has(file.name.toLowerCase())
}

/** Returns null when the file is acceptable, otherwise the reason to show. */
function rejectionFor(file: File): string | null {
  if (file.name.length === 0) return 'file name is unreadable'
  if (file.size === 0) return 'empty file (nothing to inline)'
  if (file.type.startsWith('image/')) return 'images cannot be attached yet'
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
    return 'media files cannot be attached yet'
  }
  if (file.size > MAX_TEXT_BYTES) {
    return `too large (${formatBytes(file.size)}, limit ${formatBytes(MAX_TEXT_BYTES)})`
  }
  if (!isTextLike(file)) return 'only text files can be attached'
  return null
}

function makeId(file: File): string {
  attachmentCounter += 1
  return `att_${attachmentCounter}_${file.name}`
}

export function describeRejections(rejected: readonly AttachmentRejection[]): string | null {
  if (rejected.length === 0) return null
  const parts = rejected.map((entry) => `${entry.name} — ${entry.reason}`)
  return parts.length === 1
    ? `Not attached: ${parts[0]}`
    : `Not attached (${parts.length}): ${parts.join('; ')}`
}

/**
 * Validates `files` against the current staging list and reads the accepted
 * ones. Reading happens here rather than at submit time so the caps can be
 * enforced before the user writes a prompt around unavailable content.
 */
export async function stageAttachments(
  files: readonly File[],
  existing: readonly StagedAttachment[]
): Promise<StageResult> {
  const accepted: StagedAttachment[] = []
  const rejected: AttachmentRejection[] = []
  let totalBytes = existing.reduce((sum, entry) => sum + entry.size, 0)
  let count = existing.length

  for (const file of files) {
    const reason = rejectionFor(file)
    if (reason !== null) {
      rejected.push({ name: file.name || 'unnamed file', reason })
      continue
    }
    if (count >= MAX_ATTACHMENTS) {
      rejected.push({ name: file.name, reason: `attachment limit is ${MAX_ATTACHMENTS}` })
      continue
    }
    if (totalBytes + file.size > MAX_TOTAL_BYTES) {
      rejected.push({
        name: file.name,
        reason: `would exceed the ${formatBytes(MAX_TOTAL_BYTES)} per-message limit`
      })
      continue
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      rejected.push({ name: file.name, reason: 'could not be read' })
      continue
    }
    if (text.includes('\u0000')) {
      rejected.push({ name: file.name, reason: 'looks binary despite its extension' })
      continue
    }
    accepted.push({ id: makeId(file), name: file.name, size: file.size, text })
    totalBytes += file.size
    count += 1
  }

  return { accepted, rejected }
}

/**
 * Renders the staged files as one prompt suffix. Delimiters are plain ASCII so
 * the boundaries survive any markdown rendering the agent does.
 */
export function buildAttachmentBlock(attachments: readonly StagedAttachment[]): string {
  return attachments
    .map((entry) => `--- ${entry.name} ---\n${entry.text.trimEnd()}\n--- end ${entry.name} ---`)
    .join('\n')
}

/**
 * Composes the text the kernel receives: the draft, then the inlined files,
 * then the reference block the user picked (`@`/selection/`#`) — passed in
 * already formatted by `formatReferencesBlock`, so this module stays about
 * attachments and the reference module stays about references.
 *
 * References sit last on purpose: the draft stays a readable sentence and the
 * block behind it cannot be mistaken for something the user typed. With no
 * reference block the output is byte-identical to the two-argument form.
 */
export function composePrompt(
  text: string,
  attachments: readonly StagedAttachment[],
  referenceBlock?: string
): string {
  const parts: string[] = []
  if (text.length > 0) parts.push(text)
  if (attachments.length > 0) parts.push(buildAttachmentBlock(attachments))
  if (referenceBlock !== undefined && referenceBlock.trim().length > 0) parts.push(referenceBlock)
  if (parts.length === 0) return ''
  return parts.join('\n\n')
}
