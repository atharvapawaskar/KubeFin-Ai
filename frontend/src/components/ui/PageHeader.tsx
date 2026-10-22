import type { ReactNode } from 'react'

interface Props {
  title: string
  subtitle?: string
  badge?: ReactNode
  actions?: ReactNode
}

export default function PageHeader({ title, subtitle, badge, actions }: Props) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-800 sm:text-3xl">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}