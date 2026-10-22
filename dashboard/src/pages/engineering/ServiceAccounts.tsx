import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { getServiceAccounts } from '../../api/endpoints'
import Badge from '../../components/Badge'

export default function ServiceAccounts() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['service-accounts'], queryFn: getServiceAccounts })

  if (isLoading) return <p className="text-slate-500">Loading...</p>
  if (isError || !data) return <p className="text-red-600">Failed to load data.</p>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">K8s ServiceAccount Analytics</h1>
        <p className="text-sm text-slate-500">Usage and cost per Kubernetes ServiceAccount</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-medium text-slate-600">Cost by service account</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
              <Bar dataKey="cost" fill="#10b981" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">ServiceAccount</th>
              <th className="px-4 py-3 font-medium">Namespace</th>
              <th className="px-4 py-3 text-right font-medium">Requests</th>
              <th className="px-4 py-3 text-right font-medium">Tokens</th>
              <th className="px-4 py-3 text-right font-medium">Cost</th>
              <th className="px-4 py-3 text-right font-medium">Error rate</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.name} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-medium text-slate-900">{s.name}</td>
                <td className="px-4 py-3"><Badge>{s.namespace}</Badge></td>
                <td className="px-4 py-3 text-right">{s.requests.toLocaleString()}</td>
                <td className="px-4 py-3 text-right">{(s.tokens / 1_000_000).toFixed(1)}M</td>
                <td className="px-4 py-3 text-right">${s.cost.toFixed(2)}</td>
                <td className="px-4 py-3 text-right">
                  <Badge tone={s.errorRate > 2 ? 'red' : s.errorRate > 1 ? 'amber' : 'green'}>
                    {`${s.errorRate}%`}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}