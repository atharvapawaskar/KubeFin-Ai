import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts'
import {
  AlertTriangle, BellRing, Check, DollarSign, Download, Flame, PiggyBank, RefreshCw, Scale, ShieldAlert,
  Sparkles, Wallet, X,
} from 'lucide-react'
import { getCapPolicies, getProviderCosts, getTeamBudgets } from '../../api/endpoints'
import { getDailySeries, getHeatmap, getSavings } from '../../api/dashboardApi'
import { PROVIDERS, PROVIDER_COLORS, type DailyPoint } from '../../types/dashboard'
import { useAuth } from '../../auth/AuthContext'
import { axisTick, gridStroke, tooltipStyle } from '../../lib/chartTheme'
import { compact, downloadCsv, greeting, money, pctChange } from '../../lib/format'
import Badge, { type Tone } from '../../components/Badge'
import Donut from '../../components/ui/Donut'
import GlassCard from '../../components/ui/GlassCard'
import Heatmap from '../../components/ui/Heatmap'
import PageHeader from '../../components/ui/PageHeader'
import RingGauge from '../../components/ui/RingGauge'
import Segmented from '../../components/ui/Segmented'
import StatCard from '../../components/ui/StatCard'

type Range = '7' | '14' | '30'
const rangeOptions: { value: Range; label: string }[] = [
  { value: '7', label: '7D' },
  { value: '14', label: '14D' },
  { value: '30', label: '30D' },
]

interface Alert {
  id: string
  level: 'critical' | 'warning'
  title: string
  detail: string
}

interface ModelPoint {
  name: string
  provider: string
  latency: number
  cost: number
}

const effortTone: Record<string, Tone> = { Low: 'green', Medium: 'amber', High: 'red' }

function ScatterTip({ active, payload }: { active?: boolean; payload?: readonly { payload?: ModelPoint }[] }) {
  const p = payload?.[0]?.payload
  if (!active || !p) return null
  return (
    <div style={tooltipStyle} className="px-3 py-2">
      <p className="font-semibold text-slate-800">{p.name}</p>
      <p className="text-slate-500">{p.provider}</p>
      <p className="mt-1 text-slate-700">{money(p.cost, 2)} per 1M tokens</p>
      <p className="text-slate-700">{p.latency} ms average latency</p>
    </div>
  )
}

export default function CommandCenter() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [range, setRange] = useState<Range>('14')
  const [applied, setApplied] = useState<string[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])

  const daily = useQuery({ queryKey: ['daily-series'], queryFn: getDailySeries })
  const heat = useQuery({ queryKey: ['heatmap'], queryFn: getHeatmap })
  const savings = useQuery({ queryKey: ['savings'], queryFn: getSavings })
  const budgets = useQuery({ queryKey: ['team-budgets'], queryFn: getTeamBudgets })
  const policies = useQuery({ queryKey: ['cap-policies'], queryFn: getCapPolicies })
  const models = useQuery({ queryKey: ['provider-costs'], queryFn: getProviderCosts })

  const days = Number(range)

  const view = useMemo(() => {
    const d = daily.data
    if (!d) return null
    const sum = (arr: DailyPoint[]) => arr.reduce((s, p) => s + p.total, 0)
    const cur = d.slice(-days)
    const prev = d.slice(-days * 2, -days)
    const total = sum(cur)
    return {
      cur,
      total,
      requests: cur.reduce((s, p) => s + p.requests, 0),
      delta: pctChange(total, sum(prev)),
      runRate: (sum(d.slice(-7)) / 7) * 30,
      spark: cur.map((p) => p.total),
      spark14: d.slice(-14).map((p) => p.total),
      byProvider: PROVIDERS.map((p) => ({
        name: p,
        value: Number(cur.reduce((s, x) => s + x[p], 0).toFixed(2)),
        color: PROVIDER_COLORS[p],
      })),
    }
  }, [daily.data, days])

  const points: ModelPoint[] = useMemo(
    () =>
      (models.data ?? []).map((m) => ({
        name: m.model,
        provider: m.provider,
        latency: m.avgLatencyMs,
        cost: Number(((m.inputPer1M * 3 + m.outputPer1M) / 4).toFixed(2)),
      })),
    [models.data],
  )

  const failed = [daily, heat, savings, budgets, policies, models].some((q) => q.isError)
  if (failed) return <div className="glass rounded-3xl p-8 text-rose-600">Could not load the dashboard data.</div>

  if (!view || !heat.data || !savings.data || !budgets.data || !policies.data || !models.data) {
    return <div className="glass rounded-3xl p-8 text-slate-500">Loading your dashboard...</div>
  }

  const heatData = heat.data
  const savingList = savings.data
  const budgetList = budgets.data
  const policyList = policies.data

  const totalLimit = budgetList.reduce((s, b) => s + b.limit, 0)
  const totalUsed = budgetList.reduce((s, b) => s + b.used, 0)
  const budgetPct = (totalUsed / totalLimit) * 100

  const potential = savingList.reduce((s, x) => s + x.monthlySavings, 0)
  const savedTotal = savingList.filter((s) => applied.includes(s.id)).reduce((s, x) => s + x.monthlySavings, 0)

  const alerts: Alert[] = budgetList
    .flatMap((b): Alert[] => {
      const pct = (b.used / b.limit) * 100
      if (pct >= 100) {
        return [{
          id: `over-${b.id}`,
          level: 'critical',
          title: `${b.team} is over budget`,
          detail: `${money(b.used)} of ${money(b.limit)} used (${pct.toFixed(0)}%)`,
        }]
      }
      if (pct >= b.softCapPct) {
        return [{
          id: `soft-${b.id}`,
          level: 'warning',
          title: `${b.team} passed its ${b.softCapPct}% soft cap`,
          detail: `${money(b.used)} of ${money(b.limit)} used (${pct.toFixed(0)}%)`,
        }]
      }
      return []
    })
    .filter((a) => !dismissed.includes(a.id))

  const enabledPolicies = policyList.filter((p) => p.enabled).length
  const hardPolicies = policyList.filter((p) => p.type === 'hard').length

  function exportCsv() {
    if (!view) return
    downloadCsv(`kubefin-spend-${range}d.csv`, [
      ['Date', ...PROVIDERS, 'Total'],
      ...view.cur.map((p) => [p.date, ...PROVIDERS.map((n) => p[n]), p.total]),
    ])
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting()}, ${user?.name.split(' ')[0] ?? 'there'}`}
        subtitle="Here is how AI spend looks across the company."
        actions={
          <>
            <Segmented options={rangeOptions} value={range} onChange={setRange} />
            <button
              onClick={() => queryClient.invalidateQueries()}
              className="glass-btn"
              aria-label="Refresh data"
            >
              <RefreshCw size={16} className={daily.isFetching ? 'animate-spin' : ''} /> Refresh
            </button>
          </>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Link to="/finops/budgets" className="glass-btn glass-btn-indigo">
          <Wallet size={16} /> Set a budget
        </Link>
        <Link to="/finops/policies" className="glass-btn">
          <ShieldAlert size={16} /> Cap policies
        </Link>
        <Link to="/finops/providers" className="glass-btn">
          <Scale size={16} /> Compare providers
        </Link>
        <button onClick={exportCsv} className="glass-btn">
          <Download size={16} /> Export report
        </button>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`Spend (last ${days} days)`}
          value={money(view.total)}
          icon={<DollarSign size={18} />}
          spark={view.spark}
          delta={view.delta}
          goodWhenDown
          hint={`${compact(view.requests)} requests vs the previous ${days} days`}
        />
        <StatCard
          label="30-day run rate"
          value={money(view.runRate)}
          icon={<Flame size={18} />}
          tone="pink"
          spark={view.spark14}
          hint="Based on the last 7 days"
        />
        <StatCard
          label="Budget used"
          value={`${budgetPct.toFixed(0)}%`}
          icon={<Wallet size={18} />}
          tone="sky"
          hint={`${money(totalUsed)} of ${money(totalLimit)} this month`}
        >
          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/60">
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400"
              style={{ width: `${Math.min(budgetPct, 100)}%` }}
            />
          </div>
        </StatCard>
        <StatCard
          label="Potential savings"
          value={`${money(potential - savedTotal)}/mo`}
          icon={<PiggyBank size={18} />}
          tone="emerald"
          hint={`${money(savedTotal)} per month already applied`}
        />
      </div>

      {/* Spend chart + provider share */}
      <div className="grid gap-6 xl:grid-cols-3">
        <GlassCard
          className="xl:col-span-2"
          title="Spend by provider"
          subtitle={`Daily cost, last ${days} days`}
        >
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={view.cur}>
                <defs>
                  {PROVIDERS.map((p) => (
                    <linearGradient key={p} id={`fill-${p}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={PROVIDER_COLORS[p]} stopOpacity={0.55} />
                      <stop offset="100%" stopColor={PROVIDER_COLORS[p]} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `$${v}`} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(Number(v), 2)} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                {PROVIDERS.map((p) => (
                  <Area
                    key={p}
                    type="monotone"
                    dataKey={p}
                    stackId="1"
                    stroke={PROVIDER_COLORS[p]}
                    strokeWidth={2}
                    fill={`url(#fill-${p})`}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </GlassCard>

        <GlassCard title="Provider share" subtitle="Where the money goes">
          <Donut
            data={view.byProvider}
            centerLabel="Total"
            centerValue={money(view.total)}
            format={(n) => money(n, 2)}
          />
        </GlassCard>
      </div>

      {/* Budgets + alerts */}
      <div className="grid gap-6 xl:grid-cols-3">
        <GlassCard
          className="xl:col-span-2"
          title="Team budgets"
          subtitle="Share of each monthly budget used"
          action={
            <Link to="/finops/budgets" className="glass-btn glass-btn-sm">
              Manage
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            {budgetList.map((b) => (
              <div key={b.id} className="flex flex-col items-center text-center">
                <RingGauge value={(b.used / b.limit) * 100} size={104} />
                <p className="mt-2 text-sm font-medium text-slate-800">{b.team}</p>
                <p className="text-xs text-slate-500">
                  {money(b.used)} / {money(b.limit)}
                </p>
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard
          title="Alerts"
          subtitle="Budgets that need attention"
          action={<BellRing size={18} className="text-slate-400" />}
        >
          {alerts.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center text-sm text-slate-500">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-300/30 text-emerald-600">
                <Check size={22} />
              </span>
              <p className="mt-3 font-medium text-slate-700">All clear</p>
              <p>No budgets need attention right now.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {alerts.map((a) => (
                <li
                  key={a.id}
                  className={`flex items-start gap-3 rounded-2xl border p-3 ${
                    a.level === 'critical' ? 'border-rose-200 bg-rose-100/40' : 'border-amber-200 bg-amber-100/40'
                  }`}
                >
                  <AlertTriangle
                    size={18}
                    className={`mt-0.5 shrink-0 ${a.level === 'critical' ? 'text-rose-500' : 'text-amber-500'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">{a.title}</p>
                    <p className="text-xs text-slate-500">{a.detail}</p>
                  </div>
                  <button
                    onClick={() => setDismissed([...dismissed, a.id])}
                    aria-label="Dismiss alert"
                    className="text-slate-400 hover:text-slate-600"
                  >
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </GlassCard>
      </div>

      {/* Heatmap + scatter */}
      <div className="grid gap-6 xl:grid-cols-2">
        <GlassCard title="When do we spend?" subtitle="Requests by weekday and hour. Darker means busier.">
          <Heatmap data={heatData} />
        </GlassCard>

        <GlassCard title="Cost vs speed" subtitle="Models in the bottom-left are cheap and fast">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="latency"
                  name="Latency"
                  tick={axisTick}
                  tickLine={false}
                  tickFormatter={(v) => `${v}ms`}
                />
                <YAxis
                  type="number"
                  dataKey="cost"
                  name="Cost"
                  tick={axisTick}
                  tickLine={false}
                  width={48}
                  tickFormatter={(v) => `$${v}`}
                />
                <ZAxis range={[140, 140]} />
                <Tooltip content={<ScatterTip />} cursor={{ strokeDasharray: '3 3' }} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                {PROVIDERS.map((p) => (
                  <Scatter
                    key={p}
                    name={p}
                    data={points.filter((pt) => pt.provider === p)}
                    fill={PROVIDER_COLORS[p]}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </GlassCard>
      </div>

      {/* Savings + policies */}
      <div className="grid gap-6 xl:grid-cols-3">
        <GlassCard
          className="xl:col-span-2"
          title="Savings opportunities"
          subtitle="Click Apply to mark an idea as done (kept in this session only)"
        >
          <ul className="space-y-3">
            {savingList.map((s) => {
              const done = applied.includes(s.id)
              return (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/70 bg-white/30 p-4"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/80 bg-pink-300/30 text-pink-600">
                    <Sparkles size={18} />
                  </span>
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="font-medium text-slate-800">{s.title}</p>
                    <p className="text-xs text-slate-500">{s.description}</p>
                    <div className="mt-1.5">
                      <Badge tone={effortTone[s.effort]}>{`${s.effort} effort`}</Badge>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-emerald-600">{money(s.monthlySavings)}</p>
                    <p className="text-[10px] text-slate-500">per month</p>
                  </div>
                  <button
                    onClick={() =>
                      setApplied(done ? applied.filter((x) => x !== s.id) : [...applied, s.id])
                    }
                    className={`glass-btn glass-btn-sm ${done ? 'glass-btn-emerald' : 'glass-btn-indigo'}`}
                  >
                    {done ? (
                      <>
                        <Check size={14} /> Applied
                      </>
                    ) : (
                      'Apply'
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </GlassCard>

        <GlassCard
          title="Cap policies"
          subtitle={`${enabledPolicies} of ${policyList.length} enabled, ${hardPolicies} hard caps`}
          action={
            <Link to="/finops/policies" className="glass-btn glass-btn-sm">
              Edit
            </Link>
          }
        >
          <ul className="space-y-2.5">
            {policyList.slice(0, 5).map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-xl border border-white/70 bg-white/30 px-3 py-2.5">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{p.scope}</p>
                  <p className="truncate text-xs text-slate-500">
                    {p.thresholdPct}% - {p.action}
                  </p>
                </div>
                <Badge tone={p.type === 'hard' ? 'red' : 'amber'}>{p.type === 'hard' ? 'Hard' : 'Soft'}</Badge>
              </li>
            ))}
          </ul>
        </GlassCard>
      </div>
    </div>
  )
}