import type { Role } from '../types/api'

export const homeFor = (role: Role) => (role === 'finops' ? '/finops' : '/engineering')