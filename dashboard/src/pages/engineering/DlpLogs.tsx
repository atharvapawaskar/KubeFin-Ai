import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDlpLogs } from '../../api/endpoints'
import Badge from '../../components/Badge'

export default function DlpLogs() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['dlp-logs'], queryFn: getDlpLogs })
  const [type, setType] = useState('All')
  const [action, setAction] = useState('All')

  const types = useMemo(() => ['All', ...Array.from(new Set((data ?? []).map((l) => l.type)))], [data])

  const rows = (data ?? []).filter(
    (l) => (type === 'All' || l.type === type) && (action === 'All' || l.action === action),
  )

  if (isLoading) return <p className="text-slate-500">Loading...</p>
  if (isError || !data) return <p className="text-red-600">Failed to load data.</p>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">PII / DLP Intercepted Logs</h1>
        <p className="text-sm text-slate-500">Sensitive data caught by the gateway before reaching a provider</p>
      </div>

      <div className="flex gap-3">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
        >
          {types.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
        >
          <option>All</option>
          <option>redacted</option>
          <option>blocked</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">ServiceAccount</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Snippet (sanitized)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{l.timestamp}</td>
                <td className="px-4 py-3 font-medium text-slate-900">{l.serviceAccount}</td>
                <td className="px-4 py-3">{l.type}</td>
                <td className="px-4 py-3">
                  <Badge tone={l.action === 'blocked' ? 'red' : 'amber'}>{l.action}</Badge>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{l.snippet}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">No logs match these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}