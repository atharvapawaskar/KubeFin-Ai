import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getCapPolicies } from '../../api/endpoints'
import Badge from '../../components/Badge'

export default function CapPolicies() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['cap-policies'], queryFn: getCapPolicies })
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  if (isLoading) return <p className="text-slate-500">Loading...</p>
  if (isError || !data) return <p className="text-red-600">Failed to load data.</p>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Hard / Soft Cap Policies</h1>
        <p className="text-sm text-slate-500">
          Soft caps warn; hard caps enforce. Toggles here are local until the API is connected.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">Scope</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 text-right font-medium">Threshold</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {data.map((p) => {
              const on = overrides[p.id] ?? p.enabled
              return (
                <tr key={p.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-slate-900">{p.scope}</td>
                  <td className="px-4 py-3">
                    <Badge tone={p.type === 'hard' ? 'red' : 'amber'}>{p.type === 'hard' ? 'Hard cap' : 'Soft cap'}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">{p.thresholdPct}%</td>
                  <td className="px-4 py-3 text-slate-600">{p.action}</td>
                  <td className="px-4 py-3">
                    <button
                      aria-label={`Toggle policy for ${p.scope}`}
                      onClick={() => setOverrides({ ...overrides, [p.id]: !on })}
                      className={`relative h-6 w-11 rounded-full transition ${on ? 'bg-indigo-600' : 'bg-slate-300'}`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-5' : 'left-0.5'}`}
                      />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}