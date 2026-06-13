import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { AuthUser, UserAccess, UserRole } from '../types/auth'
import {
  createUser,
  getUsers,
  resetUserPassword,
  updateUser,
} from '../api/users'

interface AdminPanelProps {
  onClose: () => void
}

interface UserFormState {
  name: string
  username: string
  password: string
  role: UserRole
  access: UserAccess
}

interface UserDraftState {
  name: string
  username: string
}

const emptyForm: UserFormState = {
  name: '',
  username: '',
  password: '',
  role: 'TECHNICIAN',
  access: 'VIEW',
}

function getUserStatusLabel(user: AuthUser) {
  return user.isActive ? 'Aktif' : 'Nonaktif'
}

function buildUserDrafts(users: AuthUser[]): Record<string, UserDraftState> {
  return users.reduce<Record<string, UserDraftState>>((drafts, user) => {
    drafts[user.id] = {
      name: user.name,
      username: user.username,
    }

    return drafts
  }, {})
}

export default function AdminPanel({ onClose }: AdminPanelProps) {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [userDrafts, setUserDrafts] = useState<Record<string, UserDraftState>>({})
  const [form, setForm] = useState<UserFormState>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [resetPasswordUserId, setResetPasswordUserId] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [showCreatePassword, setShowCreatePassword] = useState(false)
  const [showResetPassword, setShowResetPassword] = useState(false)

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      if (a.role === 'ADMIN' && b.role !== 'ADMIN') return -1
      if (a.role !== 'ADMIN' && b.role === 'ADMIN') return 1
      return a.name.localeCompare(b.name)
    })
  }, [users])

  async function loadUsers() {
    try {
      setLoading(true)
      setError('')
      const result = await getUsers()
      setUsers(result)
      setUserDrafts(buildUserDrafts(result))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengambil daftar user')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true

    async function loadInitialUsers() {
      try {
        const result = await getUsers()

        if (mounted) {
          setUsers(result)
          setUserDrafts(buildUserDrafts(result))
          setError('')
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Gagal mengambil daftar user')
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    void loadInitialUsers()

    return () => {
      mounted = false
    }
  }, [])

  function updateForm<K extends keyof UserFormState>(key: K, value: UserFormState[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === 'role' && value === 'ADMIN' ? { access: 'EDIT' as UserAccess } : {}),
    }))
  }

  function updateUserDraft(userId: string, key: keyof UserDraftState, value: string) {
    setUserDrafts((current) => ({
      ...current,
      [userId]: {
        name: current[userId]?.name ?? '',
        username: current[userId]?.username ?? '',
        [key]: value,
      },
    }))
  }

  function getDraftForUser(user: AuthUser) {
    return userDrafts[user.id] ?? {
      name: user.name,
      username: user.username,
    }
  }

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    try {
      setSaving(true)
      setError('')
      setMessage('')

      await createUser({
        ...form,
        name: form.name.trim(),
        username: form.username.trim().toLowerCase(),
      })

      setForm(emptyForm)
      setMessage('User berhasil dibuat.')
      await loadUsers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat user')
    } finally {
      setSaving(false)
    }
  }

  async function handleChangeRoleAccess(
    user: AuthUser,
    role: UserRole,
    access: UserAccess,
  ) {
    try {
      setError('')
      setMessage('')

      const finalAccess = role === 'ADMIN' ? 'EDIT' : access
      const updatedUser = await updateUser(user.id, {
        role,
        access: finalAccess,
      })

      setUsers((current) =>
        current.map((item) => (item.id === user.id ? updatedUser : item)),
      )
      setUserDrafts((current) => ({
        ...current,
        [updatedUser.id]: {
          name: updatedUser.name,
          username: updatedUser.username,
        },
      }))
      setMessage(`Akses ${updatedUser.name} berhasil diperbarui.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah akses user')
    }
  }

  async function handleSaveUserIdentity(user: AuthUser) {
    const draft = getDraftForUser(user)
    const name = draft.name.trim()
    const username = draft.username.trim().toLowerCase()

    if (!name || !username) {
      setError('Nama dan username tidak boleh kosong.')
      return
    }

    try {
      setError('')
      setMessage('')

      const updatedUser = await updateUser(user.id, {
        name,
        username,
      })

      setUsers((current) =>
        current.map((item) => (item.id === user.id ? updatedUser : item)),
      )
      setUserDrafts((current) => ({
        ...current,
        [updatedUser.id]: {
          name: updatedUser.name,
          username: updatedUser.username,
        },
      }))
      setMessage(`Data ${updatedUser.name} berhasil diperbarui.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah nama/username user')
    }
  }

  async function handleToggleActive(user: AuthUser) {
    const nextStatus = !user.isActive
    const confirmed = window.confirm(
      `${nextStatus ? 'Aktifkan kembali' : 'Nonaktifkan'} akun ${user.name}?`,
    )
    if (!confirmed) return

    try {
      setError('')
      setMessage('')
      const updatedUser = await updateUser(user.id, {
        isActive: nextStatus,
      })

      setUsers((current) =>
        current.map((item) => (item.id === user.id ? updatedUser : item)),
      )
      setUserDrafts((current) => ({
        ...current,
        [updatedUser.id]: {
          name: updatedUser.name,
          username: updatedUser.username,
        },
      }))
      setMessage(
        `Akun ${updatedUser.name} berhasil ${updatedUser.isActive ? 'diaktifkan' : 'dinonaktifkan'}.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah status user')
    }
  }

  async function handleResetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!resetPasswordUserId) {
      setError('Pilih user terlebih dahulu.')
      return
    }

    try {
      setSaving(true)
      setError('')
      setMessage('')
      await resetUserPassword(resetPasswordUserId, newPassword)
      setNewPassword('')
      setResetPasswordUserId('')
      setShowResetPassword(false)
      setMessage('Password user berhasil direset.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal reset password')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-panel-overlay">
      <div className="admin-panel-modal">
        <div className="admin-panel-header">
          <div>
            <h2>Admin Panel</h2>
            <p>Kelola akun teknisi dan sales dari satu tempat.</p>
          </div>
          <button type="button" className="admin-panel-close" onClick={onClose}>
            ×
          </button>
        </div>

        {message && <div className="admin-panel-message success">{message}</div>}
        {error && <div className="admin-panel-message error">{error}</div>}

        <div className="admin-panel-grid">
          <section className="admin-panel-section">
            <h3>Tambah Akun</h3>
            <form className="admin-user-form" onSubmit={handleCreateUser}>
              <label>
                Nama
                <input
                  value={form.name}
                  onChange={(event) => updateForm('name', event.target.value)}
                  placeholder="Contoh: Teknisi Balen"
                  required
                />
              </label>

              <label>
                Username
                <input
                  value={form.username}
                  onChange={(event) => updateForm('username', event.target.value)}
                  placeholder="contoh: teknisi_balen"
                  required
                />
              </label>

              <label>
                Password
                <div className="admin-password-field">
                  <input
                    type={showCreatePassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={(event) => updateForm('password', event.target.value)}
                    placeholder="Minimal 6 karakter"
                    required
                  />
                  <button
                    type="button"
                    className="admin-password-toggle"
                    onClick={() => setShowCreatePassword((value) => !value)}
                  >
                    {showCreatePassword ? 'Sembunyikan' : 'Lihat'}
                  </button>
                </div>
              </label>

              <div className="admin-form-row">
                <label>
                  Role
                  <select
                    value={form.role}
                    onChange={(event) =>
                      updateForm('role', event.target.value as UserRole)
                    }
                  >
                    <option value="TECHNICIAN">Teknisi</option>
                    <option value="SALES">Sales</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                </label>

                <label>
                  Akses
                  <select
                    value={form.role === 'ADMIN' ? 'EDIT' : form.access}
                    disabled={form.role === 'ADMIN'}
                    onChange={(event) =>
                      updateForm('access', event.target.value as UserAccess)
                    }
                  >
                    <option value="VIEW">View</option>
                    <option value="EDIT">Edit</option>
                  </select>
                </label>
              </div>

              <button type="submit" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Buat Akun'}
              </button>
            </form>
          </section>

          <section className="admin-panel-section">
            <h3>Reset Password</h3>
            <form className="admin-user-form" onSubmit={handleResetPassword}>
              <label>
                Pilih User
                <select
                  value={resetPasswordUserId}
                  onChange={(event) => setResetPasswordUserId(event.target.value)}
                >
                  <option value="">Pilih user</option>
                  {sortedUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name} — {user.role}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Password Baru
                <div className="admin-password-field">
                  <input
                    type={showResetPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder="Minimal 6 karakter"
                  />
                  <button
                    type="button"
                    className="admin-password-toggle"
                    onClick={() => setShowResetPassword((value) => !value)}
                  >
                    {showResetPassword ? 'Sembunyikan' : 'Lihat'}
                  </button>
                </div>
              </label>

              <button type="submit" disabled={saving}>
                Reset Password
              </button>
            </form>
          </section>
        </div>

        <section className="admin-panel-section user-list-section">
          <div className="admin-list-header">
            <h3>Daftar User</h3>
            <button type="button" onClick={loadUsers} disabled={loading}>
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="admin-empty-state">Memuat user...</div>
          ) : sortedUsers.length === 0 ? (
            <div className="admin-empty-state">Belum ada user.</div>
          ) : (
            <div className="admin-user-table-wrap">
              <table className="admin-user-table">
                <thead>
                  <tr>
                    <th>Nama</th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Akses</th>
                    <th>Status</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedUsers.map((user) => {
                    const draft = getDraftForUser(user)
                    const identityChanged =
                      draft.name.trim() !== user.name ||
                      draft.username.trim().toLowerCase() !== user.username

                    return (
                      <tr key={user.id}>
                        <td>
                          <input
                            className="admin-table-input"
                            value={draft.name}
                            onChange={(event) =>
                              updateUserDraft(user.id, 'name', event.target.value)
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="admin-table-input"
                            value={draft.username}
                            onChange={(event) =>
                              updateUserDraft(user.id, 'username', event.target.value)
                            }
                          />
                        </td>
                        <td>
                          <select
                            value={user.role}
                            onChange={(event) =>
                              handleChangeRoleAccess(
                                user,
                                event.target.value as UserRole,
                                user.access,
                              )
                            }
                          >
                            <option value="ADMIN">Admin</option>
                            <option value="TECHNICIAN">Teknisi</option>
                            <option value="SALES">Sales</option>
                          </select>
                        </td>
                        <td>
                          <select
                            value={user.role === 'ADMIN' ? 'EDIT' : user.access}
                            disabled={user.role === 'ADMIN'}
                            onChange={(event) =>
                              handleChangeRoleAccess(
                                user,
                                user.role,
                                event.target.value as UserAccess,
                              )
                            }
                          >
                            <option value="VIEW">View</option>
                            <option value="EDIT">Edit</option>
                          </select>
                        </td>
                        <td>
                          <span
                            className={
                              user.isActive ? 'user-status active' : 'user-status inactive'
                            }
                          >
                            {getUserStatusLabel(user)}
                          </span>
                        </td>
                        <td>
                          <div className="admin-user-actions">
                            <button
                              type="button"
                              disabled={!identityChanged}
                              onClick={() => handleSaveUserIdentity(user)}
                            >
                              Simpan
                            </button>
                            <button
                              type="button"
                              className={user.isActive ? 'danger' : 'success'}
                              disabled={user.role === 'ADMIN'}
                              onClick={() => handleToggleActive(user)}
                            >
                              {user.isActive ? 'Nonaktifkan' : 'Aktifkan'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
