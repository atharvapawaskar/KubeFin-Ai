export type Role = 'finops' | 'engineer'

export interface User {
  name: string
  email: string
  role: Role
}

export interface SpendPoint {
  timestamp: string
  cost: number
  requests: number
  tokens: number
}

export interface TokenBilling {
  provider: string
  inputTokens: number
  outputTokens: number
  cost: number
}

export interface TeamBudget {
  id: string
  team: string
  limit: number
  used: number
  softCapPct: number
}

export interface CapPolicy {
  id: string
  scope: string
  type: 'soft' | 'hard'
  thresholdPct: number
  action: string
  enabled: boolean
}

export interface ProviderCost {
  model: string
  provider: string
  inputPer1M: number
  outputPer1M: number
  avgLatencyMs: number
}

export interface ServiceAccountStat {
  name: string
  namespace: string
  requests: number
  tokens: number
  cost: number
  errorRate: number
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsed: string
  status: 'active' | 'revoked'
}

export interface ProviderHealth {
  provider: string
  p50Ms: number
  p95Ms: number
  errorRate: number
  circuit: 'closed' | 'half-open' | 'open'
}

export interface DlpLog {
  id: string
  timestamp: string
  serviceAccount: string
  type: string
  action: 'redacted' | 'blocked'
  snippet: string
}