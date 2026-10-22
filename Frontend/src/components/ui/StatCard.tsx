import { useId, type ReactNode } from 'react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

const tones = {
  indigo: { color: '#6366f1', chip: 'bg-indigo-300/30 text-indigo-600' },
  emerald: { color: '#10b981', chip: 'bg-emerald-300/30 text-emerald-600' },
  pink: { color: '#ec4899', chip: 'bg-pink-300/30 text-pink-600' },
  sky: { color: '#0ea5e9', chip: 'bg-sky-300/30 text-sky-600' },
}

interface Props {
  label: string
  value: string
  icon: ReactNode
  tone?: keyof typeof tones
  spark?: number[]
  delta?: number // percent change
  goodWhenDown?: boolean // true for costs and error rates
  hint?: string
  children?: ReactNode
}

export default function StatCard({
  label, value, icon, tone = 'indigo', spark, delta, goodWhenDown = false, hint, children,
}: Props) {
  const id = useId().replace(/:/g, '')
  const t = tones[tone]
  const good = delta === undefined ? true : goodWhenDown ? delta <= 0 : delta >= 0

  return (
    <div className="glass glass-lift rounded-3xl p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-600">{label}</span>
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl border border-white/80 ${t.chip}`}>
          {icon}
        </span>
      </div>

      <div className="mt-3 flex items-end gap-2">
        <p className="text-3xl font-bold tracking-tight text-slate-800">{value}</p>
        {delta !== undefined && (
          <span
            className={`mb-1 inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
              good ? 'bg-emerald-100/70 text-emerald-700' : 'bg-rose-100/70 text-rose-700'
            }`}
          >
            {delta >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}

      {spark && (
        <div className="mt-3 h-12">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark.map((v) => ({ v }))} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`s${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={t.color} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={t.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={t.color}
                strokeWidth={2}
                fill={`url(#s${id})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      {children}
    </div>
  )
}