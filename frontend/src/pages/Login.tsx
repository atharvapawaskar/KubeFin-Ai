import { Link, Navigate } from 'react-router-dom'
import { Wallet, Server, ArrowRight, ArrowLeft } from 'lucide-react'
import GlassBackground from '../components/GlassBackground'
import { LogoMark } from '../components/Logo'
import { brand } from '../brand'
import { useAuth } from '../auth/AuthContext'
import { homeFor } from '../auth/roles'

const options = [
  {
    to: '/login/finops',
    icon: Wallet,
    title: 'FinOps Officer',
    text: 'Finance and cost owners',
    points: ['Executive spend and token billing', 'Team budgets and cap policies', 'Multi-provider cost comparison'],
    iconBox: 'bg-indigo-300/30 text-indigo-600',
    button: 'glass-btn-indigo',
  },
  {
    to: '/login/engineer',
    icon: Server,
    title: 'Engineer',
    text: 'People who build and run workloads',
    points: ['ServiceAccount analytics', 'API keys and secrets', 'Gateway health and PII / DLP logs'],
    iconBox: 'bg-emerald-300/30 text-emerald-600',
    button: 'glass-btn-emerald',
  },
]

export default function Login() {
  const { user } = useAuth()
  if (user) return <Navigate to={homeFor(user.role)} replace />

  return (
    <GlassBackground>
      <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
        <Link to="/" className="flex flex-col items-center">
          <LogoMark size={64} />
          <span className="mt-2 text-xl font-bold text-slate-800">
            {brand.name} <span className="text-gradient">{brand.suffix}</span>
          </span>
        </Link>

        <h1 className="mt-6 text-3xl font-bold text-slate-800">Welcome back</h1>
        <p className="mt-1 text-slate-600">Choose how you want to sign in</p>

        <div className="mt-10 grid w-full max-w-3xl gap-6 md:grid-cols-2">
          {options.map(({ to, icon: Icon, title, text, points, iconBox, button }) => (
            <Link key={to} to={to} className="glass glass-lift block rounded-3xl p-8">
              <div className={`flex h-14 w-14 items-center justify-center rounded-2xl border border-white/90 ${iconBox}`}>
                <Icon size={26} />
              </div>
              <h2 className="mt-5 text-xl font-semibold text-slate-800">{title}</h2>
              <p className="text-sm text-slate-500">{text}</p>
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
                {points.map((p) => <li key={p}>{p}</li>)}
              </ul>
              <div className={`glass-btn ${button} mt-6 w-full`}>
                Continue <ArrowRight size={16} />
              </div>
            </Link>
          ))}
        </div>

        <p className="mt-8 text-sm text-slate-600">
          New here?{' '}
          <Link to="/signup" className="font-medium text-indigo-600 hover:underline">
            Create an account
          </Link>
        </p>
        <Link to="/" className="mt-3 flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft size={14} /> Back to home
        </Link>
      </div>
    </GlassBackground>
  )
}