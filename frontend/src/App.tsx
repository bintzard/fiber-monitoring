import { useEffect, useState } from 'react'
import NetworkMap from './components/NetworkMap'
import LoginPage from './components/LoginPage'
import { getMe, removeAuthToken } from './api/auth'
import type { AuthUser } from './types/auth'
import './style.css'

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)

  useEffect(() => {
    async function checkSession() {
      try {
        const me = await getMe()
        setUser(me)
      } catch {
        removeAuthToken()
        setUser(null)
      } finally {
        setCheckingSession(false)
      }
    }

    checkSession()
  }, [])

  function handleLogout() {
    removeAuthToken()
    setUser(null)
  }

  if (checkingSession) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p>Mengecek sesi login...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <LoginPage onLoginSuccess={setUser} />
  }

  return <NetworkMap currentUser={user} onLogout={handleLogout} />
}