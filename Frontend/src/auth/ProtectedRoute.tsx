import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { homeFor } from './roles'
import type { Role } from '../types/api'

export default function ProtectedRoute({ role }: { role: Role }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== role) return <Navigate to={homeFor(user.role)} replace />
  return <Outlet />
}