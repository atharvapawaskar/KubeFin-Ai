import type {
  SpendPoint, TokenBilling, TeamBudget, CapPolicy, ProviderCost,
  ServiceAccountStat, ApiKey, ProviderHealth, DlpLog,
} from '../types/api'

// Demo accounts for development only. Delete when M1's real auth is ready.
export const mockUsers = [
  { email: 'finops@kubefin.ai', password: 'finops123', name: 'Fiona FinOps', role: 'finops' as const },
  { email: 'engineer@kubefin.ai', password: 'eng123', name: 'Eshan Engineer', role: 'engineer' as const },
]

export function mockSpendSeries(days = 14): SpendPoint[] {
  const points: SpendPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const requests = 800 + Math.round(Math.random() * 700)
    const tokens = requests * (900 + Math.round(Math.random() * 400))
    points.push({
      timestamp: d.toISOString().slice(0, 10),
      requests,
      tokens,
      cost: Number(((tokens / 1_000_000) * 4.5).toFixed(2)),
    })
  }
  return points
}

export const mockTokenBilling: TokenBilling[] = [
  { provider: 'OpenAI', inputTokens: 18_400_000, outputTokens: 6_200_000, cost: 412.5 },
  { provider: 'Anthropic', inputTokens: 12_100_000, outputTokens: 4_800_000, cost: 318.2 },
  { provider: 'Google', inputTokens: 9_300_000, outputTokens: 3_100_000, cost: 141.7 },
  { provider: 'Groq', inputTokens: 7_600_000, outputTokens: 2_400_000, cost: 38.9 },
]

export const mockTeamBudgets: TeamBudget[] = [
  { id: '1', team: 'Engineering', limit: 5000, used: 3650, softCapPct: 80 },
  { id: '2', team: 'Data Science', limit: 3000, used: 2780, softCapPct: 80 },
  { id: '3', team: 'Support Bot', limit: 1200, used: 410, softCapPct: 75 },
  { id: '4', team: 'Marketing', limit: 800, used: 845, softCapPct: 70 },
]

export const mockCapPolicies: CapPolicy[] = [
  { id: 'p1', scope: 'Engineering', type: 'soft', thresholdPct: 80, action: 'Notify team lead', enabled: true },
  { id: 'p2', scope: 'Engineering', type: 'hard', thresholdPct: 100, action: 'Block new requests', enabled: true },
  { id: 'p3', scope: 'Data Science', type: 'soft', thresholdPct: 80, action: 'Notify FinOps', enabled: true },
  { id: 'p4', scope: 'Marketing', type: 'hard', thresholdPct: 100, action: 'Route to cheaper model', enabled: false },
  { id: 'p5', scope: 'All tenants', type: 'soft', thresholdPct: 90, action: 'Send email alert', enabled: true },
]

export const mockProviderCosts: ProviderCost[] = [
  { model: 'gpt-4o', provider: 'OpenAI', inputPer1M: 2.5, outputPer1M: 10, avgLatencyMs: 1200 },
  { model: 'gpt-4o-mini', provider: 'OpenAI', inputPer1M: 0.15, outputPer1M: 0.6, avgLatencyMs: 620 },
  { model: 'claude-sonnet', provider: 'Anthropic', inputPer1M: 3, outputPer1M: 15, avgLatencyMs: 1350 },
  { model: 'claude-haiku', provider: 'Anthropic', inputPer1M: 0.8, outputPer1M: 4, avgLatencyMs: 540 },
  { model: 'gemini-1.5-pro', provider: 'Google', inputPer1M: 1.25, outputPer1M: 5, avgLatencyMs: 1480 },
  { model: 'gemini-1.5-flash', provider: 'Google', inputPer1M: 0.075, outputPer1M: 0.3, avgLatencyMs: 480 },
  { model: 'llama-3-70b', provider: 'Groq', inputPer1M: 0.59, outputPer1M: 0.79, avgLatencyMs: 310 },
]

export const mockServiceAccounts: ServiceAccountStat[] = [
  { name: 'checkout-svc', namespace: 'payments', requests: 12400, tokens: 9_800_000, cost: 142.3, errorRate: 0.8 },
  { name: 'search-indexer', namespace: 'search', requests: 8900, tokens: 14_200_000, cost: 98.6, errorRate: 1.4 },
  { name: 'support-bot', namespace: 'support', requests: 15600, tokens: 11_100_000, cost: 76.4, errorRate: 0.5 },
  { name: 'report-gen', namespace: 'analytics', requests: 2100, tokens: 6_700_000, cost: 189.9, errorRate: 2.9 },
  { name: 'doc-summarizer', namespace: 'content', requests: 5300, tokens: 4_400_000, cost: 41.2, errorRate: 0.3 },
]

export const mockApiKeys: ApiKey[] = [
  { id: 'k1', name: 'checkout-prod', prefix: 'kf_live_a81f', createdAt: '2026-08-12', lastUsed: '2 min ago', status: 'active' },
  { id: 'k2', name: 'search-staging', prefix: 'kf_live_c93d', createdAt: '2026-09-02', lastUsed: '1 hour ago', status: 'active' },
  { id: 'k3', name: 'old-experiment', prefix: 'kf_live_7be2', createdAt: '2026-05-20', lastUsed: '41 days ago', status: 'revoked' },
]

export const mockProviderHealth: ProviderHealth[] = [
  { provider: 'OpenAI', p50Ms: 640, p95Ms: 1850, errorRate: 0.6, circuit: 'closed' },
  { provider: 'Anthropic', p50Ms: 720, p95Ms: 2100, errorRate: 1.1, circuit: 'closed' },
  { provider: 'Google', p50Ms: 810, p95Ms: 3400, errorRate: 4.8, circuit: 'half-open' },
  { provider: 'Groq', p50Ms: 190, p95Ms: 520, errorRate: 12.3, circuit: 'open' },
]

export const mockDlpLogs: DlpLog[] = [
  { id: 'd1', timestamp: '2026-10-08 14:32', serviceAccount: 'support-bot', type: 'Email', action: 'redacted', snippet: 'Contact me at [REDACTED_EMAIL] about the refund' },
  { id: 'd2', timestamp: '2026-10-08 13:58', serviceAccount: 'checkout-svc', type: 'Credit card', action: 'blocked', snippet: 'Card number [BLOCKED_CARD] expiry 08/28' },
  { id: 'd3', timestamp: '2026-10-08 12:41', serviceAccount: 'report-gen', type: 'Phone', action: 'redacted', snippet: 'Call [REDACTED_PHONE] to confirm' },
  { id: 'd4', timestamp: '2026-10-08 11:15', serviceAccount: 'doc-summarizer', type: 'API secret', action: 'blocked', snippet: 'Authorization: Bearer [BLOCKED_SECRET]' },
  { id: 'd5', timestamp: '2026-10-07 18:09', serviceAccount: 'support-bot', type: 'Aadhaar', action: 'redacted', snippet: 'ID number [REDACTED_ID] provided by customer' },
]