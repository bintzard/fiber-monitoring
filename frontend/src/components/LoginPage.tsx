import { useState } from 'react'
import type { FormEvent } from 'react'
import { login, setAuthToken } from '../api/auth'
import type { AuthUser } from '../types/auth'

interface LoginPageProps {
  onLoginSuccess: (user: AuthUser) => void
}

export default function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin123')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()

    try {
      setLoading(true)
      setError('')

      const result = await login(username, password)

      setAuthToken(result.token)
      onLoginSuccess(result.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login gagal')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="login-logo">🌐</div>
          <h1>Fiber Monitoring</h1>
          <p>Login untuk mengakses dashboard jaringan</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Masukkan username"
              autoComplete="username"
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Masukkan password"
              autoComplete="current-password"
            />
          </label>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" disabled={loading}>
            {loading ? 'Memproses...' : 'Login'}
          </button>
        </form>

        <div className="login-footer">
          Akun Teknisi dan Sales dibuat oleh Admin.
        </div>
      </div>
    </div>
  )
}