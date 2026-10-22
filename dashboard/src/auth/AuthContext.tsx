import { createContext, useContext, useState, type ReactNode } from 'react'
import { login as loginRequest, register as registerRequest } from '../api/endpoints'
import type { User, Role } from '../types/api'

interface AuthState {
  user: User | null
  login: (email: string, password: string, expectedRole?: Role) => Promise<void>
  signup: (name: string, email: string, password: string, role: Role) => Promise<void>
  logout: () => void
}

const STORAGE_KEY = 'kubefin_user'
const AuthContext = createContext<AuthState | null>(null)

function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(loadUser)

  function persist(u: User) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(u))
    } catch {
      /* ignore */
    }
    setUser(u)
  }

  async function login(email: string, password: string, expectedRole?: Role) {
    const u = await loginRequest(email, password)
    if (expectedRole && u.role !== expectedRole) {
      throw new Error(
        u.role === 'finops'
          ? 'This is a FinOps account. Please use the FinOps login.'
          : 'This is an Engineer account. Please use the Engineer login.',
      )
    }
    persist(u)
  }

  async function signup(name: string, email: string, password: string, role: Role) {
    const u = await registerRequest(name, email, password, role)
    persist(u)
  }

  function logout() {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
    setUser(null)
  }

  return <AuthContext.Provider value={{ user, login, signup, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}