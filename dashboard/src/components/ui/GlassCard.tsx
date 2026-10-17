import type { ReactNode } from 'react'

interface Props {
  title?: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}

export default function GlassCard({ title, subtitle, action, children, className = '' }: Props) {
  return (
    <section className={`glass rounded-3xl p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-800">{title}</h2>}
            {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}