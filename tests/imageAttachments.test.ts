import { describe, expect, it } from 'vitest'
import { base64ByteLength, validateImages } from '../src/main/imageAttachments'
import { IMAGE_ATTACHMENT_LIMITS } from '../src/shared/contract'

/** A payload of `bytes` bytes, encoded the way the renderer encodes it. */
function payload(bytes: number): string {
  return Buffer.alloc(bytes, 1).toString('base64')
}

function image(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { data: payload(1024), mimeType: 'image/png', name: 'shot.png', ...overrides }
}

describe('base64ByteLength', () => {
  it('counts decoded bytes, not characters', () => {
    expect(base64ByteLength(payload(300))).toBe(300)
    expect(base64ByteLength('')).toBe(0)
  })

  it('accounts for padding', () => {
    // 1 byte -> "AQ==", 2 bytes -> "AQI="
    expect(base64ByteLength('AQ==')).toBe(1)
    expect(base64ByteLength('AQI=')).toBe(2)
  })
})

describe('validateImages', () => {
  it('accepts a supported image', () => {
    const { accepted, rejected } = validateImages([image()])
    expect(accepted.length).toBe(1)
    expect(accepted[0]?.mimeType).toBe('image/png')
    expect(rejected.length).toBe(0)
  })

  it('rejects a data: URL — the kernel wants bare base64', () => {
    const { accepted, rejected } = validateImages([
      image({ data: `data:image/png;base64,${payload(64)}` })
    ])
    expect(accepted.length).toBe(0)
    expect(rejected[0]?.reason).toContain('data: prefix')
  })

  it('rejects an unsupported type by name rather than silently dropping it', () => {
    const { rejected } = validateImages([image({ mimeType: 'image/bmp' })])
    expect(rejected[0]?.reason).toContain('image/bmp')
    expect(rejected[0]?.reason).toContain('image/png')
  })

  it('rejects a payload that is not base64', () => {
    const { rejected } = validateImages([image({ data: 'not base64!!' })])
    expect(rejected[0]?.reason).toContain('base64')
  })

  it('caps the number of images per message', () => {
    const many = Array.from({ length: IMAGE_ATTACHMENT_LIMITS.maxImages + 1 }, () => image())
    const { accepted, rejected } = validateImages(many)
    expect(accepted.length).toBe(IMAGE_ATTACHMENT_LIMITS.maxImages)
    expect(rejected.length).toBe(1)
    expect(rejected[0]?.reason).toContain('image limit')
  })

  it('caps a single image by size', () => {
    const { rejected } = validateImages([
      image({ data: payload(IMAGE_ATTACHMENT_LIMITS.maxBytesPerImage + 1024) })
    ])
    expect(rejected[0]?.reason).toContain('too large')
  })

  it('caps the combined size of one message', () => {
    // Two at the per-image cap fit (10 MB of 12 MB); the third cannot.
    const each = IMAGE_ATTACHMENT_LIMITS.maxBytesPerImage
    const { accepted, rejected } = validateImages([
      image({ data: payload(each) }),
      image({ data: payload(each) }),
      image({ data: payload(each) })
    ])
    expect(accepted.length).toBe(2)
    expect(rejected[0]?.reason).toContain('per-message limit')
  })

  it('the combined cap is reachable — it is not maxImages × per-image', () => {
    // A cap no input can reach is not a cap, it is a comment.
    expect(IMAGE_ATTACHMENT_LIMITS.maxTotalBytes).toBeLessThan(
      IMAGE_ATTACHMENT_LIMITS.maxImages * IMAGE_ATTACHMENT_LIMITS.maxBytesPerImage
    )
  })

  it('rejects non-objects instead of throwing', () => {
    const { accepted, rejected } = validateImages([null, 'image', 42])
    expect(accepted.length).toBe(0)
    expect(rejected.length).toBe(3)
  })

  it('an empty list is not an error', () => {
    expect(validateImages([])).toEqual({ accepted: [], rejected: [] })
  })
})
