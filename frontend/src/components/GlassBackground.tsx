import type { ReactNode } from 'react'

export default function GlassBackground({ children }: { children: ReactNode }) {
  return (
    <>
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="kf-drift absolute -left-24 -top-24 h-96 w-96 rounded-full bg-sky-300/40 blur-3xl" />
        <div
          className="kf-drift absolute -right-24 top-1/4 h-[28rem] w-[28rem] rounded-full bg-violet-300/40 blur-3xl"
          style={{ animationDelay: '-6s' }}
        />
        <div
          className="kf-drift absolute -bottom-32 left-1/3 h-96 w-96 rounded-full bg-pink-300/35 blur-3xl"
          style={{ animationDelay: '-12s' }}
        />
        <div
          className="kf-drift absolute -left-16 bottom-10 h-72 w-72 rounded-full bg-emerald-300/35 blur-3xl"
          style={{ animationDelay: '-3s' }}
        />
      </div>
      <div className="relative z-10">{children}</div>
    </>
  )
}