import { IMAGE_ATTACHMENT_LIMITS, type ImageAttachment } from '../types'

/**
 * Composer attachments: staging, validation and prompt inlining.
 *
 * Text has no transport of its own — `PromptInput` carries no attachment field —
 * so text files are read here and inlined behind an explicit delimiter. Images
 * are different (ticket 11): the kernel accepts `prompt(text, { images })`, so a
 * screenshot can travel as pixels instead of as a filename the model cannot
 * open. They ride as their own field and are never inlined.
 *
 * Anything that cannot be sent is rejected with a visible reason instead of
 * quietly dropping it: an attachment that silently contributes nothing looks
 * exactly like one that worked.
 */

/** Files per message (text and images together). */
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
  kind: 'text' | 'image'
  /** Text attachments only: the file's contents. */
  text?: string
  /** Image attachments only: base64 payload, no `data:` prefix. */
  data?: string
  /** Image attachments only. */
  mimeType?: string
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
  if (file.size === 0) return 'empty file (nothing to send)'
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
    return 'media files cannot be attached'
  }
  // Images (ticket 11): the model reads pixels, so the type has to be one it is
  // actually handed — an unsupported image is named, never silently converted.
  if (file.type.startsWith('image/')) {
    if (!IMAGE_ATTACHMENT_LIMITS.allowedMimeTypes.includes(file.type as never)) {
      return `unsupported image type "${file.type}" (allowed: ${IMAGE_ATTACHMENT_LIMITS.allowedMimeTypes.join(', ')})`
    }
    if (file.size > IMAGE_ATTACHMENT_LIMITS.maxBytesPerImage) {
      return `too large (${formatBytes(file.size)}, limit ${formatBytes(IMAGE_ATTACHMENT_LIMITS.maxBytesPerImage)})`
    }
    return null
  }
  if (file.size > MAX_TEXT_BYTES) {
    return `too large (${formatBytes(file.size)}, limit ${formatBytes(MAX_TEXT_BYTES)})`
  }
  if (!isTextLike(file)) return 'only text files and images can be attached'
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

  // Text and images are tracked separately: 192 KB is a sane ceiling for text
  // pasted into a prompt and an absurd one for a screenshot.
  let textBytes = existing
    .filter((entry) => entry.kind === 'text')
    .reduce((sum, entry) => sum + entry.size, 0)
  let imageBytes = existing
    .filter((entry) => entry.kind === 'image')
    .reduce((sum, entry) => sum + entry.size, 0)
  let imageCount = existing.filter((entry) => entry.kind === 'image').length
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
    const isImage = file.type.startsWith('image/')
    if (isImage && imageCount >= IMAGE_ATTACHMENT_LIMITS.maxImages) {
      rejected.push({
        name: file.name,
        reason: `image limit is ${IMAGE_ATTACHMENT_LIMITS.maxImages} per message`
      })
      continue
    }
    if (isImage && imageBytes + file.size > IMAGE_ATTACHMENT_LIMITS.maxTotalBytes) {
      rejected.push({
        name: file.name,
        reason: `would exceed the ${formatBytes(IMAGE_ATTACHMENT_LIMITS.maxTotalBytes)} image limit per message`
      })
      continue
    }
    if (!isImage && textBytes + file.size > MAX_TOTAL_BYTES) {
      rejected.push({
        name: file.name,
        reason: `would exceed the ${formatBytes(MAX_TOTAL_BYTES)} per-message limit`
      })
      continue
    }

    if (isImage) {
      let data: string
      try {
        data = await readAsBase64(file)
      } catch {
        rejected.push({ name: file.name, reason: 'could not be read' })
        continue
      }
      accepted.push({
        id: makeId(file),
        name: file.name,
        size: file.size,
        kind: 'image',
        data,
        mimeType: file.type
      })
      imageBytes += file.size
      imageCount += 1
      count += 1
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
    accepted.push({ id: makeId(file), name: file.name, size: file.size, kind: 'text', text })
    textBytes += file.size
    count += 1
  }

  return { accepted, rejected }
}

/** Read a file as base64 without a `data:` prefix — what the kernel expects. */
async function readAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  // Chunked: spreading a 5 MB array into fromCharCode blows the call stack.
  const CHUNK = 0x8000
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/**
 * The images to ship alongside the prompt. Text attachments are inlined into
 * the text; images are not — a base64 blob in the prompt body would be read as
 * noise by the model and counted twice against the context.
 */
export function imagesOf(attachments: readonly StagedAttachment[]): ImageAttachment[] {
  return attachments
    .filter((entry) => entry.kind === 'image' && typeof entry.data === 'string')
    .map((entry) => ({
      data: entry.data as string,
      mimeType: entry.mimeType ?? 'image/png',
      ...(entry.name.length > 0 ? { name: entry.name } : {})
    }))
}

/**
 * Renders the staged files as one prompt suffix. Delimiters are plain ASCII so
 * the boundaries survive any markdown rendering the agent does.
 */
export function buildAttachmentBlock(attachments: readonly StagedAttachment[]): string {
  return attachments
    .filter((entry) => entry.kind === 'text' && typeof entry.text === 'string')
    .map((entry) => `--- ${entry.name} ---\n${(entry.text ?? '').trimEnd()}\n--- end ${entry.name} ---`)
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
  const inlined = buildAttachmentBlock(attachments)
  if (inlined.length > 0) parts.push(inlined)
  if (referenceBlock !== undefined && referenceBlock.trim().length > 0) parts.push(referenceBlock)
  if (parts.length === 0) return ''
  return parts.join('\n\n')
}
