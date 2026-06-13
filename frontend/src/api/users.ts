import { getAuthToken } from './auth'
import type { AuthUser, UserAccess, UserRole } from '../types/auth'

const API_BASE_URL = import.meta.env.VITE_API_URL || window.location.origin

function getAuthorizedJsonHeaders() {
  const token = getAuthToken()

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function getAuthorizedHeaders() {
  const token = getAuthToken()

  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function readJsonResponse(response: Response) {
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.message || 'Request gagal')
  }

  return data
}

export interface CreateUserPayload {
  name: string
  username: string
  password: string
  role: UserRole
  access: UserAccess
}

export interface UpdateUserPayload {
  name?: string
  username?: string
  role?: UserRole
  access?: UserAccess
  isActive?: boolean
}

export async function getUsers(): Promise<AuthUser[]> {
  const response = await fetch(`${API_BASE_URL}/api/users`, {
    headers: getAuthorizedHeaders(),
  })

  const data = await readJsonResponse(response)
  return data.users || []
}

export async function createUser(payload: CreateUserPayload): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL}/api/users`, {
    method: 'POST',
    headers: getAuthorizedJsonHeaders(),
    body: JSON.stringify(payload),
  })

  const data = await readJsonResponse(response)
  return data.user
}

export async function updateUser(
  userId: string,
  payload: UpdateUserPayload,
): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL}/api/users/${userId}`, {
    method: 'PATCH',
    headers: getAuthorizedJsonHeaders(),
    body: JSON.stringify(payload),
  })

  const data = await readJsonResponse(response)
  return data.user
}

export async function resetUserPassword(
  userId: string,
  password: string,
): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL}/api/users/${userId}/password`, {
    method: 'PATCH',
    headers: getAuthorizedJsonHeaders(),
    body: JSON.stringify({ password }),
  })

  const data = await readJsonResponse(response)
  return data.user
}

export async function deactivateUser(userId: string): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL}/api/users/${userId}/deactivate`, {
    method: 'PATCH',
    headers: getAuthorizedJsonHeaders(),
  })

  const data = await readJsonResponse(response)
  return data.user
}
