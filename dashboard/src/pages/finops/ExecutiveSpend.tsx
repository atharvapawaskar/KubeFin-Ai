import { useQuery } from '@tanstack/react-query'
import { DollarSign, Activity, Cpu, Calculator } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { getSpendSeries, getTokenBilling } from '../../api/endpoints'
import KpiCard from '../../components/KpiCard'

export default function ExecutiveSpend() {
  const spend = useQuery({ queryKey: ['spend-series'], queryFn: getSpendSeries })
  const billing = useQuery({ queryKey: ['token-billing'], queryFn: getTokenBilling })

  if (spend.isLoading || billing.isLoading) return <p className="text-slate-500">Loading...</p>
  if (!spend.data || !billing.data) return <p className="text-red-600">Failed to load data.</p>

  const totalCost = spend.data.reduce((s, p) => s + p.cost, 0)
  const totalRequests = spend.data.reduce((s, p) => s + p.requests, 0)
  const totalTokens = spend.data.reduce((s, p) => s + p.tokens, 0)

  const tokenChart = billing.data.map((b) => ({
    provider: b.provider,
    Input: b.inputTokens / 1_000_000,
    Output: b.outputTokens / 1_000_000,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Executive Spend & Token Billing</h1>
        <p className="text-sm text-slate-500">Company-wide AI spend for the last 14 days</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total Spend" value={`$${totalCost.toFixed(2)}`} icon={<DollarSign size={18} />} hint="Last 14 days" />
        <KpiCard label="Requests" value={totalRequests.toLocaleString()} icon={<Activity size={18} />} />
        <KpiCard label="Tokens" value={`${(totalTokens / 1_000_000).toFixed(1)}M`} icon={<Cpu size={18} />} />
        <KpiCard label="Cost / Request" value={`$${(totalCost / totalRequests).toFixed(4)}`} icon={<Calculator size={18} />} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-medium text-slate-600">Spend over time</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spend.data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="timestamp" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
              <Area type="monotone" dataKey="cost" stroke="#4f46e5" fill="#c7d2fe" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-medium text-slate-600">Tokens by provider (millions)</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tokenChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="provider" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => `${Number(v).toFixed(1)}M`} />
                <Legend />
                <Bar dataKey="Input" fill="#6366f1" />
                <Bar dataKey="Output" fill="#a5b4fc" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-medium text-slate-600">Billing by provider</h2>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="py-2 font-medium">Provider</th>
                <th className="py-2 text-right font-medium">Input</th>
                <th className="py-2 text-right font-medium">Output</th>
                <th className="py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {billing.data.map((b) => (
                <tr key={b.provider} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 font-medium text-slate-900">{b.provider}</td>
                  <td className="py-2.5 text-right">{(b.inputTokens / 1_000_000).toFixed(1)}M</td>
                  <td className="py-2.5 text-right">{(b.outputTokens / 1_000_000).toFixed(1)}M</td>
                  <td className="py-2.5 text-right">${b.cost.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}