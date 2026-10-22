import { useId } from 'react'
import { brand } from '../brand'

const CENTER = '32,32'
const POINTS = ['32,4', '56.25,18', '56.25,46', '32,60', '7.75,46', '7.75,18']
const FACET_OPACITY = [0.95, 0.55, 0.8, 0.45, 0.7, 0.9]
const HEX = 'M32 4 L56.25 18 L56.25 46 L32 60 L7.75 46 L7.75 18 Z'

export function LogoMark({ size = 40, animated = false }: { size?: number; animated?: boolean }) {
  const id = useId().replace(/:/g, '')
  const grad = `url(#g${id})`

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#38bdf8" />
          <stop offset="0.5" stopColor="#818cf8" />
          <stop offset="1" stopColor="#f0abfc" />
        </linearGradient>
      </defs>

      {POINTS.map((p, i) => (
        <polygon
          key={p}
          points={`${CENTER} ${p} ${POINTS[(i + 1) % POINTS.length]}`}
          fill={grad}
          fillOpacity={FACET_OPACITY[i]}
          stroke="#fff"
          strokeOpacity="0.85"
          strokeWidth="1"
          strokeLinejoin="round"
          className={animated ? 'kf-facet' : undefined}
          style={animated ? { animationDelay: `${0.5 + i * 0.12}s` } : undefined}
        />
      ))}

      <path
        d={HEX}
        pathLength={1}
        stroke="#fff"
        strokeOpacity="0.95"
        strokeWidth="2"
        strokeLinejoin="round"
        className={animated ? 'kf-draw' : undefined}
      />

      <path
        d="M20 15 L21.5 18.5 L25 20 L21.5 21.5 L20 25 L18.5 21.5 L15 20 L18.5 18.5 Z"
        fill="#fff"
        fillOpacity="0.9"
        className={animated ? 'kf-facet' : undefined}
        style={animated ? { animationDelay: '1.4s' } : undefined}
      />
    </svg>
  )
}

interface Props {
  size?: number
  tone?: 'light' | 'dark' // kept so older code still compiles; the theme is light everywhere now
  className?: string
}

export default function Logo({ size = 36, className = '' }: Props) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      <span className="font-bold tracking-tight text-slate-800" style={{ fontSize: size * 0.55 }}>
        {brand.name} <span className="text-gradient">{brand.suffix}</span>
      </span>
    </span>
  )
}