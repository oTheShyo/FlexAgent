/**
 * Image attachment validation (ticket 11) — main-process side.
 *
 * The renderer enforces the same caps before it ever sends, but a renderer is
 * not a boundary: this is the copy that actually decides, so a hand-built IPC
 * call cannot push an unbounded buffer into the kernel.
 *
 * Two properties matter more than the numbers:
 *  - **Every rejection is named.** A silent crop, or a drop, would leave the
 *    user believing the model saw something it never received.
 *  - **The wire payload is validated, not just declared.** A `mimeType` is a
 *    claim; the base64 is what gets handed to the provider.
 */
import { IMAGE_ATTACHMENT_LIMITS, type ImageAttachment } from '../shared/contract'

export interface ImageRejection {
  name: string
  reason: string
}

export interface ImageValidation {
  accepted: ImageAttachment[]
  rejected: ImageRejection[]
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u

/** Decoded byte length of a base64 payload, without allocating the buffer. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/**
 * Validates the images on a prompt. Unknown values are rejected rather than
 * coerced: a `data:` prefix or a stray mime type means the caller built the
 * payload by hand, and guessing what it meant is how a bad payload arrives
 * looking like a good one.
 */
export function validateImages(images: readonly unknown[]): ImageValidation {
  const accepted: ImageAttachment[] = []
  const rejected: ImageRejection[] = []
  let totalBytes = 0

  for (const raw of images) {
    const name =
      raw !== null && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
        ? (raw as { name: string }).name
        : 'image'

    if (raw === null || typeof raw !== 'object') {
      rejected.push({ name, reason: 'not an image attachment' })
      continue
    }
    const candidate = raw as { data?: unknown; mimeType?: unknown }
    if (typeof candidate.data !== 'string' || candidate.data.length === 0) {
      rejected.push({ name, reason: 'empty image payload' })
      continue
    }
    if (candidate.data.startsWith('data:')) {
      rejected.push({ name, reason: 'payload must be base64 without a data: prefix' })
      continue
    }
    if (typeof candidate.mimeType !== 'string') {
      rejected.push({ name, reason: 'mimeType is required' })
      continue
    }
    if (!IMAGE_ATTACHMENT_LIMITS.allowedMimeTypes.includes(candidate.mimeType as never)) {
      rejected.push({
        name,
        reason: `unsupported image type "${candidate.mimeType}" (allowed: ${IMAGE_ATTACHMENT_LIMITS.allowedMimeTypes.join(', ')})`
      })
      continue
    }
    if (!BASE64.test(candidate.data)) {
      rejected.push({ name, reason: 'payload is not valid base64' })
      continue
    }
    if (accepted.length >= IMAGE_ATTACHMENT_LIMITS.maxImages) {
      rejected.push({ name, reason: `image limit is ${IMAGE_ATTACHMENT_LIMITS.maxImages}` })
      continue
    }
    const bytes = base64ByteLength(candidate.data)
    if (bytes > IMAGE_ATTACHMENT_LIMITS.maxBytesPerImage) {
      rejected.push({
        name,
        reason: `too large (${formatBytes(bytes)}, limit ${formatBytes(IMAGE_ATTACHMENT_LIMITS.maxBytesPerImage)})`
      })
      continue
    }
    if (totalBytes + bytes > IMAGE_ATTACHMENT_LIMITS.maxTotalBytes) {
      rejected.push({
        name,
        reason: `would exceed the ${formatBytes(IMAGE_ATTACHMENT_LIMITS.maxTotalBytes)} per-message limit`
      })
      continue
    }
    totalBytes += bytes
    accepted.push({
      data: candidate.data,
      mimeType: candidate.mimeType,
      ...(name !== 'image' ? { name } : {})
    })
  }

  return { accepted, rejected }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
