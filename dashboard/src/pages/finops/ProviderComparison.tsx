import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { getProviderCosts } from '../../api/endpoints'
import Badge from '../../components/Badge'

// Blended price per 1M tokens, assuming 3 input tokens for every 1 output token.
const blended = (input: number, output: number) => (input * 3 + output) / 4

export default function ProviderComparison() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['provider-costs'], queryFn: getProviderCosts })

  if (isLoading) return <p className="text-slate-500">Loading...</p>
  if (isError || !data) return <p className="text-red-600">Failed to load data.</p>

  const rows = data
    .map((r) => ({ ...r, blended: blended(r.inputPer1M, r.outputPer1M) }))
    .sort((a, b) => a.blended - b.blended)
  const cheapest = rows[0].model

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Multi-Provider Cost Comparison</h1>
        <p className="text-sm text-slate-500">Blended cost per 1M tokens, assuming a 3:1 input to output ratio</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
              <YAxis type="category" dataKey="model" tick={{ fontSize: 12 }} width={120} />
              <Tooltip formatter={(v) => `$${Number(v).toFixed(2)} / 1M`} />
              <Bar dataKey="blended" fill="#6366f1" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">Provider</th>
              <th className="px-4 py-3 text-right font-medium">Input / 1M</th>
              <th className="px-4 py-3 text-right font-medium">Output / 1M</th>
              <th className="px-4 py-3 text-right font-medium">Blended / 1M</th>
              <th className="px-4 py-3 text-right font-medium">Avg latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-medium text-slate-900">
                  {r.model} {r.model === cheapest && <Badge tone="green">Cheapest</Badge>}
                </td>
                <td className="px-4 py-3 text-slate-600">{r.provider}</td>
                <td className="px-4 py-3 text-right">${r.inputPer1M.toFixed(2)}</td>
                <td className="px-4 py-3 text-right">${r.outputPer1M.toFixed(2)}</td>
                <td className="px-4 py-3 text-right font-medium">${r.blended.toFixed(2)}</td>
                <td className="px-4 py-3 text-right">{r.avgLatencyMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}