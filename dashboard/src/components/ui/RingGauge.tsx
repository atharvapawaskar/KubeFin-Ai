import { useId } from 'react'

interface Props {
  value: number // 0-100 (values above 100 are drawn as full)
  size?: number
  stroke?: number
  label?: string
  sub?: string
}

export default function RingGauge({ value, size = 96, stroke = 10, label, sub }: Props) {
  const id = useId().replace(/:/g, '')
  const pct = Math.max(0, Math.min(value, 100))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const [from, to] =
    value >= 90 ? ['#fb7185', '#f43f5e'] : value >= 70 ? ['#fbbf24', '#f59e0b'] : ['#38bdf8', '#34d399']

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={`r${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#r${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset 1s ease' }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-bold text-slate-800" style={{ fontSize: size * 0.22 }}>
          {label ?? `${Math.round(value)}%`}
        </div>
        {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
      </div>
    </div>
  )
}