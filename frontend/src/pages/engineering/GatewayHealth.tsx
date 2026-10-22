import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts'
import { getProviderHealth } from '../../api/endpoints'
import Badge, { type Tone } from '../../components/Badge'

const circuitTone: Record<string, Tone> = { closed: 'green', 'half-open': 'amber', open: 'red' }
const circuitLabel: Record<string, string> = {
  closed: 'Healthy (closed)',
  'half-open': 'Recovering (half-open)',
  open: 'Tripped (open)',
}

export default function GatewayHealth() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['provider-health'],
    queryFn: getProviderHealth,
    refetchInterval: 15000,
  })

  if (isLoading) return <p className="text-slate-500">Loading...</p>
  if (isError || !data) return <p className="text-red-600">Failed to load data.</p>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Gateway Latency & Circuit Status</h1>
        <p className="text-sm text-slate-500">Refreshes every 15 seconds</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.map((p) => (
          <div key={p.provider} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-medium text-slate-900">{p.provider}</h2>
            </div>
            <div className="mt-2">
              <Badge tone={circuitTone[p.circuit]}>{circuitLabel[p.circuit]}</Badge>
            </div>
            <dl className="mt-4 space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">p50</dt><dd>{p.p50Ms} ms</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">p95</dt><dd>{p.p95Ms} ms</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Error rate</dt><dd>{p.errorRate}%</dd></div>
            </dl>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-medium text-slate-600">Latency by provider (ms)</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="provider" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="p50Ms" name="p50" fill="#10b981" />
              <Bar dataKey="p95Ms" name="p95" fill="#6ee7b7" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}