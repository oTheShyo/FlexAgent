// Loading indicator adapted from lnkiai/m3e-canvas (MIT), Copyright (c) 2026 lnkiai.
// Shape morph model ports material-components-android via Aler1x/m3-loading-indicator (Apache-2.0).
import { useEffect, useRef } from 'react'
import { LoadingAnimator, morphedShape } from '../lib/shapes'

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

  const scale = (size * 0.79) / 2
  const c = size / 2

  useFrame(ts => {
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
  })

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
      <path ref={pathRef} fill={color} />
    </svg>
  )
}

export default LoadingIndicator
