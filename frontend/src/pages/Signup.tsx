import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Wallet, Server, Eye, EyeOff, ArrowLeft, type LucideIcon } from 'lucide-react'
import GlassBackground from '../components/GlassBackground'
import { LogoMark } from '../components/Logo'
import { brand } from '../brand'
import { useAuth } from '../auth/AuthContext'
import { homeFor } from '../auth/roles'
import type { Role } from '../types/api'

const roles: { value: Role; label: string; text: string; icon: LucideIcon; selected: string }[] = [
  {
    value: 'finops',
    label: 'FinOps Officer',
    text: 'Budgets and spend',
    icon: Wallet,
    selected: 'border-indigo-300 bg-indigo-300/25 ring-2 ring-indigo-200',
  },
  {
    value: 'engineer',
    label: 'Engineer',
    text: 'Keys and gateway',
    icon: Server,
    selected: 'border-emerald-300 bg-emerald-300/25 ring-2 ring-emerald-200',
  },
]

export default function Signup() {
  const { user, signup } = useAuth()
  const [role, setRole] = useState<Role>('finops')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (user) return <Navigate to={homeFor(user.role)} replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < 6) return setError('Password must be at least 6 characters')
    if (password !== confirm) return setError('Passwords do not match')

    setLoading(true)
    try {
      await signup(name, email, password, role)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed')
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
            <h1 className="mt-3 text-2xl font-bold text-slate-800">Create your account</h1>
            <p className="text-sm text-slate-500">
              Join {brand.name} <span className="text-gradient font-semibold">{brand.suffix}</span>
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">I am a</label>
              <div className="grid grid-cols-2 gap-3">
                {roles.map(({ value, label, text, icon: Icon, selected }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRole(value)}
                    className={`rounded-2xl border p-3 text-left transition ${
                      role === value ? selected : 'border-white/80 bg-white/25 hover:bg-white/40'
                    }`}
                  >
                    <Icon size={18} className="text-slate-600" />
                    <p className="mt-1 text-sm font-semibold text-slate-800">{label}</p>
                    <p className="text-xs text-slate-500">{text}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Full name</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="glass-input" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Email</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="glass-input" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Password</label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
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
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Confirm password</label>
              <input
                type={show ? 'text' : 'password'}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat password"
                className="glass-input"
              />
            </div>

            {error && (
              <p className="rounded-xl border border-red-200 bg-red-100/50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className={`glass-btn w-full py-3 ${role === 'finops' ? 'glass-btn-indigo' : 'glass-btn-emerald'}`}
            >
              {loading ? 'Creating account...' : 'Create account'}
            </button>
          </form>

          <div className="mt-6 flex items-center justify-between text-sm text-slate-600">
            <Link to="/" className="flex items-center gap-1 hover:text-slate-800">
              <ArrowLeft size={14} /> Home
            </Link>
            <span>
              Already have an account?{' '}
              <Link to="/login" className="font-medium text-indigo-600 hover:underline">Log in</Link>
            </span>
          </div>
        </div>
      </div>
    </GlassBackground>
  )
}