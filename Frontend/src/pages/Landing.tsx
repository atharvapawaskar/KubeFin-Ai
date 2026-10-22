import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, LogIn, UserPlus, ArrowRight, TrendingUp, Users, ShieldCheck, Shuffle } from 'lucide-react'
import GlassBackground from '../components/GlassBackground'
import Logo, { LogoMark } from '../components/Logo'
import Badge, { type Tone } from '../components/Badge'
import { brand } from '../brand'
import { updates, type UpdateTag } from '../data/updates'
import { useAuth } from '../auth/AuthContext'
import { homeFor } from '../auth/roles'

const tagTone: Record<UpdateTag, Tone> = {
  New: 'green',
  Improved: 'indigo',
  Security: 'red',
  Roadmap: 'amber',
}

const needs = [
  {
    icon: TrendingUp,
    title: 'Runaway AI bills',
    text: 'Token costs grow quietly. See spend per team, model and provider before the invoice arrives.',
  },
  {
    icon: Users,
    title: 'Nobody owns the cost',
    text: 'Attribute every request to a Kubernetes ServiceAccount, so each team sees its own usage.',
  },
  {
    icon: ShieldCheck,
    title: 'Sensitive data in prompts',
    text: 'The gateway redacts or blocks PII before it reaches a provider, and logs what it caught.',
  },
  {
    icon: Shuffle,
    title: 'Provider price gaps',
    text: 'Compare cost and latency across providers and move workloads to the cheapest good fit.',
  },
]

const steps = [
  {
    title: 'Create your account',
    text: 'Open Sign up, choose whether you are a FinOps officer or an engineer, and set a password.',
  },
  {
    title: 'Sign in to your portal',
    text: 'Pick the matching login. FinOps officers and engineers each land in their own portal.',
  },
  {
    title: 'Set budgets and caps (FinOps)',
    text: 'Give each team a monthly budget, then add soft caps to warn and hard caps to block.',
  },
  {
    title: 'Connect your services (Engineers)',
    text: 'Create an API key, then point your service at the KubeFin gateway instead of the provider.',
  },
  {
    title: 'Watch, compare and optimize',
    text: 'Track spend, latency and blocked data, and move workloads to cheaper models.',
  },
]

const finopsTips = [
  'Start with soft caps around 80% so teams get a warning first.',
  'Check the projected month-end spend, not just what is used so far.',
  'Review the provider comparison monthly to catch cheaper models.',
]

const engineerTips = [
  'Use one API key per service so usage is easy to trace.',
  'Copy a new key right away. It is shown only once.',
  'If requests slow down, check Gateway Health, then the DLP logs.',
]

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true)
          io.disconnect()
        }
      },
      { threshold: 0.15 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className={`${className} transition-all duration-700 ${shown ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  )
}

function SectionTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="mb-10 text-center">
      <p className="text-sm font-semibold uppercase tracking-widest text-indigo-500">{kicker}</p>
      <h2 className="mt-2 text-3xl font-bold text-slate-800 sm:text-4xl">{title}</h2>
    </div>
  )
}

export default function Landing() {
  const { user } = useAuth()

  return (
    <GlassBackground>
      {/* ---------- 1. Hero ---------- */}
      <section className="relative flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-6 py-5">
          <nav className="hidden gap-2 sm:flex">
            <a href="#about" className="glass-btn glass-btn-sm">About us</a>
            <a href="#how" className="glass-btn glass-btn-sm">How to use</a>
          </nav>
          <div className="ml-auto flex gap-2">
            {user ? (
              <Link to={homeFor(user.role)} className="glass-btn glass-btn-indigo">
                Open portal <ArrowRight size={16} />
              </Link>
            ) : (
              <>
                <Link to="/login" className="glass-btn">
                  <LogIn size={16} /> Log in
                </Link>
                <Link to="/signup" className="glass-btn glass-btn-indigo">
                  <UserPlus size={16} /> Sign up
                </Link>
              </>
            )}
          </div>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
          <div className="kf-glow glass rounded-full p-8">
            <div className="kf-float">
              <LogoMark size={150} animated />
            </div>
          </div>
          <h1
            className="kf-fade-up mt-8 text-5xl font-bold tracking-tight text-slate-800 sm:text-6xl"
            style={{ animationDelay: '1.4s' }}
          >
            {brand.name} <span className="text-gradient">{brand.suffix}</span>
          </h1>
          <p className="kf-fade-up mt-4 max-w-xl text-lg text-slate-600" style={{ animationDelay: '1.8s' }}>
            {brand.tagline}
          </p>
        </div>

        <a
          href="#about"
          aria-label="Scroll down"
          className="glass absolute bottom-8 left-1/2 flex h-11 w-11 -translate-x-1/2 animate-bounce items-center justify-center rounded-full text-slate-600"
        >
          <ChevronDown size={22} />
        </a>
      </section>

      {/* ---------- 2. About us ---------- */}
      <section id="about" className="mx-auto max-w-6xl px-6 py-24">
        <Reveal>
          <SectionTitle kicker="About us" title="Why KubeFin AI exists" />
        </Reveal>

        <div className="grid gap-6 lg:grid-cols-2">
          <Reveal className="h-full">
            <div className="glass h-full rounded-3xl p-8">
              <h3 className="text-xl font-semibold text-slate-800">Our story</h3>
              {/* Edit this text to match your project story */}
              <div className="mt-4 space-y-4 text-slate-600">
                <p>
                  AI models are billed by the token, and in a Kubernetes cluster every service can call them.
                  Without one central view, spend grows quietly, nobody owns it, and sensitive data can leave
                  inside a prompt.
                </p>
                <p>
                  {brand.name} {brand.suffix} started as a project to fix this: a gateway that every request
                  passes through, a worker that prices and aggregates usage, and dashboards that show finance
                  and engineering exactly what is happening.
                </p>
                <p>
                  Today it gives FinOps officers budgets and caps, and gives engineers visibility, key
                  management and data protection.
                </p>
              </div>
            </div>
          </Reveal>

          <div className="grid gap-4 sm:grid-cols-2">
            {needs.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={i * 100} className="h-full">
                <div className="glass glass-lift h-full rounded-2xl p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/80 bg-indigo-300/25 text-indigo-600">
                    <Icon size={20} />
                  </div>
                  <h3 className="mt-4 font-semibold text-slate-800">{title}</h3>
                  <p className="mt-1 text-sm text-slate-600">{text}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        <Reveal className="mt-16">
          <h3 className="mb-6 text-center text-xl font-semibold text-slate-800">History and latest updates</h3>
          <ol className="relative mx-auto max-w-3xl space-y-4 border-l-2 border-white/80 pl-8">
            {updates.map((u) => (
              <li key={u.title} className="relative">
                <span className="absolute -left-[41px] top-6 h-4 w-4 rounded-full border-2 border-white bg-gradient-to-br from-sky-400 to-violet-400 shadow" />
                <div className="glass rounded-2xl p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-semibold text-slate-800">{u.title}</h4>
                    <Badge tone={tagTone[u.tag]}>{u.tag}</Badge>
                    <span className="ml-auto text-xs text-slate-500">{formatDate(u.date)}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{u.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      {/* ---------- 3. How to use ---------- */}
      <section id="how" className="mx-auto max-w-4xl px-6 py-24">
        <Reveal>
          <SectionTitle kicker="How to use" title="Up and running in five steps" />
        </Reveal>

        <ol className="space-y-4">
          {steps.map((s, i) => (
            <Reveal key={s.title} delay={i * 80}>
              <li className="glass flex items-start gap-5 rounded-2xl p-5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/90 bg-gradient-to-br from-sky-300/60 to-violet-300/60 font-semibold text-indigo-800">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-semibold text-slate-800">{s.title}</h3>
                  <p className="mt-1 text-sm text-slate-600">{s.text}</p>
                </div>
              </li>
            </Reveal>
          ))}
        </ol>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <Reveal className="h-full">
            <div className="glass h-full rounded-3xl p-6">
              <h3 className="font-semibold text-indigo-700">Tips for FinOps officers</h3>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-600">
                {finopsTips.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={100} className="h-full">
            <div className="glass h-full rounded-3xl p-6">
              <h3 className="font-semibold text-emerald-700">Tips for engineers</h3>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-600">
                {engineerTips.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
          </Reveal>
        </div>

        {!user && (
          <Reveal className="mt-10 text-center">
            <Link to="/signup" className="glass-btn glass-btn-indigo px-8 py-3">
              Get started <ArrowRight size={16} />
            </Link>
          </Reveal>
        )}
      </section>

      {/* ---------- Footer ---------- */}
      <footer className="px-4 pb-4">
        <div className="glass mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 rounded-3xl px-8 py-6 md:flex-row">
          <Logo size={30} />
          <nav className="flex flex-wrap justify-center gap-5 text-sm text-slate-600">
            <a href="#about" className="hover:text-indigo-600">About us</a>
            <a href="#how" className="hover:text-indigo-600">How to use</a>
            <Link to="/login" className="hover:text-indigo-600">Log in</Link>
            <Link to="/signup" className="hover:text-indigo-600">Sign up</Link>
          </nav>
          <p className="text-xs text-slate-500">
            &copy; 2026 {brand.name} {brand.suffix}. All rights reserved.
          </p>
        </div>
      </footer>
    </GlassBackground>
  )
}