import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Copy } from 'lucide-react'
import { getApiKeys } from '../../api/endpoints'
import Badge from '../../components/Badge'
import type { ApiKey } from '../../types/api'

export default function ApiKeys() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['api-keys'], queryFn: getApiKeys })
  const [created, setCreated] = useState<ApiKey[]>([])
  const [revoked, setRevoked] = useState<string[]>([])
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')

  if (isLoading) return <p className="text-slate-500">Loading...</p>
  if (isError || !data) return <p className="text-red-600">Failed to load data.</p>

  const keys = [...created, ...data].map((k) =>
    revoked.includes(k.id) ? { ...k, status: 'revoked' as const } : k,
  )

  // Mock only: in the real app the control plane API generates the key and returns it once.
  function createKey() {
    if (!name.trim()) return
    const full = `kf_live_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    setCreated([
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        prefix: full.slice(0, 12),
        createdAt: new Date().toISOString().slice(0, 10),
        lastUsed: 'never',
        status: 'active',
      },
      ...created,
    ])
    setSecret(full)
    setName('')
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">API Keys & Secret Management</h1>
        <p className="text-sm text-slate-500">Create and revoke keys for your services</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name, e.g. checkout-prod"
          className="w-72 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
        <button
          onClick={createKey}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Create key
        </button>
      </div>

      {secret && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-800">Copy this key now. It will not be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded bg-white px-3 py-1.5 text-sm text-slate-800">{secret}</code>
            <button
              onClick={() => navigator.clipboard.writeText(secret)}
              className="flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100"
            >
              <Copy size={14} /> Copy
            </button>
            <button onClick={() => setSecret('')} className="text-sm text-amber-700 underline">
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Key</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium">Last used</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-medium text-slate-900">{k.name}</td>
                <td className="px-4 py-3 font-mono text-slate-600">{k.prefix}...</td>
                <td className="px-4 py-3 text-slate-600">{k.createdAt}</td>
                <td className="px-4 py-3 text-slate-600">{k.lastUsed}</td>
                <td className="px-4 py-3">
                  <Badge tone={k.status === 'active' ? 'green' : 'slate'}>{k.status}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  {k.status === 'active' && (
                    <button
                      onClick={() => setRevoked([...revoked, k.id])}
                      className="text-sm text-red-600 hover:underline"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}