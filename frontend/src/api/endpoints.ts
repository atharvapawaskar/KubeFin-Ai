import type {
  User, Role, SpendPoint, TokenBilling, TeamBudget, CapPolicy, ProviderCost,
  ServiceAccountStat, ApiKey, ProviderHealth, DlpLog,
} from '../types/api'
import {
  mockUsers, mockSpendSeries, mockTokenBilling, mockTeamBudgets, mockCapPolicies,
  mockProviderCosts, mockServiceAccounts, mockApiKeys, mockProviderHealth, mockDlpLogs,
} from './mock'

const delay = (ms = 400) => new Promise((r) => setTimeout(r, ms))

// Later: replace each body with an axios call to the control plane API
// and send the auth token. The return types stay the same.

// ---- Mock accounts (demo only: accounts live in this browser's localStorage) ----
interface StoredUser {
  name: string
  email: string
  password: string
  role: Role
}
const REGISTERED_KEY = 'kubefin_registered_users'

function loadRegistered(): StoredUser[] {
  try {
    const raw = localStorage.getItem(REGISTERED_KEY)
    return raw ? (JSON.parse(raw) as StoredUser[]) : []
  } catch {
    return []
  }
}

export async function login(email: string, password: string): Promise<User> {
  await delay()
  const all: StoredUser[] = [...mockUsers, ...loadRegistered()]
  const found = all.find(
    (u) => u.email.toLowerCase() === email.trim().toLowerCase() && u.password === password,
  )
  if (!found) throw new Error('Invalid email or password')
  return { name: found.name, email: found.email, role: found.role }
}

export async function register(name: string, email: string, password: string, role: Role): Promise<User> {
  await delay()
  const clean = email.trim().toLowerCase()
  const registered = loadRegistered()
  if ([...mockUsers, ...registered].some((u) => u.email.toLowerCase() === clean)) {
    throw new Error('An account with this email already exists')
  }
  registered.push({ name: name.trim(), email: clean, password, role })
  try {
    localStorage.setItem(REGISTERED_KEY, JSON.stringify(registered))
  } catch {
    throw new Error('Could not save the account in this browser')
  }
  return { name: name.trim(), email: clean, role }
}

// ---- Dashboard data ----
export async function getSpendSeries(): Promise<SpendPoint[]> { await delay(); return mockSpendSeries() }
export async function getTokenBilling(): Promise<TokenBilling[]> { await delay(); return mockTokenBilling }
export async function getTeamBudgets(): Promise<TeamBudget[]> { await delay(); return mockTeamBudgets }
export async function getCapPolicies(): Promise<CapPolicy[]> { await delay(); return mockCapPolicies }
export async function getProviderCosts(): Promise<ProviderCost[]> { await delay(); return mockProviderCosts }
export async function getServiceAccounts(): Promise<ServiceAccountStat[]> { await delay(); return mockServiceAccounts }
export async function getApiKeys(): Promise<ApiKey[]> { await delay(); return mockApiKeys }
export async function getProviderHealth(): Promise<ProviderHealth[]> { await delay(); return mockProviderHealth }
export async function getDlpLogs(): Promise<DlpLog[]> { await delay(); return mockDlpLogs }