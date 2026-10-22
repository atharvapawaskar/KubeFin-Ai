import {
  PROVIDERS,
  type DailyPoint,
  type DlpTypeCount,
  type HourlyPoint,
  type ProviderName,
  type SavingIdea,
} from '../types/dashboard'

function rng(seed: number) {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

const BASE: Record<ProviderName, number> = { OpenAI: 16, Anthropic: 11, Google: 6, Groq: 1.6 }

export function buildDaily(days = 60): DailyPoint[] {
  const rand = rng(2026)
  const out: DailyPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const weekend = d.getDay() === 0 || d.getDay() === 6
    const growth = 1 + (days - 1 - i) * 0.006
    const factor = (weekend ? 0.55 : 1) * growth

    const costs = {} as Record<ProviderName, number>
    let total = 0
    for (const p of PROVIDERS) {
      const v = Number((BASE[p] * factor * (0.8 + rand() * 0.4)).toFixed(2))
      costs[p] = v
      total += v
    }
    const requests = Math.round(total * 95)
    out.push({
      ...costs,
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      total: Number(total.toFixed(2)),
      requests,
      tokens: requests * 1100,
    })
  }
  return out
}

export function buildHeatmap(): number[][] {
  const rand = rng(77)
  return Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => {
      const work = hour >= 9 && hour <= 18 ? 1 : hour >= 7 && hour <= 21 ? 0.45 : 0.12
      const weekend = day >= 5 ? 0.35 : 1
      return Math.round(work * weekend * (60 + rand() * 40))
    }),
  )
}

export function buildHourly(): HourlyPoint[] {
  const rand = rng(404)
  return Array.from({ length: 24 }, (_, h) => {
    const load = h >= 9 && h <= 18 ? 1 : h >= 7 && h <= 21 ? 0.5 : 0.15
    return {
      hour: `${String(h).padStart(2, '0')}:00`,
      requests: Math.round(load * (900 + rand() * 500)),
      p50: Math.round(520 + load * 160 + rand() * 80),
      p95: Math.round(1400 + load * 700 + rand() * 300),
      errorRate: Number((0.4 + load * 0.5 + rand() * 0.8).toFixed(2)),
    }
  })
}

export const mockSavings: SavingIdea[] = [
  {
    id: 's1',
    title: 'Move support-bot to a smaller model',
    description: 'Short answers are running on gpt-4o. gpt-4o-mini handles them at a fraction of the cost.',
    monthlySavings: 186,
    effort: 'Low',
  },
  {
    id: 's2',
    title: 'Cache repeated search-indexer prompts',
    description: 'About 30% of prompts are identical. Caching them avoids paying twice.',
    monthlySavings: 142,
    effort: 'Medium',
  },
  {
    id: 's3',
    title: 'Route report-gen to Gemini Flash off-peak',
    description: 'Nightly reports are not latency sensitive and can use the cheapest model.',
    monthlySavings: 96,
    effort: 'Low',
  },
  {
    id: 's4',
    title: 'Trim long system prompts in checkout-svc',
    description: 'The system prompt adds about 1,800 tokens to every request.',
    monthlySavings: 58,
    effort: 'Medium',
  },
]

export const mockDlpByType: DlpTypeCount[] = [
  { type: 'Email', count: 42 },
  { type: 'Phone', count: 27 },
  { type: 'Credit card', count: 14 },
  { type: 'API secret', count: 9 },
  { type: 'Aadhaar', count: 6 },
]