import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Activity, AlertTriangle, KeyRound, Plus, RefreshCw, ScanEye, Server, Timer } from 'lucide-react'
import { getApiKeys, getDlpLogs, getProviderHealth, getServiceAccounts } from '../../api/endpoints'
import { getDlpByType, getHourlyTraffic } from '../../api/dashboardApi'
import { useAuth } from '../../auth/AuthContext'
import { axisTick, gridStroke, tooltipStyle } from '../../lib/chartTheme'
import { compact, greeting, money } from '../../lib/format'
import Badge from '../../components/Badge'
import Donut from '../../components/ui/Donut'
import GlassCard from '../../components/ui/GlassCard'
import PageHeader from '../../components/ui/PageHeader'
import Segmented from '../../components/ui/Segmented'
import StatCard from '../../components/ui/StatCard'

const PALETTE = ['#34d399', '#38bdf8', '#818cf8', '#f472b6', '#fbbf24']

type Metric = 'cost' | 'requests'
const metricOptions: { value: Metric; label: string }[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'requests', label: 'Requests' },
]

const circuitStyle = {
  closed: { dot: 'bg-emerald-500', ping: '', label: 'Healthy', tone: 'green' },
  'half-open': { dot: 'bg-amber-500', ping: '', label: 'Recovering', tone: 'amber' },
  open: { dot: 'bg-rose-500', ping: 'bg-rose-400', label: 'Tripped', tone: 'red' },
} as const

export default function EngineerHome() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [metric, setMetric] = useState<Metric>('cost')

  const hourly = useQuery({ queryKey: ['hourly'], queryFn: getHourlyTraffic })
  const dlpTypes = useQuery({ queryKey: ['dlp-by-type'], queryFn: getDlpByType })
  const accounts = useQuery({ queryKey: ['service-accounts'], queryFn: getServiceAccounts })
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: getApiKeys })
  const health = useQuery({ queryKey: ['provider-health'], queryFn: getProviderHealth })
  const logs = useQuery({ queryKey: ['dlp-logs'], queryFn: getDlpLogs })

  const failed = [hourly, dlpTypes, accounts, keys, health, logs].some((q) => q.isError)
  if (failed) return <div className="glass rounded-3xl p-8 text-rose-600">Could not load the dashboard data.</div>

  if (!hourly.data || !dlpTypes.data || !accounts.data || !keys.data || !health.data || !logs.data) {
    return <div className="glass rounded-3xl p-8 text-slate-500">Loading mission control...</div>
  }

  const hourlyData = hourly.data
  const dlpData = dlpTypes.data
  const accountList = [...accounts.data].sort((a, b) => b.cost - a.cost)
  const keyList = keys.data
  const healthList = health.data
  const logList = logs.data

  const totalRequests = hourlyData.reduce((s, h) => s + h.requests, 0)
  const avg = (k: 'p50' | 'p95' | 'errorRate') => hourlyData.reduce((s, h) => s + h[k], 0) / hourlyData.length
  const piiTotal = dlpData.reduce((s, d) => s + d.count, 0)
  const maxCost = Math.max(...accountList.map((a) => a.cost))

  const down = healthList.filter((h) => h.circuit === 'open').length
  const degraded = healthList.filter((h) => h.circuit === 'half-open').length
  const status =
    down > 0
      ? { text: `${down} provider${down > 1 ? 's' : ''} down`, dot: 'bg-rose-500', ping: 'bg-rose-400', color: 'text-rose-700' }
      : degraded > 0
        ? { text: 'Degraded performance', dot: 'bg-amber-500', ping: 'bg-amber-400', color: 'text-amber-700' }
        : { text: 'All systems operational', dot: 'bg-emerald-500', ping: 'bg-emerald-400', color: 'text-emerald-700' }

  const donutData = accountList.map((s, i) => ({
    name: s.name,
    value: metric === 'cost' ? s.cost : s.requests,
    color: PALETTE[i % PALETTE.length],
  }))
  const donutTotal = donutData.reduce((s, d) => s + d.value, 0)

  const activeKeys = keyList.filter((k) => k.status === 'active').length

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting()}, ${user?.name.split(' ')[0] ?? 'there'}`}
        subtitle="Mission control for your gateway, service accounts and keys."
        badge={
          <span className={`glass inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${status.color}`}>
            <span className="relative flex h-2.5 w-2.5">
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${status.ping}`} />
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${status.dot}`} />
            </span>
            {status.text}
          </span>
        }
        actions={
          <button onClick={() => queryClient.invalidateQueries()} className="glass-btn" aria-label="Refresh data">
            <RefreshCw size={16} className={hourly.isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Link to="/engineering/keys" className="glass-btn glass-btn-emerald">
          <Plus size={16} /> Create API key
        </Link>
        <Link to="/engineering/gateway" className="glass-btn">
          <Activity size={16} /> Gateway health
        </Link>
        <Link to="/engineering/dlp" className="glass-btn">
          <ScanEye size={16} /> DLP logs
        </Link>
        <Link to="/engineering/accounts" className="glass-btn">
          <Server size={16} /> Service accounts
        </Link>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Requests today"
          value={compact(totalRequests)}
          icon={<Activity size={18} />}
          tone="emerald"
          spark={hourlyData.map((h) => h.requests)}
          hint="Across all service accounts"
        />
        <StatCard
          label="p95 latency"
          value={`${Math.round(avg('p95'))} ms`}
          icon={<Timer size={18} />}
          tone="sky"
          spark={hourlyData.map((h) => h.p95)}
          hint={`p50 is ${Math.round(avg('p50'))} ms`}
        />
        <StatCard
          label="Error rate"
          value={`${avg('errorRate').toFixed(2)}%`}
          icon={<AlertTriangle size={18} />}
          tone="pink"
          spark={hourlyData.map((h) => h.errorRate)}
          hint="Average across the day"
        />
        <StatCard
          label="PII intercepted"
          value={String(piiTotal)}
          icon={<ScanEye size={18} />}
          tone="indigo"
          hint="Redacted or blocked this week"
        />
      </div>

      {/* Traffic + provider health */}
      <div className="grid gap-6 xl:grid-cols-3">
        <GlassCard
          className="xl:col-span-2"
          title="Traffic and latency"
          subtitle="Requests per hour (bars) with p50 and p95 latency (lines)"
        >
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={hourlyData}>
                <defs>
                  <linearGradient id="traffic-bar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.9} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.35} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="hour" tick={axisTick} tickLine={false} axisLine={false} interval={2} />
                <YAxis yAxisId="l" tick={axisTick} tickLine={false} axisLine={false} width={40} />
                <YAxis
                  yAxisId="r"
                  orientation="right"
                  tick={axisTick}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  tickFormatter={(v) => `${v}ms`}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="l" dataKey="requests" name="Requests" fill="url(#traffic-bar)" radius={[6, 6, 0, 0]} />
                <Line yAxisId="r" type="monotone" dataKey="p95" name="p95 latency" stroke="#f472b6" strokeWidth={2.5} dot={false} />
                <Line yAxisId="r" type="monotone" dataKey="p50" name="p50 latency" stroke="#818cf8" strokeWidth={2.5} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </GlassCard>

        <GlassCard
          title="Provider health"
          subtitle="Circuit breaker status"
          action={
            <Link to="/engineering/gateway" className="glass-btn glass-btn-sm">
              Details
            </Link>
          }
        >
          <ul className="space-y-3">
            {healthList.map((h) => {
              const c = circuitStyle[h.circuit]
              return (
                <li key={h.provider} className="rounded-2xl border border-white/70 bg-white/30 p-3">
                  <div className="flex items-center gap-3">
                    <span className="relative flex h-3 w-3 shrink-0">
                      {c.ping && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${c.ping}`} />}
                      <span className={`relative inline-flex h-3 w-3 rounded-full ${c.dot}`} />
                    </span>
                    <p className="flex-1 text-sm font-medium text-slate-800">{h.provider}</p>
                    <Badge tone={c.tone}>{c.label}</Badge>
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                    <span>p95 {h.p95Ms} ms</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/70">
                      <div
                        className={`h-full rounded-full ${h.errorRate > 5 ? 'bg-rose-400' : h.errorRate > 2 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                        style={{ width: `${Math.min(h.errorRate * 8, 100)}%` }}
                      />
                    </div>
                    <span>{h.errorRate}% err</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </GlassCard>
      </div>

      {/* Leaderboard + donut */}
      <div className="grid gap-6 xl:grid-cols-3">
        <GlassCard
          className="xl:col-span-2"
          title="Service account leaderboard"
          subtitle="Who is spending the most"
          action={
            <Link to="/engineering/accounts" className="glass-btn glass-btn-sm">
              View all
            </Link>
          }
        >
          <ol className="space-y-3">
            {accountList.map((s, i) => (
              <li key={s.name} className="flex items-center gap-4">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/90 text-sm font-bold ${
                    i === 0 ? 'bg-amber-200/70 text-amber-800' : 'bg-white/50 text-slate-600'
                  }`}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {s.name} <span className="text-xs font-normal text-slate-400">{s.namespace}</span>
                    </p>
                    <p className="text-sm font-semibold text-slate-800">{money(s.cost, 2)}</p>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/60">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-300 via-sky-300 to-indigo-300"
                      style={{ width: `${(s.cost / maxCost) * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {s.requests.toLocaleString()} requests - {compact(s.tokens)} tokens - {s.errorRate}% errors
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </GlassCard>

        <GlassCard
          title="Share by service"
          subtitle="Switch between cost and requests"
          action={<Segmented options={metricOptions} value={metric} onChange={setMetric} />}
        >
          <Donut
            data={donutData}
            centerLabel={metric === 'cost' ? 'Total cost' : 'Total requests'}
            centerValue={metric === 'cost' ? money(donutTotal) : compact(donutTotal)}
            format={(n) => (metric === 'cost' ? money(n, 2) : n.toLocaleString())}
          />
        </GlassCard>
      </div>

      {/* Keys + DLP */}
      <div className="grid gap-6 xl:grid-cols-2">
        <GlassCard
          title="API keys"
          subtitle={`${activeKeys} active, ${keyList.length - activeKeys} revoked`}
          action={
            <Link to="/engineering/keys" className="glass-btn glass-btn-sm glass-btn-emerald">
              <Plus size={14} /> New key
            </Link>
          }
        >
          <ul className="space-y-2.5">
            {keyList.slice(0, 4).map((k) => (
              <li key={k.id} className="flex items-center gap-3 rounded-xl border border-white/70 bg-white/30 px-3 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-300/30 text-emerald-600">
                  <KeyRound size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{k.name}</p>
                  <p className="truncate font-mono text-xs text-slate-500">{k.prefix}...</p>
                </div>
                <div className="text-right">
                  <Badge tone={k.status === 'active' ? 'green' : 'slate'}>{k.status}</Badge>
                  <p className="mt-1 text-[10px] text-slate-500">used {k.lastUsed}</p>
                </div>
              </li>
            ))}
          </ul>
        </GlassCard>

        <GlassCard
          title="PII / DLP intercepts"
          subtitle="Sensitive data caught before it reached a provider"
          action={
            <Link to="/engineering/dlp" className="glass-btn glass-btn-sm">
              View logs
            </Link>
          }
        >
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dlpData} layout="vertical" margin={{ left: 4, right: 16 }}>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="type" tick={axisTick} tickLine={false} axisLine={false} width={80} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="count" name="Intercepts" radius={[0, 8, 8, 0]}>
                  {dlpData.map((d, i) => (
                    <Cell key={d.type} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-3 space-y-2">
            {logList.slice(0, 3).map((l) => (
              <li key={l.id} className="flex items-center gap-3 rounded-xl border border-white/70 bg-white/30 px-3 py-2 text-xs">
                <Badge tone={l.action === 'blocked' ? 'red' : 'amber'}>{l.action}</Badge>
                <span className="font-medium text-slate-700">{l.serviceAccount}</span>
                <span className="truncate text-slate-500">{l.type}</span>
                <span className="ml-auto shrink-0 text-slate-400">{l.timestamp.slice(-5)}</span>
              </li>
            ))}
          </ul>
        </GlassCard>
      </div>
    </div>
  )
}