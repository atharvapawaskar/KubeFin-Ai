export const PROVIDERS = ['OpenAI', 'Anthropic', 'Google', 'Groq'] as const
export type ProviderName = (typeof PROVIDERS)[number]

export const PROVIDER_COLORS: Record<ProviderName, string> = {
  OpenAI: '#6366f1',
  Anthropic: '#f472b6',
  Google: '#38bdf8',
  Groq: '#34d399',
}

export interface DailyPoint extends Record<ProviderName, number> {
  date: string
  label: string
  total: number
  requests: number
  tokens: number
}

export interface SavingIdea {
  id: string
  title: string
  description: string
  monthlySavings: number
  effort: 'Low' | 'Medium' | 'High'
}

export interface HourlyPoint {
  hour: string
  requests: number
  p50: number
  p95: number
  errorRate: number
}

export interface DlpTypeCount {
  type: string
  count: number
}