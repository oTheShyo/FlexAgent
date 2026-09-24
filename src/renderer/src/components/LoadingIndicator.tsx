// Loading indicator adapted from lnkiai/m3e-canvas (MIT), Copyright (c) 2026 lnkiai.
// Shape morph model ports material-components-android via Aler1x/m3-loading-indicator (Apache-2.0).
import { useEffect, useMemo, useRef, useState } from 'react'
import { LoadingAnimator, morphedShape } from '../lib/shapes'

function useFrame(cb: (ts: number) => void, enabled: boolean) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    const loop = (ts: number) => {
      ref.current(ts)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [enabled])
}

function buildPathD(morph: number, scale: number): string {
  const pts = morphedShape(morph)
  let d = ''
  for (let i = 0; i < pts.length; i++) {
    d += (i === 0 ? 'M' : 'L') + (pts[i][0] * scale).toFixed(2) + ' ' + (pts[i][1] * scale).toFixed(2)
  }
  return d + 'Z'
}

export interface LoadingIndicatorProps {
  size?: number
  color?: string
  contained?: boolean
  containerColor?: string
  /** Announced with role="progressbar". */
  label?: string
  className?: string
}

/** M3 Expressive shape-morph loader (SoftBurst→…→Oval, 650ms spring + rotation). */
export function LoadingIndicator({
  size = 48,
  color = 'currentColor',
  contained = false,
  containerColor,
  label = 'Loading',
  className
}: LoadingIndicatorProps): React.ReactElement {
  const pathRef = useRef<SVGPathElement>(null)
  const anim = useRef<LoadingAnimator | null>(null)
  if (!anim.current) anim.current = new LoadingAnimator()

  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReducedMotion(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const scale = (size * 0.79) / 2
  const c = size / 2

  const staticD = useMemo(() => buildPathD(0, scale), [scale])
  const staticTransform = `translate(${c} ${c})`

  useFrame(
    ts => {
      const a = anim.current
      const el = pathRef.current
      if (!a || !el) return
      a.update(ts)
      const pts = morphedShape(a.morph)
      let d = ''
      for (let i = 0; i < pts.length; i++) {
        d += (i === 0 ? 'M' : 'L') + (pts[i][0] * scale).toFixed(2) + ' ' + (pts[i][1] * scale).toFixed(2)
      }
      el.setAttribute('d', d + 'Z')
      el.setAttribute('transform', `translate(${c} ${c}) rotate(${a.rotation.toFixed(2)})`)
    },
    !reducedMotion
  )

  useEffect(() => {
    if (!reducedMotion) return
    const el = pathRef.current
    if (!el) return
    el.setAttribute('d', staticD)
    el.setAttribute('transform', staticTransform)
  }, [reducedMotion, staticD, staticTransform])

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      style={{ display: 'block' }}
      role="progressbar"
      aria-label={label}
      aria-busy="true"
    >
      {contained && <circle cx={c} cy={c} r={c} fill={containerColor ?? 'rgba(0,0,0,0.08)'} />}
      <path ref={pathRef} d={staticD} transform={staticTransform} fill={color} />
    </svg>
  )
}

export default LoadingIndicator
