// Wavy progress adapted from lnkiai/m3e-canvas (MIT), Copyright (c) 2026 lnkiai.
import { useEffect, useRef } from 'react'

/** Cubic bezier easing (same parametrisation as CSS / Compose CubicBezierEasing). */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const ax = 3 * x1 - 3 * x2 + 1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 3 * y1 - 3 * y2 + 1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t
  const sy = (t: number) => ((ay * t + by) * t + cy) * t
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    let t = x
    for (let i = 0; i < 24; i++) {
      const v = sx(t)
      if (Math.abs(v - x) < 1e-4) break
      if (v < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return sy(t)
  }
}

const seg = (t: number, from: number, to: number, ease: (x: number) => number) =>
  ease(Math.min(1, Math.max(0, (t - from) / (to - from))))

function useFrame(cb: (ts: number) => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    let raf = 0
    const loop = (ts: number) => {
      ref.current(ts)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
}

const LINEAR_CYCLE = 1800
const l1Head = bezier(0.2, 0, 0.8, 1)
const l1Tail = bezier(0.4, 0, 1, 1)
const l2Head = bezier(0, 0, 0.65, 1)
const l2Tail = bezier(0.1, 0, 0.45, 1)

const TRACK_GAP = 4
const LINEAR_WAVELENGTH = 40
const LINEAR_AMPLITUDE = 3
const WAVE_SPEED = 40 // px per second

export function wavePath(
  x0: number,
  x1: number,
  mid: number,
  amp: number,
  phase: number,
  wl: number
) {
  if (x1 - x0 < 0.5) return ''
  const step = amp > 0 ? 2 : Math.max(2, x1 - x0)
  let d = ''
  for (let x = x0; ; x += step) {
    const xx = Math.min(x, x1)
    const y = mid + amp * Math.sin((2 * Math.PI * xx) / wl + phase)
    d += (d ? 'L' : 'M') + xx.toFixed(2) + ' ' + y.toFixed(2)
    if (xx >= x1) break
  }
  return d
}

export interface WavyProgressProps {
  /** 0..1, undefined = indeterminate. */
  value?: number
  color?: string
  trackColor?: string
  width?: number
  height?: number
  /** Announced with role="progressbar". */
  label?: string
}

/**
 * Self-contained wavy linear progress: React + SVG + requestAnimationFrame,
 * zero dependencies. Unmounting cancels the rAF loop.
 */
export function WavyProgress({
  value,
  color = '#18181b',
  trackColor = '#e4e4e7',
  width = 96,
  height = 12,
  label = 'Loading'
}: WavyProgressProps) {
  // Fit track thickness + wave amplitude into the requested height:
  // height >= trackThickness + amplitude * 2 + 2 (1px breathing each side).
  const room = Math.max(1, height - 2)
  let trackThickness = Math.min(4, Math.max(1, room))
  let amplitude = Math.min(LINEAR_AMPLITUDE, Math.floor((room - trackThickness) / 2))
  if (amplitude < 1 && room >= 3 && trackThickness > 2) {
    trackThickness = 2
    amplitude = Math.min(LINEAR_AMPLITUDE, Math.floor((room - trackThickness) / 2))
  }

  const mid = height / 2
  const inset = trackThickness / 2
  const w = width - trackThickness
  // Preserve the original 4dp gaps; any other thickness accounts for both round caps.
  const gapInset = trackThickness === 4 ? trackThickness / 2 : trackThickness
  // The stop indicator is as tall as the track, as Material draws it.
  const stop = trackThickness
  const activeRef = useRef<SVGPathElement>(null)
  const active2Ref = useRef<SVGPathElement>(null)
  const trackRef = useRef<SVGPathElement>(null)
  const start = useRef<number>(0)

  useFrame((ts) => {
    if (!start.current) start.current = ts
    const ms = ts - start.current
    const wavyAmp = amplitude
    const phase = wavyAmp > 0 ? (-(ms / 1000) * WAVE_SPEED * 2 * Math.PI) / LINEAR_WAVELENGTH : 0
    const a = activeRef.current
    const b = active2Ref.current
    const t = trackRef.current
    if (!a || !b || !t) return

    if (value !== undefined) {
      const v = Math.min(1, Math.max(0, value))
      const amp = v < 0.1 || v > 0.95 ? 0 : wavyAmp
      const end = inset + w * v
      a.setAttribute('d', wavePath(inset, end, mid, amp, phase, LINEAR_WAVELENGTH))
      b.setAttribute('d', '')
      // a stub of track always remains under the stop indicator
      const trackStart = Math.min(inset + w - stop, end + TRACK_GAP + gapInset)
      t.setAttribute('d', wavePath(v <= 0 ? inset : trackStart, inset + w, mid, 0, 0, 1))
      return
    }

    const c = ms % LINEAR_CYCLE
    const h1 = seg(c, 0, 750, l1Head)
    const t1 = seg(c, 333, 1183, l1Tail)
    const h2 = seg(c, 1000, 1567, l2Head)
    const t2 = seg(c, 1267, 1800, l2Tail)
    const s1 = [inset + w * t1, inset + w * h1]
    const s2 = [inset + w * t2, inset + w * h2]
    a.setAttribute('d', wavePath(s1[0], s1[1], mid, wavyAmp, phase, LINEAR_WAVELENGTH))
    b.setAttribute('d', wavePath(s2[0], s2[1], mid, wavyAmp, phase, LINEAR_WAVELENGTH))

    const segs = [s1, s2]
      .filter((s) => s[1] - s[0] > 0.5)
      .sort((p, q) => p[0] - q[0])
    let cursor = inset
    let d = ''
    for (const s of segs) {
      const to = s[0] - TRACK_GAP - gapInset
      if (to - cursor > 0.5) d += wavePath(cursor, to, mid, 0, 0, 1)
      cursor = Math.max(cursor, s[1] + TRACK_GAP + gapInset)
    }
    if (inset + w - cursor > 0.5) d += wavePath(cursor, inset + w, mid, 0, 0, 1)
    t.setAttribute('d', d)
  })

  const stroke = {
    fill: 'none',
    strokeWidth: trackThickness,
    strokeLinecap: 'round' as const
  }
  const progressbarProps =
    value !== undefined
      ? {
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(Math.min(1, Math.max(0, value)) * 100)
        }
      : {}

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block' }}
      role="progressbar"
      aria-label={label}
      {...progressbarProps}
    >
      <path ref={trackRef} stroke={trackColor} {...stroke} />
      <path ref={activeRef} stroke={color} {...stroke} />
      <path ref={active2Ref} stroke={color} {...stroke} />
      {value !== undefined && (
        <circle cx={width - inset - stop / 2} cy={mid} r={stop / 2} fill={color} />
      )}
    </svg>
  )
}

export default WavyProgress
