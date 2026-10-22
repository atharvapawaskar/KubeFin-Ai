import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Wallet, Server, Eye, EyeOff, ArrowLeft, type LucideIcon } from 'lucide-react'
import GlassBackground from '../components/GlassBackground'
import { LogoMark } from '../components/Logo'
import { brand } from '../brand'
import { useAuth } from '../auth/AuthContext'
import { homeFor } from '../auth/roles'

type Role = 'finops' | 'engineer'

interface RoleConfig {
  title: string
  blurb: string
  icon: LucideIcon
  iconBox: string
  button: string
  demo: { email: string; password: string }
}

const config: Record<Role, RoleConfig> = {
  finops: {
    title: 'FinOps Officer login',
    blurb: 'Budgets, caps and executive spend',
    icon: Wallet,
    iconBox: 'bg-indigo-300/30 text-indigo-600',
    button: 'glass-btn-indigo',
    demo: { email: 'finops@kubefin.ai', password: 'finops123' },
  },
  engineer: {
    title: 'Engineer login',
    blurb: 'Analytics, keys, gateway health and DLP logs',
    icon: Server,
    iconBox: 'bg-emerald-300/30 text-emerald-600',
    button: 'glass-btn-emerald',
    demo: { email: 'engineer@kubefin.ai', password: 'eng123' },
  },
}

export default function RoleLogin({ role }: { role: Role }) {
  const cfg = config[role]
  const Icon = cfg.icon
  const { user, login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (user) return <Navigate to={homeFor(user.role)} replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password, role)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <GlassBackground>
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div className="glass w-full max-w-md rounded-3xl p-8">
          <div className="mb-6 flex flex-col items-center text-center">
            <Link to="/" aria-label="Back to home">
              <LogoMark size={52} />
            </Link>
            <p className="mt-2 text-sm font-semibold text-slate-700">
              {brand.name} <span className="text-gradient">{brand.suffix}</span>
            </p>
            <div className={`mt-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/90 ${cfg.iconBox}`}>
              <Icon size={22} />
            </div>
            <h1 className="mt-3 text-2xl font-bold text-slate-800">{cfg.title}</h1>
            <p className="text-sm text-slate-500">{cfg.blurb}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="glass-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Password</label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  className="glass-input pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  aria-label={show ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
                >
                  {show ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {error && (
              <p className="rounded-xl border border-red-200 bg-red-100/50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            <button type="submit" disabled={loading} className={`glass-btn ${cfg.button} w-full py-3`}>
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              setEmail(cfg.demo.email)
              setPassword(cfg.demo.password)
            }}
            className="glass-btn glass-btn-sm mt-4 w-full"
          >
            Fill demo account
          </button>

          <div className="mt-6 flex items-center justify-between text-sm text-slate-600">
            <Link to="/login" className="flex items-center gap-1 hover:text-slate-800">
              <ArrowLeft size={14} /> Other login
            </Link>
            <Link to="/signup" className="font-medium text-indigo-600 hover:underline">
              Create account
            </Link>
          </div>
        </div>
      </div>
    </GlassBackground>
  )
}