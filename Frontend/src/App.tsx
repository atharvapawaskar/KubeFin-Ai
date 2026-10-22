import { Routes, Route, Navigate } from 'react-router-dom'
import {
  LayoutDashboard, DollarSign, Wallet, ShieldAlert, Scale,
  Server, KeyRound, Activity, ScanEye,
} from 'lucide-react'
import ProtectedRoute from './auth/ProtectedRoute'
import PortalLayout, { type NavItem } from './components/PortalLayout'
import Landing from './pages/Landing'
import Login from './pages/Login'
import RoleLogin from './pages/RoleLogin'
import Signup from './pages/Signup'
import CommandCenter from './pages/finops/CommandCenter'
import ExecutiveSpend from './pages/finops/ExecutiveSpend'
import TeamBudgets from './pages/finops/TeamBudgets'
import CapPolicies from './pages/finops/CapPolicies'
import ProviderComparison from './pages/finops/ProviderComparison'
import EngineerHome from './pages/engineering/EngineerHome'
import ServiceAccounts from './pages/engineering/ServiceAccounts'
import ApiKeys from './pages/engineering/ApiKeys'
import GatewayHealth from './pages/engineering/GatewayHealth'
import DlpLogs from './pages/engineering/DlpLogs'

const finopsLinks: NavItem[] = [
  { to: '/finops', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/finops/spend', label: 'Executive Spend', icon: DollarSign },
  { to: '/finops/budgets', label: 'Team Budgets', icon: Wallet },
  { to: '/finops/policies', label: 'Cap Policies', icon: ShieldAlert },
  { to: '/finops/providers', label: 'Provider Costs', icon: Scale },
]

const engineeringLinks: NavItem[] = [
  { to: '/engineering', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/engineering/accounts', label: 'Service Accounts', icon: Server },
  { to: '/engineering/keys', label: 'API Keys', icon: KeyRound },
  { to: '/engineering/gateway', label: 'Gateway Health', icon: Activity },
  { to: '/engineering/dlp', label: 'PII / DLP Logs', icon: ScanEye },
]

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/login/finops" element={<RoleLogin role="finops" />} />
      <Route path="/login/engineer" element={<RoleLogin role="engineer" />} />
      <Route path="/signup" element={<Signup />} />

      <Route element={<ProtectedRoute role="finops" />}>
        <Route
          path="/finops"
          element={<PortalLayout title="FinOps Portal" accent="indigo" links={finopsLinks} />}
        >
          <Route index element={<CommandCenter />} />
          <Route path="spend" element={<ExecutiveSpend />} />
          <Route path="budgets" element={<TeamBudgets />} />
          <Route path="policies" element={<CapPolicies />} />
          <Route path="providers" element={<ProviderComparison />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute role="engineer" />}>
        <Route
          path="/engineering"
          element={<PortalLayout title="Engineering Portal" accent="emerald" links={engineeringLinks} />}
        >
          <Route index element={<EngineerHome />} />
          <Route path="accounts" element={<ServiceAccounts />} />
          <Route path="keys" element={<ApiKeys />} />
          <Route path="gateway" element={<GatewayHealth />} />
          <Route path="dlp" element={<DlpLogs />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}