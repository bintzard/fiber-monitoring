import type { AuthUser, LoginResponse } from '../types/auth'

const API_BASE_URL = import.meta.env.VITE_API_URL || window.location.origin

export function getAuthToken() {
  return localStorage.getItem('auth_token')
}

export function setAuthToken(token: string) {
  localStorage.setItem('auth_token', token)
}

export function removeAuthToken() {
  localStorage.removeItem('auth_token')
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.message || 'Login gagal')
  }

  return data
}

export async function getMe(): Promise<AuthUser> {
  const token = getAuthToken()

  if (!token) {
    throw new Error('Token tidak ditemukan')
  }

  const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.message || 'Sesi login tidak valid')
  }

  return data.user
}