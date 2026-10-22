import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LogOut, type LucideIcon } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import GlassBackground from './GlassBackground'
import Logo from './Logo'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

const accents = {
  indigo: 'border-indigo-200/90 bg-indigo-400/25 text-indigo-800',
  emerald: 'border-emerald-200/90 bg-emerald-400/25 text-emerald-800',
}

interface Props {
  title: string
  accent: keyof typeof accents
  links: NavItem[]
}

export default function PortalLayout({ title, accent, links }: Props) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <GlassBackground>
      <div className="glass-portal flex h-screen gap-4 p-4">
        <aside className="glass flex w-64 shrink-0 flex-col rounded-3xl">
          <div className="px-6 py-6">
            <Logo size={34} />
            <div className="mt-2 text-xs font-medium text-slate-500">{title}</div>
          </div>

          <nav className="flex flex-1 flex-col gap-1.5 px-3">
            {links.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
                    isActive
                      ? `${accents[accent]} shadow-sm`
                      : 'border-transparent text-slate-600 hover:bg-white/50'
                  }`
                }
              >
                <Icon size={18} />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="border-t border-white/60 p-4">
            <p className="text-sm font-medium text-slate-800">{user?.name}</p>
            <p className="text-xs text-slate-500">{user?.email}</p>
            <button onClick={handleLogout} className="glass-btn glass-btn-sm mt-3 w-full">
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto rounded-3xl p-4">
          <Outlet />
        </main>
      </div>
    </GlassBackground>
  )
}