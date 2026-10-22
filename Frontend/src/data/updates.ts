export type UpdateTag = 'New' | 'Improved' | 'Security' | 'Roadmap'

export interface UpdateItem {
  date: string // YYYY-MM-DD
  tag: UpdateTag
  title: string
  description: string
}

export const updates: UpdateItem[] = [
  {
    date: '2026-10-15',
    tag: 'New',
    title: 'Role-based portals',
    description: 'Separate FinOps and Engineering portals, with the role checked on every API call.',
  },
  {
    date: '2026-10-12',
    tag: 'New',
    title: 'PII / DLP intercept logs',
    description: 'See which sensitive data the gateway redacted or blocked before it reached a provider.',
  },
  {
    date: '2026-10-08',
    tag: 'Improved',
    title: 'Multi-provider cost comparison',
    description: 'Compare blended cost per 1M tokens and latency across OpenAI, Anthropic, Google and Groq.',
  },
  {
    date: '2026-10-01',
    tag: 'Security',
    title: 'API key management',
    description: 'Keys are shown once at creation and can be revoked at any time.',
  },
  {
    date: '2026-09-24',
    tag: 'Roadmap',
    title: 'Helm chart for Kubernetes',
    description: 'One-command install of the gateway, worker and dashboard into your cluster. Coming soon.',
  },
]