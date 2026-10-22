import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { getTeamBudgets } from '../../api/endpoints'

function barColor(pct: number) {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 70) return 'bg-amber-500'
  return 'bg-emerald-500'
}

export default function TeamBudgets() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['team-budgets'], queryFn: getTeamBudgets })

  if (isLoading) return <p className="text-slate-500">Loading...</p>
  if (isError || !data) return <p className="text-red-600">Failed to load data.</p>

  const now = new Date()
  const day = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

  const totalLimit = data.reduce((s, b) => s + b.limit, 0)
  const totalUsed = data.reduce((s, b) => s + b.used, 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Tenant & Team Sub-Budgets</h1>
        <p className="text-sm text-slate-500">
          ${totalUsed.toLocaleString()} used of ${totalLimit.toLocaleString()} allocated this month
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {data.map((b) => {
          const pct = (b.used / b.limit) * 100
          const projected = (b.used / day) * daysInMonth
          const willExceed = projected > b.limit

          return (
            <div key={b.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-medium text-slate-900">{b.team}</h2>
                <span className="text-sm font-semibold text-slate-700">{pct.toFixed(0)}%</span>
              </div>

              <div className="relative mt-3 h-2.5 w-full rounded-full bg-slate-100">
                <div className={`h-2.5 rounded-full ${barColor(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                <div
                  className="absolute -top-0.5 h-3.5 w-0.5 bg-slate-600"
                  style={{ left: `${b.softCapPct}%` }}
                  title={`Soft cap at ${b.softCapPct}%`}
                />
              </div>

              <div className="mt-3 flex justify-between text-sm text-slate-500">
                <span>${b.used.toLocaleString()} used</span>
                <span>limit ${b.limit.toLocaleString()}</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">Soft cap marker at {b.softCapPct}%</p>

              <p className={`mt-3 flex items-center gap-1.5 text-xs ${willExceed ? 'text-red-600' : 'text-slate-400'}`}>
                {willExceed && <AlertTriangle size={14} />}
                Projected month-end: ${projected.toFixed(0)}
                {willExceed ? ' (will exceed budget)' : ''}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}