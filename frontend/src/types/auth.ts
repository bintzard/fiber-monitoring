export type UserRole = 'ADMIN' | 'TECHNICIAN' | 'SALES'
export type UserAccess = 'EDIT' | 'VIEW'

export interface AuthUser {
  id: string
  name: string
  username: string
  role: UserRole
  access: UserAccess
  isActive: boolean
}

export interface LoginResponse {
  token: string
  user: AuthUser
}